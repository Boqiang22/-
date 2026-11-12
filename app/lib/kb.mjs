/**
 * kb.mjs —— 知识库加载与结构化解析
 *
 * 知识库采用 Markdown + 极简 front-matter 存储，一条制度/服务事项一个文件。
 * 选择 Markdown 的原因：便于非技术人员维护、可 diff、可由大模型批量生成初稿后人工校对。
 *
 * front-matter 格式（自定义极简版，不依赖任何第三方库）：
 * ---
 * id: dorm-repair
 * title: 宿舍设施报修流程
 * tags: 报修, 维修, 水电
 * aliases: 宿舍东西坏了我该找谁
 * dept: 后勤保障处
 * updated: 2025-08-22
 * source: 《后勤服务指南》第 4 节（示例数据）
 * ---
 */

import fs from 'node:fs';
import path from 'node:path';

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 解析 front-matter，键值均为字符串；tags/aliases 按中英文逗号切分 */
export function parseFrontMatter(raw) {
  const m = raw.match(FM_RE);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'tags' || key === 'aliases') {
      meta[key] = val
        .split(/[,，、;；]/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** 把正文按二级标题切分为小节；无标题的正文作为默认小节 */
export function splitSections(body) {
  const lines = body.split(/\r?\n/);
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      cur = { heading: h[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  return sections.map((s) => ({
    heading: s.heading,
    text: s.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  }));
}

/** 中文句子切分：句号、问号、感叹号、分号 + 换行 + 列表项边界 */
export function splitSentences(text) {
  const out = [];
  for (const para of text.split(/\r?\n+/)) {
    const t = para.trim();
    if (!t) continue;
    // 列表行整体作为一句（保留“第 1 步：xxx”的完整语义）
    if (/^(\d+[.、)]|[-*•]|第[一二三四五六七八九十]+[步条项])/.test(t)) {
      out.push(t.replace(/^[-*•]\s*/, ''));
      continue;
    }
    let buf = '';
    for (const ch of t) {
      buf += ch;
      if ('。！？；!?;'.includes(ch)) {
        const s = buf.trim();
        if (s.length >= 4) out.push(s);
        buf = '';
      }
    }
    if (buf.trim().length >= 4) out.push(buf.trim());
  }
  return out;
}

/** 加载整个知识库目录 */
export function loadKnowledgeBase(kbDir) {
  if (!fs.existsSync(kbDir)) {
    throw new Error(`知识库目录不存在: ${kbDir}`);
  }
  const files = fs
    .readdirSync(kbDir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort();

  const entries = [];
  const problems = [];
  const seen = new Set();

  for (const file of files) {
    const full = path.join(kbDir, file);
    const raw = fs.readFileSync(full, 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const id = (meta.id || path.basename(file, '.md')).trim();

    if (seen.has(id)) problems.push(`重复条目 id: ${id} (${file})`);
    seen.add(id);

    if (!meta.title) problems.push(`缺少 title: ${file}`);
    if (body.length < 40) problems.push(`正文过短: ${file}`);

    const sections = splitSections(body);
    const sentences = [];
    for (const sec of sections) {
      for (const s of splitSentences(sec.text)) {
        sentences.push({ text: s, heading: sec.heading });
      }
    }

    entries.push({
      id,
      file,
      title: meta.title || id,
      tags: meta.tags || [],
      aliases: meta.aliases || [],
      dept: meta.dept || '',
      updated: meta.updated || '',
      source: meta.source || '',
      body,
      sections,
      sentences,
      chars: body.length,
    });
  }

  return { entries, problems, kbDir };
}
