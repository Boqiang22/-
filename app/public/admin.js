/* 运营看板 */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(label, value, hint = '') {
  return `<div class="stat"><div class="stat__label">${esc(label)}</div><div class="stat__value">${esc(value)}</div><div class="stat__hint">${esc(hint)}</div></div>`;
}

async function load() {
  const res = await fetch('/api/stats');
  const s = await res.json();

  const modeText = s.mode === 'llm' ? '大模型' : '离线抽取';
  const fbRate = s.feedback.usefulRate == null ? '—' : Math.round(s.feedback.usefulRate * 100) + '%';
  const lowRate = s.lowConfidenceRate == null ? '—' : Math.round(s.lowConfidenceRate * 100) + '%';

  $('#cards').innerHTML = [
    card('累计提问', s.questions, `会话 ${s.sessions} 次`),
    card('有效反馈率', fbRate, `${s.feedback.useful} / ${s.feedback.total} 条反馈`),
    card('低置信度占比', lowRate, '需补资料的问题比例'),
    card('未答问题', s.unanswered, '已进入 badcase 池'),
    card('知识库条目', s.kbEntries, `生成模式：${modeText}`),
  ].join('');

  const byMode = Object.entries(s.byMode || {})
    .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${v}</td></tr>`)
    .join('');
  const trend = (s.trend || [])
    .map((t) => `<tr><td>${esc(t.day)}</td><td style="width:60%"><div class="bar-wrap"><div class="bar" style="width:${Math.min(100, t.n * 12)}%"></div></div></td><td>${t.n}</td></tr>`)
    .join('');

  $('#unanswered').innerHTML = s.topUnanswered?.length
    ? `<table><thead><tr><th>问题</th><th style="width:80px">次数</th></tr></thead><tbody>${s.topUnanswered
        .map((u) => `<tr><td>${esc(u.question)}</td><td>${u.count}</td></tr>`)
        .join('')}</tbody></table>`
    : '<div class="empty-row">暂无未答问题。随着使用量增加，这里会累积需要补资料的问题。</div>';

  $('#recent').innerHTML = `
    <table>
      <thead><tr><th>问题</th><th>模式</th><th>置信度</th><th>耗时</th></tr></thead>
      <tbody>
        ${(s.recent || [])
          .map(
            (r) =>
              `<tr><td>${esc(r.question)}</td><td><code>${esc(r.mode)}</code></td><td>${esc(r.confidence)}</td><td>${esc(
                r.tookMs,
              )} ms</td></tr>`,
          )
          .join('') || '<tr><td colspan="4" class="empty-row">还没有提问记录</td></tr>'}
      </tbody>
    </table>
    ${trend ? `<div style="margin-top:14px"><div class="stat__label" style="margin-bottom:6px">每日提问量</div><table>${trend}</table></div>` : ''}
    ${byMode ? `<div style="margin-top:14px"><div class="stat__label" style="margin-bottom:6px">按生成模式分布</div><table>${byMode}</table></div>` : ''}
  `;

  $('#kbInfo').innerHTML = `
    <table><tbody>
      <tr><th>提示词版本</th><td><code>${esc(s.promptVersion)}</code></td></tr>
      <tr><th>知识库条目</th><td>${s.kbEntries} 条</td></tr>
      <tr><th>校验告警</th><td>${s.kbProblems?.length ? s.kbProblems.map(esc).join('<br>') : '无'}</td></tr>
      <tr><th>操作</th><td><button class="ghost-link" id="reload">重新加载知识库</button></td></tr>
    </tbody></table>`;

  $('#reload')?.addEventListener('click', async () => {
    const r = await fetch('/api/admin/reload', { method: 'POST' }).then((x) => x.json());
    alert(`已重新加载：${r.entries} 条资料，提示词 ${r.promptVersion}`);
    load();
  });
}

load().catch((e) => {
  document.querySelector('.board').insertAdjacentHTML('afterbegin', `<p style="color:var(--danger)">加载失败：${esc(e.message)}</p>`);
});
