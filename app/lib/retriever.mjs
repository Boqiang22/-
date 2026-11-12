/**
 * retriever.mjs —— 纯手写中文检索层（零依赖）
 *
 * 为什么不用 LLM / 向量库：
 *   1) 校园问答的答案必须可溯源，检索式召回比生成式更可控；
 *   2) 零依赖部署，学校机房裸 Node 即可运行；
 *   3) 离线可用，不依赖外部 API 与网络。
 *
 * 算法：字段加权的 BM25 + 口语别名短语加权 + 查询词项覆盖率置信度。
 *   中文切分策略：拉丁词/数字按词；中文串先剔除停用词，再产出 bigram（主要）与 unigram（降权）。
 */

// 虚字 + 语气助词：它们参与 bigram 会产生“了能”“格吗”这类假词项，拉低覆盖率
const STOP_CHARS = new Set('的了是在有和与及或把被给对从向往就都也很更还又再则而但却只把被吗呢吧啊呀哦嘛算'.split(''));
const STOP_WORDS = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '咱们', '自己',
  '这个', '那个', '这些', '那些', '这边', '那边', '这样', '那样',
  '一个', '一种', '一些', '一下', '一点', '一样', '一直', '一般',
  '怎么', '怎样', '如何', '什么', '为什么', '为啥', '哪个', '哪些', '哪里', '哪儿', '哪天',
  '吗', '呢', '吧', '啊', '呀', '哦', '嘛', '的话', '是否',
  '请问', '麻烦', '帮我', '帮忙', '请教', '想问', '想知道', '告诉',
  '谢谢', '好的', '可以', '能不能', '可不可以', '能否', '要不要', '会不会',
  '以及', '还有', '然后', '如果', '因为', '所以', '但是', '不过', '而且', '并且',
  '这', '那', '其', '之', '的话', '的话',
]);
/** 弱词：保留但降权（校园语境下几乎每篇都出现，区分度低） */
const SOFT_WORDS = new Set(['学校', '同学', '学生', '老师', '大学', '校园', '校方', '一下', '现在', '目前']);

const LATIN_RE = /[a-z0-9]+(?:[.\-_/][a-z0-9]+)*/gi;
const CJK_RUN_RE = /[\u4e00-\u9fa5]+/g;
const STOP_CHAR_RE = new RegExp('[' + [...STOP_CHARS].join('') + ']', 'g');

/** 把中文串里的停用词切成空格，避免停用词污染 bigram 边界 */
function stripStopWords(s) {
  for (const w of STOP_WORDS) {
    if (s.includes(w)) s = s.split(w).join('\u0001');
  }
  return s;
}

/**
 * 切词。返回 Map<term, weight>。
 * bigram 权重 1.0；unigram 权重 0.35；拉丁词权重 1.0。
 */
export function tokenize(text, { keepUnigram = true } = {}) {
  const tf = new Map();
  const add = (t, w) => {
    if (!t) return;
    tf.set(t, (tf.get(t) || 0) + w);
  };

  const lower = String(text || '').toLowerCase();

  for (const m of lower.matchAll(LATIN_RE)) {
    add(m[0], 1);
  }

  // 虚字（的/了/在/能…）作为切分边界：否则“成绩出错了能复核”会产生“了能”“能复”这类假词项，
  // 既拉低覆盖率，也把无关文档拉进来
  const cleaned = stripStopWords(lower).replace(STOP_CHAR_RE, '\u0001');
  for (const run of cleaned.match(CJK_RUN_RE) || []) {
    for (const part of run.split('\u0001')) {
      if (!part) continue;
      if (STOP_WORDS.has(part)) continue;
      const w = SOFT_WORDS.has(part) ? 0.35 : 1;
      if (part.length === 1) {
        if (keepUnigram && !STOP_CHARS.has(part)) add(part, 0.35 * w);
        continue;
      }
      for (let i = 0; i < part.length - 1; i++) {
        add(part.slice(i, i + 2), 1 * w);
      }
      if (keepUnigram) {
        for (const ch of part) {
          if (!STOP_CHARS.has(ch)) add(ch, 0.3 * w);
        }
      }
    }
  }
  return tf;
}

/** 只保留 bigram / 拉丁词（用于覆盖率置信度，单字噪音太大） */
export function strongTerms(tf) {
  const out = new Set();
  for (const [t, w] of tf) {
    if (t.length >= 2) out.add(t);
    else if (w >= 0.9) out.add(t);
  }
  return out;
}

const FIELD_WEIGHT = { title: 3.2, meta: 2.6, body: 1.0 };
const K1 = 1.4;
const B = 0.72;
/** 评测用开关：置 1 可关闭“意图→小节”先验，用于消融对比 */
const HINT_ENABLED = process.env.QA_NO_SECTION_HINT !== '1';

