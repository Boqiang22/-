/* 校园通 CampusQA —— 前端逻辑（原生 ES Module，无框架） */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  sessionId: crypto.randomUUID(),
  config: null,
  kb: [],
  kbFilter: '',
  busy: false,
  messageSeq: 0,
};

/* ---------------- 工具 ---------------- */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg, ms = 2400) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** 极简 Markdown 渲染：段落 / 无序列表 / 有序列表 / 粗体 / [n] 角标 */
function mdLite(src) {
  const lines = escapeHtml(src).split(/\n/);
  const out = [];
  let list = null;
  const flush = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d{1,2})\]/g, '<sup class="cite" data-n="$1" role="button" tabindex="0">$1</sup>');

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*(\d+)[.)、]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') {
        flush();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    if (ol) {
      if (list !== 'ol') {
        flush();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    flush();
    if (/^参考[：:]/.test(line)) out.push(`<div class="ref-line">${inline(line)}</div>`);
    else if (/^#{1,4}\s+/.test(line)) out.push(`<p><strong>${inline(line.replace(/^#+\s+/, ''))}</strong></p>`);
    else out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

const MODE_LABEL = {
  llm: '大模型生成',
  extractive: '资料抽取 · 离线',
  fallback: '未找到依据',
  blocked: '安全拦截',
};
const CONF_LABEL = { high: '依据充分', medium: '依据一般', low: '依据较弱' };

/* ---------------- 初始化 ---------------- */

async function boot() {
  bindShell();
  await Promise.all([loadConfig(), loadKb()]);
}

function bindShell() {
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    send($('#input').value);
  });

  const input = $('#input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    $('#charCount').textContent = input.value.length ? `${input.value.length} / 500` : '';
    $('#send').disabled = state.busy || !input.value.trim();
  });

  $('#kbFilter').addEventListener('input', (e) => {
    state.kbFilter = e.target.value.trim().toLowerCase();
    renderKbList();
  });

  $('#btnNewChat').addEventListener('click', newChat);
  $('#bannerX').addEventListener('click', () => {
    $('#banner').hidden = true;
  });

  // 侧栏（移动端）
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const closeSidebar = () => {
    sidebar.classList.remove('open');
    scrim.classList.remove('show');
  };
  $('#sidebarOpen')?.addEventListener('click', () => {
    sidebar.classList.add('open');
    scrim.classList.add('show');
  });
  $('#sidebarClose')?.addEventListener('click', closeSidebar);
  scrim.addEventListener('click', closeSidebar);

  // 引用角标 / 卡片点击 → 打开原文
  $('#chat').addEventListener('click', (e) => {
    const cite = e.target.closest('.cite, .cite-card');
    if (cite) {
      const id = cite.dataset.id || cite.closest('[data-id]')?.dataset.id;
      if (id) return openDrawer(id);
    }
    const fu = e.target.closest('.followup');
    if (fu) return send(fu.dataset.q || fu.textContent);
  });

  $('#chat').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('cite')) {
      e.preventDefault();
      const id = e.target.closest('[data-id]')?.dataset.id;
      if (id) openDrawer(id);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;

    const active = cfg.mode === 'llm';
    $('#modeDot').className = 'dot ' + (active ? 'dot--llm' : 'dot--offline');
    $('#modeTitle').textContent = active ? `大模型：${cfg.model}` : '离线抽取模式';
    $('#modeDesc').textContent = active
      ? `提示词 ${cfg.promptVersion} · 回答由模型组织，事实来自资料`
      : '未配置 API Key，回答直接从资料中抽取原句，不会编造';

    $('#pillKb').textContent = `${cfg.kbEntries} 条资料`;
    $('#pillMode').textContent = active ? '模型在线' : '离线模式';

    if (cfg.demoBanner) {
      $('#banner').hidden = false;
      $('#bannerText').textContent = `当前知识库为课程演示用示例（${cfg.demoCount} 条），金额与时间不代表任何真实学校的正式规定。`;
    }

    renderChips(cfg.suggestions || []);
  } catch (err) {
    $('#modeTitle').textContent = '服务未连接';
    $('#modeDesc').textContent = err.message;
    toast('无法连接后端服务，请确认 node server.mjs 正在运行');
  }
}

