/**
 * generator.mjs —— 回答生成层
 *
 * 三级降级策略：
 *   L1 llm        ：配置了 API Key 时，调用 OpenAI 兼容接口，资料注入 + 强约束提示词
 *   L2 extractive ：无 Key / 调用失败时，从检索到的原文中抽取最相关句子，按条目组织
 *   L3 fallback   ：检索置信度不足时拒答，给出具体求助渠道，并进入 badcase 池
 *
 * 设计原则：无论走哪一级，回答都必须可溯源（带 [编号]），且不存在“编数”的可能。
 */

import fs from 'node:fs';
import path from 'node:path';
import { tokenize } from './retriever.mjs';

// ---------- Prompt 加载 ----------

export function loadPrompts(promptsDir, override = '') {
  const readOr = (file, fallback) => {
    try {
      return fs.readFileSync(path.join(promptsDir, file), 'utf8');
    } catch {
      return fallback;
    }
  };

  let sys = 'v3';
  let usr = 'v2';
  const cur = readOr('current.txt', '');
  for (const line of cur.split(/\r?\n/)) {
    const [k, v] = line.split('=').map((s) => (s || '').trim());
    if (k === 'system' && v) sys = v;
    if (k === 'user' && v) usr = v;
  }
  if (override && /^v\d+$/.test(override)) sys = override;

  return {
    version: `${sys}/${usr}`,
    system: readOr(`system.${sys}.md`, readOr('system.v3.md', '')),
    user: readOr(`user.${usr}.md`, readOr('user.v2.md', '')),
  };
}

const fill = (tpl, vars) =>
  String(tpl).replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? '' : String(vars[k])));

// ---------- 置信度 ----------

export function judge(retrieved, cfg) {
  const top = retrieved[0];
  if (!top) return { answerable: false, confidence: 'low', coverage: 0, topScore: 0 };
  const cov = top.coverage;
  const strongPhrase = top.phraseHits.some((p) => p.length >= 4);
  let confidence = 'low';
  if (cov >= cfg.confidence.high || strongPhrase) confidence = 'high';
  else if (cov >= cfg.confidence.mid) confidence = 'medium';

  // 硬门槛：必须“词项覆盖够”或“命中长短语”。单靠 BM25 分值高不算数——
  // 长文档容易靠泛词堆出高分（如“食堂”二字就命中整篇饮食指南），那类问题应当拒答。
  const answerable = top.score >= cfg.minScore && (cov >= cfg.confidence.mid || strongPhrase);
  return { answerable, confidence: answerable ? confidence : 'low', coverage: cov, topScore: top.score };
}

// ---------- 句子抽取（L2） ----------

const NUM_RE = /(\d|每|%|元|小时|天|周|学分|人次)/;
const FLOW_RE = /怎么|怎样|如何|流程|步骤|怎么办|需要什么|要准备/;
export const NUMQ_RE = /多少|几|几点|几号|金额|费用|收费|价格|多久|多长时间|比例|学分|时限/;

/**
 * 问题意图识别（规则实现）。作用：不同意图需要不同“证据形状”，
 * 拿时间型问题去匹配一句含金额的句子是错配，反之亦然。
 */
export function detectIntent(q) {
  if (/几点|什么时候|什么时间|开放时间|营业|关门|开门|截止|本学期|第.*周|多久|多长时间/.test(q)) return 'time';
  if (/多少钱|费用|收费|价格|金额|押金|贵不贵|标准是多少/.test(q)) return 'money';
  if (/在哪|哪里|地点|位置|怎么走|几楼|哪个楼|哪个食堂/.test(q)) return 'place';
  if (/电话|联系谁|找谁|热线|邮箱|咨询谁|投诉/.test(q)) return 'contact';
  if (/带什么|准备什么|材料|需要什么|要什么|证明|证件/.test(q)) return 'checklist';
  if (/怎么|怎样|如何|流程|步骤|怎么办|办理|申请|签|挂号|预约/.test(q)) return 'flow';
  return 'general';
}

/** 意图 → 证据特征正则 + 加权。命中即认为“这句话像答案”。
 *  权重量级需与“idf 加权后的词项点积”相当（典型 2~5），否则证据句会被高频词项压过去。 */
