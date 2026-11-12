/**
 * guard.mjs —— 公网部署的访问保护
 *
 * 设计原则：降级优先于拒绝。
 *   · 每分钟频率超限 → 硬拒绝（429），防单点刷接口
 *   · 每日额度用完   → 软降级（切回离线抽取），服务不中断、API 成本归零
 *
 * 为什么不用口令：演示场景下口令会增加摩擦；靠限流+日限额足以把最坏成本锁死。
 *
 * 数据结构全部在内存（单实例足够）。PaaS 重启后计数清零，这是可接受的：
 * 计数是为了"防止余额被刷爆"，不是财务记录。
 */

const DAY_MS = 86400000;

function dayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class AccessGuard {
  constructor({
    perMinute = 6,
    perDayPerIp = 40,
    globalPerDay = 800,
    llmEnabled = true,
  } = {}) {
    this.perMinute = perMinute;
    this.perDayPerIp = perDayPerIp;
    this.globalPerDay = globalPerDay;
    this.llmEnabled = llmEnabled;

    this.minute = new Map(); // ip -> number[] 时间戳
    this.perIp = new Map(); // ip -> { day, n }
    this.global = { day: dayKey(), n: 0 };
    this.lastSweep = Date.now();
  }

  /** 每 IP 每分钟的硬限流。所有 /api/chat 请求都要过这一关 */
  checkRate(ip) {
    const now = Date.now();
    const arr = (this.minute.get(ip) || []).filter((t) => now - t < 60000);

    if (arr.length >= this.perMinute) {
      const waitMs = 60000 - (now - arr[0]);
      return { ok: false, reason: 'rate', retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    arr.push(now);
    this.minute.set(ip, arr);
    this.maybeSweep(now);
    return { ok: true };
  }

  /**
   * 是否还有"调用大模型"的额度。
   * 返回 { ok: false } 时调用方应降级到离线抽取，而不是报错。
   */
  takeLlmQuota(ip) {
    if (!this.llmEnabled) return { ok: false, reason: 'disabled' };

    const day = dayKey();
    if (this.global.day !== day) this.global = { day, n: 0 };

    if (this.global.n >= this.globalPerDay) {
      return { ok: false, reason: 'global', limit: this.globalPerDay };
    }

    const rec = this.perIp.get(ip);
    const ipCount = rec && rec.day === day ? rec.n : 0;

    if (ipCount >= this.perDayPerIp) {
      return { ok: false, reason: 'ip', limit: this.perDayPerIp };
    }

    this.perIp.set(ip, { day, n: ipCount + 1 });
    this.global.n += 1;

    return {
      ok: true,
      ipRemaining: this.perDayPerIp - ipCount - 1,
      globalRemaining: this.globalPerDay - this.global.n,
    };
  }

  /**
   * 退还一次额度。用于"已经扣了额度、但大模型调用失败并降级"的情况——
   * 这种失败是服务端或配置问题，不该让用户损失次数。
   */
  refundLlmQuota(ip) {
    const day = dayKey();
    const rec = this.perIp.get(ip);
    if (rec && rec.day === day && rec.n > 0) rec.n -= 1;
    if (this.global.day === day && this.global.n > 0) this.global.n -= 1;
  }

  /** 每 10 分钟清理一次过期的 IP 记录，防止内存无限增长 */
  maybeSweep(now) {
    if (now - this.lastSweep < 600000) return;
    this.lastSweep = now;
    for (const [ip, arr] of this.minute) {
      if (!arr.some((t) => now - t < 60000)) this.minute.delete(ip);
    }
    const day = dayKey(now);
    for (const [ip, rec] of this.perIp) {
      if (rec.day !== day) this.perIp.delete(ip);
    }
  }

  stats() {
    const day = dayKey();
    if (this.global.day !== day) return { day, used: 0, limit: this.globalPerDay };
    return { day, used: this.global.n, limit: this.globalPerDay };
  }
}

/** 取真实客户端 IP：PaaS 通常在 x-forwarded-for 第一段 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}
