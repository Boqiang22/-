/**
 * store.mjs —— 运行时事件持久化（JSONL 追加写）
 *
 * 三类事件：会话问答、用户反馈、未答问题（badcase 池）。
 * 选 JSONL 而非数据库：零依赖、可直接用 Excel/脚本分析、损坏风险低（追加写）。
 */

import fs from 'node:fs';
import path from 'node:path';

const FILES = {
  chat: 'chat.jsonl',
  feedback: 'feedback.jsonl',
  unanswered: 'unanswered.jsonl',
};

export class Store {
  constructor(runtimeDir) {
    this.dir = runtimeDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.queue = Promise.resolve();
    // 进程内会话缓存（多轮上下文），仅存内存，重启即清空
    this.sessions = new Map();
    this.maxHistory = 6;
  }

  file(name) {
    return path.join(this.dir, FILES[name] || name);
  }

  append(name, record) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    this.queue = this.queue
      .then(() => fs.promises.appendFile(this.file(name), line, 'utf8'))
      .catch((err) => console.error(`[store] 写入失败 ${name}: ${err.message}`));
    return this.queue;
  }

  readAll(name, limit = 500) {
    const f = this.file(name);
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    const slice = lines.slice(-limit);
    return slice
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // ---- 会话上下文 ----
  getHistory(sessionId) {
    return this.sessions.get(sessionId) || [];
  }

  pushHistory(sessionId, role, content) {
    const list = this.sessions.get(sessionId) || [];
    list.push({ role, content });
    while (list.length > this.maxHistory * 2) list.shift();
    this.sessions.set(sessionId, list);
  }

  resetSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  // ---- 统计 ----
  stats() {
    const chat = this.readAll('chat', 5000);
    const fb = this.readAll('feedback', 5000);
    const un = this.readAll('unanswered', 5000);
    const byMode = {};
    for (const c of chat) byMode[c.mode] = (byMode[c.mode] || 0) + 1;
    const useful = fb.filter((f) => f.useful === true).length;
    const totalFb = fb.length;
    const lowConf = chat.filter((c) => c.confidence === 'low').length;

    const trend = new Map();
    for (const c of chat) {
      const day = String(c.ts || '').slice(0, 10);
      if (!day) continue;
      trend.set(day, (trend.get(day) || 0) + 1);
    }

    return {
      questions: chat.length,
      sessions: new Set(chat.map((c) => c.sessionId)).size,
      byMode,
      feedback: { total: totalFb, useful, usefulRate: totalFb ? +(useful / totalFb).toFixed(3) : null },
      lowConfidenceRate: chat.length ? +(lowConf / chat.length).toFixed(3) : null,
      unanswered: un.length,
      topUnanswered: topGroup(un.map((u) => u.question), 8),
      trend: [...trend.entries()].sort().map(([day, n]) => ({ day, n })),
    };
  }
}

function topGroup(list, n) {
  const m = new Map();
  for (const q of list) {
    const k = String(q || '').trim();
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([question, count]) => ({ question, count }));
}