const EVIDENCE = {
  time: {
    re: /(\d{1,2}\s*[:：]\s*\d{2})|(\d+\s*(点|小时|分钟|天|周|个月|学年|学期))|周[一二三四五六日]|每天|工作日|全天|截止|延长/,
    w: 4.0,
  },
  money: {
    re: /(\d+(?:\.\d+)?\s*(?:元|块))|每(?:人|学年|学期|月|小时|学分|册|天)/,
    w: 3.4,
  },
  place: { re: /位于|设在|在.{0,10}(?:楼|层|区|馆|厅|中心|内)|位置|米/, w: 2.4 },
  contact: { re: /\d{3,4}\s*[-—]\s*\d{7,8}|\d{11}|电话|热线|邮箱|@/, w: 3.0 },
  checklist: {
    // 必须是“携带/准备 + 材料类名词”，否则“提交延迟报到申请并上传证明材料”也会被误判
    re: /(?:需|须|要)?(?:携带|带上|带齐|准备)[^。]{0,12}(?:材料|证明|原件|复印件|照片|证件)|材料(?:包括|清单|如下)|需提交的?材料/,
    w: 3.0,
  },
  flow: { re: /第[一二三四五六七八九十]+步|\d+[.、)]|提交|审核|办理|申请|登录|填写|前往|领取/, w: 1.6 },
  general: null,
};

/** 评测用开关：置 1 可关闭证据特征 / 枚举 / 小节加权，用于消融对比 */
const EVIDENCE_ENABLED = process.env.QA_NO_EVIDENCE !== '1';

/** 位于“最相关小节”内的句子整体放大倍数 */
export const TOP_SECTION_BOOST = 1.7;
/** 列举型句子（顿号枚举 / “包括”“如下”）是“要带什么材料”这类问题的典型答案形状 */
const LISTING_RE = /包括|如下|清单|分别是|分别为/;

export function scoreSentence(qTf, sentence, { wantNum, base = 1, intent = 'general', idf = null }) {
  const stf = tokenize(sentence);
  let dot = 0;
  for (const [t, w] of qTf) {
    const f = stf.get(t);
    // 句子级同样要做 idf 加权：“消磁”这种只在一条资料里出现的词，比“处理”这种到处都有的词更有指示性
    const iw = idf ? idf.get(t) ?? 1 : 1;
    // 词频饱和取 2：同一个泛词重复出现不应主导排序
    if (f) dot += w * iw * Math.min(f, 2);
  }
  let s = dot / Math.sqrt(1 + sentence.length / 45);
  if (EVIDENCE_ENABLED) {
    if (wantNum && NUM_RE.test(sentence)) s += 0.35;
    const ev = EVIDENCE[intent];
    if (ev && ev.re.test(sentence)) s += ev.w;

    if (intent === 'checklist' || intent === 'general') {
      const enumCount = (sentence.match(/、/g) || []).length;
      if (enumCount >= 2 || LISTING_RE.test(sentence)) s += 3.5;
    }
  }

  // 整句乘以小节权重：小节是“这句话所在语境有多相关”的先验证据
  return s * base;
}

// ---------- 越权 / 违规拦截（前置守卫） ----------

/**
 * 只拦“请求帮助实施违规”的表述，不拦“询问违规后果”。
 * 例：「考试作弊会怎么处理」应正常回答，「怎么作弊」应拒绝。
 */
const VIOLATION_RE =
  /(帮我|替我|给我|教我)(写|做|考|改|抄|刷|投)|代写|代考|枪手|替考|黑进|入侵|篡改|改成绩|破解|盗号|盗取账号|作弊器|怎么作弊|如何作弊|买卖论文|论文代发/;
const PRIVACY_RE = /(别人|他人|其他同学|室友|某人)的(成绩|身份证|学号|手机号|电话|家庭信息|隐私)/;

const GUARD_TEXT = {
  violation: `这个请求我不能提供帮助。

学术诚信和信息系统安全是学校明确规定的红线：

- 考试违纪、代写代考，按《学生违纪处分规定》处理，可给予记过及以上处分，该课程成绩记零分
- 擅自进入或修改教务系统数据属于违规行为，会按规定追责并留存日志
- 如果你确实遇到成绩问题，合规路径是：成绩公布后 5 个工作日内向开课学院提交复核申请

如果你在成绩、选课、论文写作上遇到实际困难，可以换个角度问我，比如「成绩复核怎么申请」「课程论文怎么选题」。`,
  privacy: `我不能查询或透露他人的个人信息。

他人成绩、身份证号、学号、联系方式属于个人隐私，学校只允许本人通过教务系统或一站式服务大厅查询。

如果是你本人的信息需要核对，请携带学生证到一站式服务大厅 5 号窗口办理；紧急情况可联系辅导员协助。`,
};