/** 构建索引 + 短语表（tags / aliases / 小标题） */
export function buildIndex(entries) {
  const docs = entries.map((e) => {
    const fields = {
      title: tokenize(e.title, { keepUnigram: false }),
      meta: tokenize([...e.tags, ...e.aliases, ...e.sections.map((s) => s.heading)].join(' '), {
        keepUnigram: false,
      }),
      body: tokenize(e.body),
    };
    // 合并为加权词频表
    const tf = new Map();
    let len = 0;
    for (const [name, map] of Object.entries(fields)) {
      const fw = FIELD_WEIGHT[name];
      for (const [t, w] of map) {
        tf.set(t, (tf.get(t) || 0) + w * fw);
        len += w * fw;
      }
    }
    return { entry: e, tf, len, metaTerms: new Set([...fields.title.keys(), ...fields.meta.keys()]) };
  });

  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(1, docs.length);

  const df = new Map();
  for (const d of docs) {
    for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = docs.length;
  const idf = new Map();
  for (const [t, n] of df) {
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  // 短语表：口语别名 / 标签 / 小节标题 → 条目索引，用于精确口语命中
  const phrases = new Map(); // phrase -> [{di, weight}]
  docs.forEach((d, di) => {
    const e = d.entry;
    const addPhrase = (p, w) => {
      const key = p.trim().toLowerCase();
      if (key.length < 2 || key.length > 16) return;
      if (!phrases.has(key)) phrases.set(key, []);
      phrases.get(key).push({ di, weight: w });
    };
    for (const a of e.aliases) addPhrase(a, 1.6);
    for (const t of e.tags) addPhrase(t, 1.2);
    for (const s of e.sections) addPhrase(s.heading, 0.8);
    addPhrase(e.title, 1.0);
  });

  return { docs, idf, avgLen, N, phrases };
}

function bm25Score(index, queryTf) {
  const scores = new Array(index.docs.length).fill(0);
  const coverage = new Array(index.docs.length).fill(0);
  const qStrong = strongTerms(queryTf);

  index.docs.forEach((d, di) => {
    let s = 0;
    let hitStrong = 0;
    for (const [t, qw] of queryTf) {
      const f = d.tf.get(t);
      if (!f) continue;
      const idf = index.idf.get(t) || 0;
      const denom = f + K1 * (1 - B + B * (d.len / index.avgLen));
      s += qw * idf * ((f * (K1 + 1)) / denom);
      if (qStrong.has(t)) hitStrong++;
    }
    scores[di] = s;
    coverage[di] = qStrong.size ? hitStrong / qStrong.size : 0;
  });
  return { scores, coverage };
}

/**
 * 意图 → 小节标题线索。
 * 中文资料的正文常把主语简写（“图书馆”在“开放时间”一节里写作“主馆”），
 * 纯字面匹配定位不到正确小节。这里用一节标题先验补上这个缺口。
 */
const SECTION_HINTS = {
  time: /时间|开放|营业|时刻|安排|截止|期限|学期/,
  money: /收费|费用|标准|资费|金额|价格|缴费|补贴/,
  place: /位置|地点|分布|在哪|入口|地址/,
  contact: /联系|渠道|咨询|电话|反馈/,
  checklist: /材料|携带|准备|清单|证件|需要|办理/,
  flow: /流程|办理|申请|步骤|操作|预约|申报/,
  general: null,
};

/**
 * 检索。返回按分数排序的命中列表。
 * @param {object} [opts]
 * @param {number} [opts.topK]
 * @param {string} [opts.intent] 问题意图（time/money/place/contact/checklist/flow/general）
 * @returns {{entry, score, coverage, phraseHits: string[], sections: {heading, score}[]}[]}
 */
export function search(index, query, { topK = 5, intent = 'general' } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const queryTf = tokenize(q);
  const { scores, coverage } = bm25Score(index, queryTf);
  const qLower = q.toLowerCase();

  const phraseHits = new Array(index.docs.length).fill(0).map(() => []);
  for (const [phrase, hits] of index.phrases) {
    if (!qLower.includes(phrase)) continue;
    for (const { di, weight } of hits) {
      // 短语越长越可信
      const lenBonus = Math.min(1.6, 0.8 + phrase.length / 8);
      scores[di] += weight * lenBonus;
      phraseHits[di].push(phrase);
    }
  }

  // 标题被整句包含（如直接输入“宿舍设施报修流程”）
  index.docs.forEach((d, di) => {
    const t = d.entry.title.toLowerCase();
    if (t.length >= 4 && qLower.includes(t)) scores[di] += 6;
  });

  const ranked = scores
    .map((score, di) => ({
      entry: index.docs[di].entry,
      score,
      coverage: coverage[di],
      phraseHits: [...new Set(phraseHits[di])],
    }))
    .filter((r) => r.score > 0.4)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // 为每个命中定位最相关的小节（供引用溯源 + 抽取时的小节加权）
  const hint = HINT_ENABLED ? SECTION_HINTS[intent] || null : null;
  for (const r of ranked) {
    r.sections = r.entry.sections
      .map((s) => {
        const stf = tokenize(`${s.heading} ${s.text}`);
        let sc = 0;
        for (const [t, qw] of queryTf) {
          const f = stf.get(t);
          if (f) sc += qw * (index.idf.get(t) || 0) * Math.min(f, 6);
        }
        // 意图明确时，小节标题是极强的先验，权重需压过“正文里恰好提到主语”的字面噪声
        if (hint && hint.test(s.heading)) sc += 4.6;
        return { heading: s.heading, score: sc };
      })
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0);
  }

  return ranked;
}