async function loadKb() {
  try {
    state.kb = await api('/api/kb');
    renderKbList();
  } catch {
    /* 侧栏失败不阻塞主流程 */
  }
}

function renderChips(list) {
  const box = $('#chips');
  box.innerHTML = '';
  for (const q of list) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = q;
    b.addEventListener('click', () => send(q));
    box.append(b);
  }
}

function renderKbList() {
  const box = $('#kbList');
  const kw = state.kbFilter;
  const items = state.kb.filter(
    (e) => !kw || e.title.toLowerCase().includes(kw) || e.tags.some((t) => t.toLowerCase().includes(kw)),
  );
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<div class="kb-empty">没有匹配的条目</div>';
    return;
  }
  for (const e of items) {
    const b = document.createElement('button');
    b.className = 'kb-item';
    b.type = 'button';
    b.dataset.id = e.id;
    b.innerHTML = `<span class="kb-item__title">${escapeHtml(e.title)}</span><span class="kb-item__meta">${escapeHtml(
      e.dept || '未标注部门',
    )}</span>`;
    b.addEventListener('click', () => openDrawer(e.id));
    box.append(b);
  }
}

function newChat() {
  state.sessionId = crypto.randomUUID();
  state.messageSeq = 0;
  $('#chat').innerHTML = '';
  $('#chat').append(buildEmptyState());
  renderChips(state.config?.suggestions || []);
  $('#input').value = '';
  $('#charCount').textContent = '';
  $('#send').disabled = true;
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('show');
}

function buildEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.id = 'empty';
  wrap.innerHTML = `
    <img src="/assets/logo.svg" alt="" class="empty__art" />
    <h2>有什么校园事务想问？</h2>
    <p>报到、宿舍、选课、成绩、奖助学金、图书馆、网络、请假、就业……资料里写了的，我给答案并标出处；资料里没写的，我直接说没有。</p>
    <div class="chips" id="chips"></div>`;
  return wrap;
}

/* ---------------- 对话 ---------------- */

async function send(raw) {
  const q = String(raw || '').trim();
  if (!q || state.busy) return;
  if (q.length > 500) return toast('问题请控制在 500 字以内');

  state.busy = true;
  $('#send').disabled = true;
  $('#empty')?.remove();

  appendUser(q);
  $('#input').value = '';
  $('#input').style.height = 'auto';
  $('#charCount').textContent = '';

  const typing = appendTyping();

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: { sessionId: state.sessionId, question: q },
    });
    typing.remove();
    appendBot(res, q);
  } catch (err) {
    typing.remove();
    appendBot(
      {
        answer: `**服务出错了**\n\n${err.message}\n\n请稍后重试，或直接联系辅导员/一站式服务大厅。`,
        mode: 'fallback',
        confidence: 'low',
        citations: [],
        followups: [],
        meta: {},
      },
      q,
    );
  } finally {
    state.busy = false;
    $('#send').disabled = !$('#input').value.trim();
    $('#input').focus();
    scrollBottom();
  }
}

function appendUser(text) {
  const el = document.createElement('div');
  el.className = 'msg msg--user';
  el.innerHTML = `<div class="msg__avatar">我</div><div class="msg__body"><div class="bubble"><p>${escapeHtml(
    text,
  )}</p></div></div>`;
  $('#chat').append(el);
  scrollBottom();
}