export function guard(question) {
  const q = String(question || '');
  if (VIOLATION_RE.test(q)) return { type: 'violation', text: GUARD_TEXT.violation };
  if (PRIVACY_RE.test(q)) return { type: 'privacy', text: GUARD_TEXT.privacy };
  return null;
}

/** 抽取时使用的小节权重（关闭证据特征时一并置 1，保证消融干净） */
export function sectionBoost(apply) {
  return EVIDENCE_ENABLED && apply ? TOP_SECTION_BOOST : 1;
}

function similar(a, b) {
  const setA = new Set(tokenize(a, { keepUnigram: false }).keys());
  const setB = new Set(tokenize(b, { keepUnigram: false }).keys());
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / Math.min(setA.size, setB.size);
}

export function extractiveAnswer(question, retrieved, judgment, idfMap = null) {
  const qTf = tokenize(question);
  const intent = detectIntent(question);
  const wantNum = NUMQ_RE.test(question);
  const isFlow = intent === 'flow' || FLOW_RE.test(question);

  // 只从“与首条同量级”的条目里抽句，避免第二、三条的边角句子混进答案
  const top1 = retrieved[0];
  const cutoff = top1 ? top1.score * 0.55 : 0;
  const contributors = retrieved.slice(0, 3).filter((r, i) => i === 0 || r.score >= cutoff);

  const candidates = [];
  const topHeadingOf = new Map();
  contributors.forEach((r, idx) => {
    const n = idx + 1;
    // 取该条目最相关的两个小节作为“相关语境”，只认第一名会漏掉第二相关小节里的关键信息
    const relHeadings = (r.sections || []).slice(0, 2).map((s) => s.heading).filter(Boolean);
    topHeadingOf.set(n, relHeadings);
    for (const sent of r.entry.sentences) {
      const inTopSection = relHeadings.includes(sent.heading);
      const base = (n === 1 ? 1 : 0.7) * sectionBoost(inTopSection);
      const sc = scoreSentence(qTf, sent.text, { wantNum, base, intent, idf: idfMap });
      // 相关小节内的句子即使不含任何查询词也保留为候选——它们是同语境内容，
      // 字面命中者自然排前面，但不要因为没命中关键词就整段丢掉
      if (sc > 0.2 || (inTopSection && sc > 0.05)) candidates.push({ sc: Math.max(sc, 0.55), text: sent.text, n, heading: sent.heading, order: candidates.length });
    }
  });

  candidates.sort((a, b) => b.sc - a.sc);

  const maxN = isFlow ? 7 : 5;
  const quota = { 1: maxN, 2: 1, 3: 1 }; // 次要条目最多贡献一句
  const sectionCount = new Map(); // 小节多样性：避免整段答案都出自同一个小节
  const picked = [];
  const usedTexts = [];
  for (const c of candidates) {
    if (picked.length >= maxN) break;
    if ((quota[c.n] || 0) <= 0) continue;
    if (usedTexts.some((u) => similar(u, c.text) > 0.62)) continue;

    const key = `${c.n}::${c.heading}`;
    const used = sectionCount.get(key) || 0;
    const cap = 3; // 每小节最多 3 句，保证答案覆盖多个角度而不是复述同一段
    if (used >= cap) continue;

    usedTexts.push(c.text);
    picked.push(c);
    quota[c.n] -= 1;
    sectionCount.set(key, used + 1);
  }
  if (!picked.length) return null;

  // 流程型：只有真的存在步骤编号（第X步 / 渠道X / 有序号）时才保持原文先后，
  // 否则按相关性降序——否则“校园卡怎么处理”会把“新生办卡”这种背景句顶到第一条
  const stepCount = picked.filter((p) => /^(第[一二三四五六七八九十]+步|渠道[一二三四五]|\d+[.、)])/.test(p.text)).length;
  if (stepCount >= 2) picked.sort((a, b) => a.n - b.n || a.order - b.order);

  const top = retrieved[0];
  const src = quoteSource(top.entry.source);
  const lead = isFlow
    ? `按${src}的说明，「${top.entry.title}」主要是这几步：`
    : `根据${src}里「${top.entry.title}」的规定：`;

  const bullet = picked.map((p) => `- ${cleanLead(p.text)} [${p.n}]`).join('\n');

  const secTitle = top.sections?.[0]?.heading;
  const tail = `参考：${top.entry.title}${secTitle ? `（${secTitle}）` : ''}${top.entry.dept ? ` · ${top.entry.dept}` : ''}`;

  const text = `${lead}\n\n${bullet}\n\n${tail}`.replace(/\n{3,}/g, '\n\n').trim();
  return { text, picked: picked.length, intent };
}

