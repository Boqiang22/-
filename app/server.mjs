/**
 * server.mjs —— 零依赖 HTTP 服务
 *
 * 本地启动：node app/server.mjs  （默认 http://127.0.0.1:7788）
 * 云端部署：平台注入 PORT / HOST 环境变量后自动监听 0.0.0.0
 *
 * 公网部署时自动启用访问保护（见 lib/guard.mjs）：
 *   每分钟 6 次/每 IP 硬限流；每日 40 次/每 IP、800 次全局软限额，超限降级到离线抽取。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { loadConfig } from './lib/config.mjs';
import { loadKnowledgeBase } from './lib/kb.mjs';
import { buildIndex, search } from './lib/retriever.mjs';
import { loadPrompts, answer as generateAnswer, detectIntent } from './lib/generator.mjs';
import { Store } from './lib/store.mjs';
import { AccessGuard, clientIp } from './lib/guard.mjs';

const cfg = loadConfig();
const store = new Store(cfg.runtimeDir);
const guard = new AccessGuard({
  perMinute: cfg.limits.perMinute,
  perDayPerIp: cfg.limits.perDayPerIp,
  globalPerDay: cfg.limits.globalPerDay,
  llmEnabled: cfg.llm.active,
});

let kb = loadKnowledgeBase(cfg.kbDir);
let index = buildIndex(kb.entries);
let prompts = loadPrompts(cfg.promptsDir, cfg.promptVersion);

console.log('');
console.log('  ┌──────────────────────────────────────────────┐');
console.log('  │   校园通 · CampusQA  智能问答系统            │');
console.log('  └──────────────────────────────────────────────┘');
console.log(`  知识库：${kb.entries.length} 条` + (kb.problems.length ? `（${kb.problems.length} 条校验告警）` : ''));
console.log(`  生成模式：${cfg.llm.active ? `大模型 ${cfg.llm.model}` : '离线抽取式（未配置 API Key）'}`);
console.log(`  提示词版本：${prompts.version}`);
console.log(`  访问保护：每分钟 ${cfg.limits.perMinute} 次/IP，每日 ${cfg.limits.perDayPerIp} 次/IP、${cfg.limits.globalPerDay} 次全局`);
for (const p of kb.problems) console.warn(`  ! 知识库告警：${p}`);

function reload() {
  kb = loadKnowledgeBase(cfg.kbDir);
  index = buildIndex(kb.entries);
  prompts = loadPrompts(cfg.promptsDir, cfg.promptVersion);
  return { entries: kb.entries.length, problems: kb.problems, promptVersion: prompts.version };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 96 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(cfg.publicDir, rel || 'index.html');
  if (!full.startsWith(path.resolve(cfg.publicDir))) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        uptimeSec: Math.round(process.uptime()),
        kbEntries: kb.entries.length,
        mode: cfg.llm.active ? 'llm' : 'extractive',
        promptVersion: prompts.version,
      });
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return sendJson(res, 200, {
        mode: cfg.llm.active ? 'llm' : 'extractive',
        model: cfg.llm.active ? cfg.llm.model : null,
        promptVersion: prompts.version,
        kbEntries: kb.entries.length,
        campusName: cfg.campusName || '本校',
        demoBanner: cfg.demoBanner,
        demoCount: kb.entries.length,
        suggestions: ['新生报到要带什么材料？', '宿舍灯坏了怎么报修？', '校园卡丢了怎么办？', '什么时候可以转专业？'],
      });
    }

    if (pathname === '/api/kb' && req.method === 'GET') {
      return sendJson(
        res,
        200,
        kb.entries.map((e) => ({
          id: e.id,
          title: e.title,
          tags: e.tags,
          dept: e.dept,
          updated: e.updated,
          source: e.source,
          sections: e.sections.map((s) => s.heading).filter(Boolean),
          chars: e.chars,
        })),
      );
    }

    const kbMatch = pathname.match(/^\/api\/kb\/([\w-]+)$/);
    if (kbMatch && req.method === 'GET') {
      const e = kb.entries.find((x) => x.id === kbMatch[1]);
      if (!e) return sendJson(res, 404, { error: '条目不存在' });
      return sendJson(res, 200, { ...e, sentences: undefined });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const question = String(body.question || '').trim();
      if (!question) return sendJson(res, 400, { error: '问题不能为空' });
      if (question.length > 500) return sendJson(res, 400, { error: '问题过长，请精简到 500 字以内' });

      // ── 访问保护 ──
      // 硬限流：每分钟次数超了直接 429，防止单点狂刷接口
      const ip = clientIp(req);
      const gate = guard.checkRate(ip);
      if (!gate.ok) {
        res.setHeader('Retry-After', String(gate.retryAfterSec));
        return sendJson(res, 429, {
          error: `请求有点快，请 ${gate.retryAfterSec} 秒后再试`,
          retryAfterSec: gate.retryAfterSec,
        });
      }

      // 软限额：大模型额度用完 → 降级到离线抽取，服务不中断、API 成本归零
      const quota = cfg.llm.active ? guard.takeLlmQuota(ip) : { ok: false, reason: 'disabled' };
      const useLlm = cfg.llm.active && quota.ok;
      const effCfg = useLlm ? cfg : { ...cfg, llm: { ...cfg.llm, active: false } };

      const sessionId = String(body.sessionId || 'anon-' + crypto.randomUUID());
      const intent = detectIntent(question);
      const retrieved = search(index, question, { topK: cfg.topK, intent });
      const history = store.getHistory(sessionId);

      const result = await generateAnswer({
        question,
        retrieved,
        index,
        history,
        prompts,
        cfg: effCfg,
        store,
        sessionId,
      });

      // 调用了大模型但失败并降级 → 退还额度，不让用户为服务端问题买单
      if (useLlm && result.mode === 'extractive' && result.meta?.degraded) {
        guard.refundLlmQuota(ip);
      }

      store.pushHistory(sessionId, 'user', question);
      store.pushHistory(sessionId, 'assistant', result.text);

      const questionId = crypto.randomUUID();

      return sendJson(res, 200, {
        questionId,
        sessionId,
        answer: result.text,
        mode: result.mode,
        confidence: result.confidence,
        answerable: result.answerable,
        citations: result.citations,
        followups: result.followups,
        meta: result.meta,
        // 告诉前端：本次是否真的用了大模型额度，以及剩余次数
        quota: {
          llmUsed: useLlm,
          remaining: quota.ok ? quota.ipRemaining : 0,
          reason: quota.ok ? null : quota.reason,
        },
        retrieved: retrieved.slice(0, 3).map((r) => ({
          id: r.entry.id,
          title: r.entry.title,
          score: +r.score.toFixed(2),
          coverage: +r.coverage.toFixed(2),
        })),
      });
    }

    if (pathname === '/api/feedback' && req.method === 'POST') {
      const body = await readBody(req);
      const useful = body.useful === true;
      await store.append('feedback', {
        sessionId: String(body.sessionId || ''),
        questionId: String(body.questionId || ''),
        question: String(body.question || '').slice(0, 300),
        useful,
        note: String(body.note || '').slice(0, 500),
        mode: String(body.mode || ''),
      });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      return sendJson(res, 200, {
        ...store.stats(),
        kbEntries: kb.entries.length,
        kbProblems: kb.problems,
        promptVersion: prompts.version,
        mode: cfg.llm.active ? 'llm' : 'extractive',
      });
    }

    if (pathname === '/api/admin/reload' && req.method === 'POST') {
      const info = reload();
      return sendJson(res, 200, { ok: true, ...info });
    }

    if (pathname === '/admin') {
      return serveStatic(res, '/admin.html');
    }

    if (req.method === 'GET') {
      return serveStatic(res, pathname === '/' ? '/index.html' : pathname);
    }

    return sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('[server]', err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务器内部错误' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${cfg.port} 已被占用。请关闭占用程序，或用环境变量换端口：`);
    console.error(`    $env:QA_PORT=7799; node server.mjs\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(cfg.port, cfg.host, () => {
  const shown = cfg.host === '0.0.0.0' ? '本机所有网卡（0.0.0.0）' : cfg.host;
  console.log(`  监听：${shown}:${cfg.port}`);
  console.log(`  本地访问：http://127.0.0.1:${cfg.port}`);
  console.log(`  管理面板：http://127.0.0.1:${cfg.port}/admin`);
  if (cfg.host === '0.0.0.0') {
    console.log('  云端模式：请使用平台分配的域名访问');
  }
  console.log('  按 Ctrl+C 停止\n');
});
