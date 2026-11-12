/**
 * config.mjs —— 配置读取（config.json > 环境变量 > 默认值）
 *
 * 之所以支持三级来源：交付给非技术用户时改 config.json 即可；
 * 部署到服务器时用环境变量注入密钥，避免密钥进版本库。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT_ROOT = path.resolve(APP_ROOT, '..');

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    console.warn(`[config] 解析失败，已忽略: ${file} (${err.message})`);
    return null;
  }
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  return /^(1|true|yes|on)$/i.test(String(v));
};

export function loadConfig() {
  const fileCfg = readJsonSafe(path.join(APP_ROOT, 'config.json')) || {};
  const env = process.env;

  const llmFile = fileCfg.llm || {};
  const llm = {
    enabled: bool(env.QA_LLM_ENABLED, llmFile.enabled ?? false),
    baseUrl: env.QA_LLM_BASE_URL || llmFile.baseUrl || 'https://api.deepseek.com/v1',
    apiKey: env.QA_LLM_API_KEY || llmFile.apiKey || '',
    model: env.QA_LLM_MODEL || llmFile.model || 'deepseek-chat',
    temperature: num(env.QA_LLM_TEMPERATURE, num(llmFile.temperature, 0.2)),
    maxTokens: num(env.QA_LLM_MAX_TOKENS, num(llmFile.maxTokens, 700)),
    timeoutMs: num(env.QA_LLM_TIMEOUT_MS, num(llmFile.timeoutMs, 30000)),
  };
  // 只有同时具备开关与密钥时才真正启用大模型
  llm.active = Boolean(llm.enabled && llm.apiKey);

  const cfg = {
    // 云端平台通常注入 PORT / HOST。检测到 PORT 时强制监听所有网卡，
    // 否则 config.json 里的 127.0.0.1 会让容器外访问不到（这是最容易踩的坑）
    host: env.QA_HOST || env.HOST || (env.PORT ? '0.0.0.0' : fileCfg.host || '127.0.0.1'),
    port: num(env.QA_PORT || env.PORT, num(fileCfg.port, 7788)),
    topK: num(env.QA_TOP_K, num(fileCfg.topK, 4)),
    minScore: num(env.QA_MIN_SCORE, num(fileCfg.minScore, 2.2)),
    // 置信度：查询强词项被命中文档覆盖的比例
    confidence: {
      high: num(fileCfg.confidenceHigh, 0.55),
      mid: num(fileCfg.confidenceMid, 0.32),
    },
    promptVersion: env.QA_PROMPT_VERSION || fileCfg.promptVersion || '',
    campusName: env.QA_CAMPUS_NAME || fileCfg.campusName || '本校',
    kbDir: path.join(APP_ROOT, 'data', 'kb'),
    runtimeDir: path.join(APP_ROOT, 'data', 'runtime'),
    publicDir: path.join(APP_ROOT, 'public'),
    promptsDir: path.join(APP_ROOT, 'prompts'),
    llm,
    // 公网访问保护（本地演示时一般用不到，部署后自动生效）
    limits: {
      perMinute: num(env.QA_LIMIT_PER_MIN, num(fileCfg.limitPerMinute, 10)),
      perDayPerIp: num(env.QA_LIMIT_DAY_IP, num(fileCfg.limitPerDayPerIp, 30)),
      globalPerDay: num(env.QA_LIMIT_DAY_GLOBAL, num(fileCfg.limitGlobalPerDay, 600)),
    },
    demoBanner: fileCfg.demoBanner ?? true,
  };

  if (env.QA_KB_DIR) cfg.kbDir = path.resolve(env.QA_KB_DIR);
  if (env.QA_RUNTIME_DIR) cfg.runtimeDir = path.resolve(env.QA_RUNTIME_DIR);

  return cfg;
}