/** 来源名统一加书名号，且不重复包裹已带《》的来源 */
const quoteSource = (s) => {
  const t = String(s || '')
    .replace(/（示例数据）/g, '')
    .trim();
  if (!t) return '校内资料';
  return t.includes('《') ? t : `《${t}》`;
};
/** 去掉列表项自带的编号前缀，避免与抽取出来的列表嵌套 */
const cleanLead = (s) => String(s).replace(/^(第[一二三四五六七八九十]+步|第[一二三四五六七八九十]+条|\d+[.、)])\s*[:：]?\s*/, '');

// ---------- 拒答（L3） ----------

export function fallbackAnswer(question, retrieved) {
  const weak = retrieved.slice(0, 3).filter((r) => r.score > 0.6);
  const lines = [
    '这个问题在现有校内资料里没有找到明确依据，我不做猜测。',
    '',
    '可以这样处理：',
    '- 问辅导员：具体政策、个人情况类问题最快（学生事务 App 内可直接联系）',
    '- 教务处教学运行科：选课、成绩、学籍、考试类',
    '- 一站式服务大厅（行政楼 1 层）：校园卡、证明开具、缴费',
    '- 后勤保障处：宿舍、食堂、维修、水电',
    '',
    '你也可以换个更具体的说法再问一次，比如把场景说清楚（“宿舍水龙头漏水怎么办”比“宿舍有问题”更好定位）。',
  ];
  if (weak.length) {
    lines.push('', '另外这几条可能沾边，看看是不是你要的：');
    for (const w of weak) lines.push(`- 「${w.entry.title}」`);
  }
  return { text: lines.join('\n'), weak: weak.map((w) => w.entry.title) };
}

// ---------- L1：调用大模型 ----------

export function buildDocuments(retrieved) {
  return retrieved
    .map((r, i) => {
      const e = r.entry;
      const section = r.sections?.[0]?.heading;
      const body = section
        ? e.sections.find((s) => s.heading === section)?.text || e.body
        : e.body;
      return `[${i + 1}] 《${e.title}》\n    部门：${e.dept}｜来源：${e.source}｜更新：${e.updated}${section ? `｜相关小节：${section}` : ''}\n${indent(body, '    ')}`;
    })
    .join('\n\n');
}

const indent = (text, pad) =>
  String(text)
    .split(/\r?\n/)
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n');

export async function llmAnswer({ question, retrieved, history, prompts, cfg }) {
  const documents = buildDocuments(retrieved);
  const historyText = history.length
    ? history.map((h) => `${h.role === 'user' ? '同学' : '助手'}：${h.content}`).join('\n').slice(-1200)
    : '（无）';

  const userPrompt = fill(prompts.user, { documents, history: historyText, question });
  const systemPrompt = fill(prompts.system, { campus_name: cfg.campusName || '本校' });

  const url = cfg.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.llm.model,
      temperature: cfg.llm.temperature,
      max_tokens: cfg.llm.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(cfg.llm.timeoutMs),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('LLM 返回为空');

  return {
    text,
    usage: data.usage || null,
    latencyMs: Date.now() - started,
    model: cfg.llm.model,
  };
}

// ---------- 追问建议 ----------

export function followups(question, retrieved) {
  const out = [];
  const top = retrieved[0];
  if (top) {
    for (const s of top.entry.sections) {
      if (!s.heading || s.heading === top.sections?.[0]?.heading) continue;
      out.push(`${s.heading}是怎么规定的？`);
      if (out.length >= 2) break;
    }
    if (top.entry.tags.length) {
      const tag = top.entry.tags.find((t) => !question.includes(t));
      if (tag) out.push(`关于「${tag}」还有什么要注意的？`);
    }
  }
  for (const r of retrieved.slice(1, 3)) {
    const q = `「${r.entry.title}」呢？`;
    if (!out.includes(q)) out.push(q);
  }
  return out.slice(0, 3);
}

// ---------- 编排 ----------