function appendTyping() {
  const el = document.createElement('div');
  el.className = 'msg msg--bot';
  el.dataset.typing = '1';
  el.innerHTML = `<div class="msg__avatar">答</div><div class="msg__body"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
  $('#chat').append(el);
  scrollBottom();
  return el;
}

function appendBot(res, question) {
  const id = ++state.messageSeq;
  const el = document.createElement('div');
  el.className = 'msg msg--bot';

  const cites = (res.citations || [])
    .map(
      (c) =>
        `<div class="cite-card" data-id="${escapeHtml(c.id)}" data-weak="${c.weak ? 1 : 0}" role="button" tabindex="0">
           <span class="cite-card__n">[${c.n}]</span>
           <span class="cite-card__main">
             <span class="cite-card__title">${escapeHtml(c.title)}</span>
             <span class="cite-card__sub">${escapeHtml(c.dept || '')}${c.section ? ' · ' + escapeHtml(c.section) : ''}</span>
           </span>
         </div>`,
    )
    .join('');

  const fus = (res.followups || [])
    .map((q) => `<button class="followup" type="button" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`)
    .join('');

  const conf = res.confidence || 'low';
  const mode = MODE_LABEL[res.mode] || res.mode || '';
  const took = res.meta?.tookMs ? `${res.meta.tookMs} ms` : '';

  const quotaNote =
    res.quota && res.quota.reason && res.quota.reason !== 'disabled'
      ? `<span class="tag tag--medium">今日模型额度已用完，本次转离线</span>`
      : '';

  el.innerHTML = `
    <div class="msg__avatar">答</div>
    <div class="msg__body">
      <div class="bubble">${mdLite(res.answer || '')}</div>
      <div class="answer-meta">
        <span class="tag tag--${conf}">${CONF_LABEL[conf] || conf}</span>
        <span class="tag">${escapeHtml(mode)}</span>
        ${quotaNote}
        ${took ? `<span>${took}</span>` : ''}
        ${res.meta?.promptVersion ? `<span>${escapeHtml(res.meta.promptVersion)}</span>` : ''}
      </div>
      ${cites ? `<div class="cites">${cites}</div>` : ''}
      ${fus ? `<div class="followups">${fus}</div>` : ''}
      <div class="fb">
        <button type="button" data-fb="1" aria-pressed="false">有用</button>
        <button type="button" data-fb="0" aria-pressed="false" class="down">没用</button>
        <span class="fb__note"></span>
      </div>
    </div>`;

  // 反馈
  el.querySelectorAll('[data-fb]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const useful = btn.dataset.fb === '1';
      el.querySelectorAll('[data-fb]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      el.querySelector('.fb__note').textContent = useful ? '已记录，谢谢' : '已记录，会进入待补资料清单';
      try {
        await api('/api/feedback', {
          method: 'POST',
          body: {
            sessionId: state.sessionId,
            questionId: res.questionId || '',
            question,
            useful,
            mode: res.mode,
          },
        });
      } catch {
        toast('反馈未能提交');
      }
    });
  });

  $('#chat').append(el);
  scrollBottom();
}

function scrollBottom() {
  const chat = $('#chat');
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

/* ---------------- 原文抽屉 ---------------- */

let drawerEl = null;

function ensureDrawer() {
  if (drawerEl) return drawerEl;
  drawerEl = document.createElement('div');
  drawerEl.className = 'drawer';
  drawerEl.innerHTML = `
    <div class="drawer__head">
      <div style="min-width:0">
        <h3></h3>
        <p></p>
      </div>
      <button class="icon-btn" style="margin-left:auto" aria-label="关闭">✕</button>
    </div>
    <div class="drawer__body"></div>`;
  drawerEl.querySelector('button').addEventListener('click', closeDrawer);
  document.body.append(drawerEl);
  return drawerEl;
}

async function openDrawer(id) {
  const d = ensureDrawer();
  const body = d.querySelector('.drawer__body');
  d.querySelector('h3').textContent = '加载中…';
  d.querySelector('p').textContent = '';
  body.innerHTML = '';
  d.classList.add('open');
  try {
    const e = await api(`/api/kb/${encodeURIComponent(id)}`);
    d.querySelector('h3').textContent = e.title;
    d.querySelector('p').textContent = [e.dept, e.source, `更新 ${e.updated}`].filter(Boolean).join(' · ');
    body.innerHTML =
      mdLite(e.body) +
      `<div class="src">文件：<code>data/kb/${escapeHtml(e.file)}</code>　标签：${e.tags
        .map((t) => escapeHtml(t))
        .join('、')}</div>`;
  } catch (err) {
    d.querySelector('h3').textContent = '加载失败';
    body.textContent = err.message;
  }
}

function closeDrawer() {
  drawerEl?.classList.remove('open');
}

/* ---------------- API ---------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务返回非 JSON（${res.status}）`);
  }
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

boot();