export async function answer({ question, retrieved, index, history, prompts, cfg, store, sessionId }) {
  const started = Date.now();

  // 前置守卫优先于检索：越权/违规请求不应因“检索到了相关条目”而被当作可回答
  const blocked = guard(question);
  if (blocked) {
    const payload = {
      text: blocked.text,
      mode: 'blocked',
      confidence: 'low',
      answerable: false,
      citations: [],
      followups: ['成绩复核怎么申请？', '请假审批流程是什么？'],
      meta: {
        topScore: 0,
        coverage: 0,
        tookMs: Date.now() - started,
        promptVersion: prompts.version,
        guard: blocked.type,
      },
    };
    if (store) {
      await store.append('chat', {
        sessionId,
        question,
        mode: 'blocked',
        confidence: 'low',
        answerable: false,
        guard: blocked.type,
        tookMs: payload.meta.tookMs,
      });
    }
    return payload;
  }

  const judgment = judge(retrieved, cfg);

  const citations = retrieved.map((r, i) => ({
    n: i + 1,
    id: r.entry.id,
    title: r.entry.title,
    dept: r.entry.dept,
    source: r.entry.source,
    updated: r.entry.updated,
    section: r.sections?.[0]?.heading || '',
    score: +r.score.toFixed(2),
  }));

  let result;
  let mode = 'fallback';

  if (!judgment.answerable) {
    const fb = fallbackAnswer(question, retrieved);
    result = { text: fb.text, citations: citationForWeak(retrieved), followups: genericFollowups() };
    mode = 'fallback';
    if (store) {
      await store.append('unanswered', {
        sessionId,
        question,
        topScore: +judgment.topScore.toFixed(2),
        coverage: +judgment.coverage.toFixed(2),
        candidates: retrieved.slice(0, 3).map((r) => r.entry.id),
      });
    }
  } else if (cfg.llm.active) {
    try {
      const llm = await llmAnswer({ question, retrieved, history, prompts, cfg });
      result = {
        text: sanitize(llm.text),
        followups: followups(question, retrieved),
        usage: llm.usage,
        latencyMs: llm.latencyMs,
        model: llm.model,
        citations,
      };
      mode = 'llm';
    } catch (err) {
      console.warn(`[generator] 大模型调用失败，降级为抽取式：${err.message}`);
      const ex = extractiveAnswer(question, retrieved, judgment, index?.idf) || { text: '' };
      result = { text: ex.text, followups: followups(question, retrieved), citations, degraded: err.message };
      mode = 'extractive';
    }
  } else {
    const ex = extractiveAnswer(question, retrieved, judgment, index?.idf);
    if (ex) {
      result = { text: ex.text, followups: followups(question, retrieved), citations };
      mode = 'extractive';
    } else {
      const fb = fallbackAnswer(question, retrieved);
      result = { text: fb.text, citations, followups: genericFollowups() };
      mode = 'fallback';
    }
  }

  const payload = {
    text: result.text,
    mode,
    confidence: judgment.confidence,
    answerable: judgment.answerable,
    citations: result.citations || citations,
    followups: result.followups || [],
    meta: {
      topScore: +judgment.topScore.toFixed(2),
      coverage: +judgment.coverage.toFixed(2),
      tookMs: Date.now() - started,
      promptVersion: prompts.version,
      model: result.model || null,
      usage: result.usage || null,
      degraded: result.degraded || null,
    },
  };

  // 只保留正文真正引用到的资料，避免“答案只用了一个来源，却列出四张引用卡片”
  let finalCitations = result.citations || citations;
  if (mode !== 'fallback') {
    const usedNums = new Set([...payload.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    if (usedNums.size) {
      const kept = finalCitations.filter((c) => usedNums.has(c.n));
      if (kept.length) finalCitations = kept;
    }
  }
  payload.citations = finalCitations;

  if (store) {
    await store.append('chat', {
      sessionId,
      question,
      mode,
      confidence: judgment.confidence,
      answerable: judgment.answerable,
      topEntry: retrieved[0]?.entry.id || null,
      topScore: payload.meta.topScore,
      coverage: payload.meta.coverage,
      tookMs: payload.meta.tookMs,
      answerChars: payload.text.length,
    });
  }

  return payload;
}

function citationForWeak(retrieved) {
  return retrieved.slice(0, 3).map((r, i) => ({
    n: i + 1,
    id: r.entry.id,
    title: r.entry.title,
    dept: r.entry.dept,
    source: r.entry.source,
    updated: r.entry.updated,
    section: r.sections?.[0]?.heading || '',
    score: +r.score.toFixed(2),
    weak: true,
  }));
}

function genericFollowups() {
  return ['转专业需要什么条件？', '奖学金怎么申请？', '宿舍报修找谁？'];
}

/** 兜底清洗：去掉模型偶发的 ``` 围栏与过多空行 */
function sanitize(text) {
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
