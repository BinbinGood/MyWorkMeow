'use strict';

// Persistent WorkBuddy token ledger + pricing (read-only, from transcripts).
//
// WorkBuddy writes one JSONL transcript per session under
//   ~/.workbuddy/projects/<encoded-cwd>/<session-id>.jsonl
//
// 行形状与 Claude Code **不同**（2026-09 本机实测：27 个 session / 9964 行）：
// 一次模型请求落成 type:"function_call"（要工具）或 type:"message"（文本回复），
// 转录里**不存在** type/role === "assistant" 的行。usage 挂在行的
// `providerData.usage` 上（OpenAI 形状，2266 + 285 条，messageId 全部唯一）：
//   { requests, inputTokens, outputTokens, totalTokens,
//     inputTokensDetails:  [{ cached_tokens }],
//     outputTokensDetails: [{ reasoning_tokens }] }
// 同一行通常还带一份数值等价的 `message.usage`（Anthropic 形状），二者总是成对
// 出现，所以取其一即可 —— 相加会双计。模型 id 在 `providerData.model`（如
// "hy4-preview"），去重键是 `providerData.messageId`。
//
// 因此这里按「字段是否存在」识别用量行，而不是按 role/type 判断：旧实现要求
// role/type === "assistant"，在 WorkBuddy 上永远匹配不到，用量恒为 0。
//
// 积分（credit）：
// 同一行还带 `providerData.rawUsage.credit`，就是 WorkBuddy 客户端里显示的「积分」
// 消耗。语义来自内核源码
// packages/workbuddy-core/src/conversations/node/persistence/
// sqlite-conversation-usage-port.ts —— 它把 `usage.cost.amount` 按 requestId 累加
// 进 session_usage.credit_json。本机实测：1429 行有正值，且这些行**全部**同时带
// providerData.usage / rawUsage.total_tokens，所以 credit 是现有用量行的子集，
// 不需要新增任何行选择逻辑，也不会引入「只有 credit 没有 token」的行。
// 与 USD 等价费用不同，积分是厂商自己的计价单位，不做任何换算、不加价目表。
//
// 两侧口径核对过（2026-09-15 本机）：转录侧加总 1728.7，DB 的 credit_json 加总
// 1692.5，差额来自被软删除的会话（DB 只留未删除会话）与个别没落转录的请求。
// 选用转录侧是因为它带时间戳，才能落进「今日」口径。
//
// Pricing policy (per product decision): use the EXACT prices found in the
// models.dev price source — if a model has a price there, use it; if not, do NOT
// estimate, just report tokens (cost 0). The source cache carries explicitly
// extracted maps (models / openaiModels / otherModels)，其中 otherModels 覆盖
// 主流国产厂商（GLM/Kimi/DeepSeek/Qwen/豆包/MiniMax…），全部由社区维护价目
// 每日自动同步，无需人工维护。
// WorkBuddy's default model "hy3" has no public price, so its cost shows $0.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { STATE_DIR } = require('./paths');
const { num, dayKey, parseTimestamp, mergeLifetime } = require('./metering-common');
const { createMeterQueue } = require('./meter-queue');

const PROJECTS_DIR = path.join(os.homedir(), '.workbuddy', 'projects');
const STATE_PATH = path.join(STATE_DIR, 'workbuddy-usage.json');
const PRICING_CACHE_PATH = path.join(STATE_DIR, 'pricing-cache.json'); // models.dev sync cache
const PRICING_OVERRIDE_PATH = path.join(STATE_DIR, 'workbuddy-pricing.json'); // user override
// v5: 修正流式 assistant 消息的轮次统计。相同 messageId 的后续累计更新
// 只补 token 增量，不应再次增加消息轮次，需要全量重扫一次。
// v6: numeric Unix timestamps were previously passed to Date.parse(), which
// failed and assigned every historical row to the scan day. Force one clean
// rescan so already-persisted "today" buckets are repaired automatically.
// v7: 用量行识别从 role/type === "assistant" 改为按字段识别。WorkBuddy 的转录行
// 是 function_call / message，旧条件永远匹配不到。此前那次提交的说明写了「升到
// 7」，但代码实际没改到（仍是 6），所以这一版一并补上。
// v8: usage 形状新增 credit（积分）字段，并随 daily / byModelByDay / lifetime 一起
// 聚合。旧台账里没有这个字段，必须重扫，否则历史积分永远是空的。
const SCHEMA_VERSION = 8;
const DAILY_KEEP_DAYS = 95;
const BACKFILL_MS = DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000;

// Minimal fallback so normalizePriceRow always has a row to merge onto.
// Unused for real billing (exactOnly pricing returns null for unknown models).
const DEFAULT_PRICING = {
  default: { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 },
};

function normModelName(model) {
  const s = String(model || '').toLowerCase().trim();
  if (!s) return '';
  // Strip version dates and provider prefixes, keep the bare id.
  return s.replace(/-\d{4}\d{2}\d{2}\b/g, '').replace(/@.*$/, '').split('/').pop() || s;
}

function normalizePriceRow(row, fallback = DEFAULT_PRICING.default) {
  const input = Number.isFinite(row && row.input) ? row.input : fallback.input;
  const output = Number.isFinite(row && row.output) ? row.output : fallback.output;
  const cachedInput = Number.isFinite(row && row.cachedInput)
    ? row.cachedInput
    // models.dev 的 Claude 模型行用 cacheRead 命名缓存读取价
    : Number.isFinite(row && row.cacheRead) ? row.cacheRead
    : input * 0.1;
  // 缓存写入价（Anthropic 5m 写 ≈ 1.25×输入）；OpenAI 系无缓存写入费（用不到该字段）
  const cacheWrite = Number.isFinite(row && row.cacheWrite)
    ? row.cacheWrite
    : Number.isFinite(row && row.cacheWrite5m) ? row.cacheWrite5m
    : input * 1.25;
  return { input, output, cachedInput, cacheWrite };
}

// Merge every extracted model price map present in the models.dev cache
// (claude models + openaiModels + otherModels) into one flat lookup.
// User override wins.
function loadPricing(pricingCachePath = PRICING_CACHE_PATH, pricingOverridePath = PRICING_OVERRIDE_PATH) {
  const out = JSON.parse(JSON.stringify(DEFAULT_PRICING));
  out._models = {};
  const SKIP = new Set(['ts', 'source', 'url', 'pricing']);
  try {
    const c = JSON.parse(fs.readFileSync(pricingCachePath, 'utf8'));
    for (const [k, v] of Object.entries(c)) {
      if (SKIP.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [id, row] of Object.entries(v)) {
          if (row && typeof row === 'object' && Number.isFinite(row.input)) {
            out._models[normModelName(id)] = normalizePriceRow(row);
          }
        }
      }
    }
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(pricingOverridePath, 'utf8'));
    for (const [key, row] of Object.entries(raw)) {
      if (key === 'models' && row && typeof row === 'object') {
        for (const [id, r] of Object.entries(row)) {
          const k = normModelName(id);
          if (r && typeof r === 'object') out._models[k] = normalizePriceRow(r, out._models[k] || DEFAULT_PRICING.default);
        }
      } else if (row && typeof row === 'object') {
        out[key] = normalizePriceRow(row, out[key] || DEFAULT_PRICING.default);
      }
    }
  } catch {}
  return out;
}

// exactOnly: return the exact price if the model is in the source, else null
// (never fall back to a family/default estimate).
// Module-level helper using the default (real user) paths — kept for external
// callers; the factory below uses its own instance-scoped copy so injected
// pricingCachePath/pricingOverridePath options actually take effect.
let pricing = loadPricing();
function priceFor(model) {
  const models = pricing._models || {};
  const norm = normModelName(model);
  if (norm && models[norm]) return normalizePriceRow(models[norm]);
  return null;
}

function usageCost(usage, price) {
  if (!price) return 0; // no source price → don't count cost
  const u = usage || emptyUsage();
  const p = normalizePriceRow(price);
  // input 为统一后的 OpenAI 语义（含缓存读取与缓存写入），计费时全部拆开：
  // 普通输入按 input 价、缓存读取按 cachedInput 价、缓存写入按 cacheWrite 价。
  const regularInput = Math.max(0, num(u.input) - num(u.cachedInput) - num(u.cacheWrite));
  return (regularInput * p.input + num(u.output) * p.output
    + num(u.cachedInput) * p.cachedInput + num(u.cacheWrite) * p.cacheWrite) / 1e6;
}

function emptyUsage() {
  // credit 与 cost 是两种互不相干的计价：cost 是按 models.dev 价目算出的美元等价
  // 估算，credit 是 WorkBuddy 自己的积分消耗。两者都可能有值，也可能只有一个。
  return {
    tokens: 0, input: 0, output: 0, cachedInput: 0, reasoningOutput: 0,
    cacheWrite: 0, cost: 0, credit: 0,
  };
}

// Map WorkBuddy's usage onto the normalized token shape. Two shapes exist in
// the wild: providerData.usage (OpenAI camelCase, cached/reasoning nested in
// details arrays) and message.usage (Anthropic shape: input_tokens /
// cache_creation_input_tokens / cache_read_input_tokens). Handle both.
//
// 语义约定（v4 修正）：归一化后 input 一律为 OpenAI 语义——包含缓存读取与
// 缓存写入部分；cachedInput 只表示缓存「读取」、cacheWrite 只表示缓存「写入」。
// 此前 Anthropic 形状把 cache_creation 当 cachedInput 返回（写入价按读取价计），
// 且 cacheWrite 虽统计却从未参与计费，两个 bug 一起修掉。
// credit 是额外的入参而不是从 raw 里读：它挂在 providerData.rawUsage 上，与
// usage 是两个不同的对象，混在一起读会让这个函数的输入形状变得含糊。
// num() 对负数返回 0，所以异常负 credit 不会把台账拉低。
function normalizeUsage(raw, credit = 0) {
  const u = raw && typeof raw === 'object' ? raw : {};
  const isAnthropicShape = u.inputTokens == null && u.input_tokens != null;
  const baseInput = num(u.inputTokens ?? u.input_tokens);
  const output = num(u.outputTokens ?? u.output_tokens);
  const total = num(u.totalTokens ?? u.total_tokens);
  // 缓存读取（cache read）
  const cachedInput = num(u.cachedInputTokens ?? u.cached_input_tokens)
    || num(u.cache_read_input_tokens ?? u.cacheReadInputTokens)
    || (Array.isArray(u.inputTokensDetails)
      ? u.inputTokensDetails.reduce((s, d) => s + num(d && d.cached_tokens), 0)
      : 0);
  // 缓存写入（cache creation）——与读取严格分开，不再混进 cachedInput
  const cacheWrite = num(u.cacheWriteInputTokens ?? u.cache_write_input_tokens)
    || num(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens);
  const reasoningOutput = num(u.reasoningOutputTokens ?? u.reasoning_output_tokens)
    || (Array.isArray(u.outputTokensDetails)
      ? u.outputTokensDetails.reduce((s, d) => s + num(d && d.reasoning_tokens), 0)
      : 0);
  // Anthropic 的 input_tokens 不含缓存部分，折算成含缓存的统一口径；
  // OpenAI 形状的 inputTokens 本就含 cached 子集，直接用。
  const input = isAnthropicShape ? baseInput + cachedInput + cacheWrite : baseInput;
  return {
    tokens: total || input + output,
    input, output, cachedInput, reasoningOutput, cacheWrite, cost: 0,
    credit: num(credit),
  };
}

// Positive component-wise delta (for streaming-correctness / re-scan safety).
function subUsage(a, b) {
  const out = {};
  for (const k of Object.keys(emptyUsage())) out[k] = Math.max(0, num(a[k]) - num(b[k]));
  return out;
}

function emptyDay() {
  return { ...emptyUsage(), msgs: 0 };
}

function addUsage(target, delta, messageDelta = 0) {
  for (const key of Object.keys(emptyUsage())) target[key] = num(target[key]) + num(delta[key]);
  target.msgs = num(target.msgs) + messageDelta;
}

function createWorkbuddyMetering(options = {}) {
  const projectsDir = options.projectsDir || PROJECTS_DIR;
  const stateDir = options.stateDir || STATE_DIR;
  const statePath = options.statePath || path.join(stateDir, 'workbuddy-usage.json');
  const pricingPaths = {
    pricingCachePath: options.pricingCachePath || PRICING_CACHE_PATH,
    pricingOverridePath: options.pricingOverridePath || PRICING_OVERRIDE_PATH,
  };

  // 实例级价表：必须用注入的 pricingPaths（此前 record() 走模块级 pricing，
  // 导致 options.pricingCachePath 形同虚设——review 发现并已修正）。
  let instancePricing = loadPricing(pricingPaths.pricingCachePath, pricingPaths.pricingOverridePath);
  function priceForInstance(model, table = instancePricing) {
    const models = (table && table._models) || {};
    const norm = normModelName(model);
    if (norm && models[norm]) return normalizePriceRow(models[norm]);
    return null;
  }

  const state = {
    schemaVersion: SCHEMA_VERSION,
    files: {},          // filePath -> { offset, carry }
    messages: {},       // messageId -> last normalized usage (dedup / streaming)
    daily: {},
    hourlyByDay: {},    // tokens per hour
    hourlyCostByDay: {},// cost per hour
    byModelByDay: {},
    lifetime: emptyDay(),
    diagnostics: { lastScanTs: 0, scannedFiles: 0, events: 0 },
  };
  let scanning = false;
  const operations = createMeterQueue();
  let dirty = false;
  let saveTimer = null;
  let timer = null;
  let loaded = false;

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (raw && typeof raw === 'object') {
        if (raw.schemaVersion !== SCHEMA_VERSION) return; // rescan from scratch
        state.files = raw.files && typeof raw.files === 'object' ? raw.files : {};
        state.messages = raw.messages && typeof raw.messages === 'object' ? raw.messages : {};
        state.daily = raw.daily && typeof raw.daily === 'object' ? raw.daily : {};
        state.hourlyByDay = raw.hourlyByDay && typeof raw.hourlyByDay === 'object' ? raw.hourlyByDay : {};
        state.hourlyCostByDay = raw.hourlyCostByDay && typeof raw.hourlyCostByDay === 'object' ? raw.hourlyCostByDay : {};
        state.byModelByDay = raw.byModelByDay && typeof raw.byModelByDay === 'object' ? raw.byModelByDay : {};
        state.lifetime = raw.lifetime && typeof raw.lifetime === 'object' ? { ...emptyDay(), ...raw.lifetime } : emptyDay();
        state.diagnostics = raw.diagnostics && typeof raw.diagnostics === 'object'
          ? { ...state.diagnostics, ...raw.diagnostics } : state.diagnostics;
      }
    } catch {}
  }

  function saveNow() {
    dirty = false;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const tmp = path.join(stateDir, `.workbuddy-usage.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch {}
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  function pruneDaily() {
    const cutoff = dayKey(Date.now() - BACKFILL_MS);
    for (const key of ['daily', 'hourlyByDay', 'hourlyCostByDay', 'byModelByDay']) {
      for (const day of Object.keys(state[key])) if (day < cutoff) delete state[key][day];
    }
    for (const [id, message] of Object.entries(state.messages)) {
      if (Number.isFinite(Number(message && message.ts))
        && Number(message.ts) < Date.now() - BACKFILL_MS) delete state.messages[id];
    }
  }

  async function listFiles(dir = projectsDir, out = []) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await listFiles(full, out);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
    return out;
  }

  function record(ts, model, usage, messageId) {
    // credit 也参与「这行有没有内容」的判断：理论上存在只有积分、没有 token 的
    // 记录（虽然本机实测没有），此时丢掉积分比多记一个 msgs 更可惜。
    if (!['input', 'output', 'cachedInput', 'reasoningOutput', 'cacheWrite', 'credit']
      .some((field) => num(usage && usage[field]) > 0)) return;
    const key = messageId || `${model}@${ts}`;
    const prev = state.messages[key];
    if (prev && !Object.keys(emptyUsage()).some((field) => num(usage[field]) > num(prev[field]))) return;
    const delta = prev ? subUsage(usage, prev) : usage;
    // A provider can revise the cache/reasoning breakdown without changing the
    // reported total. Keep those component corrections instead of dropping the
    // row solely because delta.tokens is zero.
    if (!Object.keys(emptyUsage()).some((field) => num(delta[field]) > 0)) return;
    const p = priceForInstance(model);
    const cost = p ? usageCost(delta, p) : 0;
    delta.cost = cost;

    const dayK = dayKey(ts);
    const day = (state.daily[dayK] = state.daily[dayK] || emptyDay());
    // Streaming updates reuse the same messageId. They contribute token/cost
    // deltas, but are still one assistant round rather than one round per
    // partial update.
    const messageDelta = prev ? 0 : 1;
    addUsage(day, delta, messageDelta);
    addUsage(state.lifetime, delta, messageDelta);

    const hour = new Date(ts).getHours();
    const hours = (state.hourlyByDay[dayK] = state.hourlyByDay[dayK] || new Array(24).fill(0));
    hours[hour] += delta.tokens;
    const hourCosts = (state.hourlyCostByDay[dayK] = state.hourlyCostByDay[dayK] || new Array(24).fill(0));
    hourCosts[hour] += cost;

    const models = (state.byModelByDay[dayK] = state.byModelByDay[dayK] || {});
    const modelKey = model || 'unknown';
    const row = (models[modelKey] = models[modelKey] || emptyDay());
    addUsage(row, delta, messageDelta);

    state.messages[key] = { ...usage, ts, model: model || (prev && prev.model) || 'unknown' };
    state.diagnostics.events++;
  }

  function processObject(fileState, file, o) {
    if (!o || typeof o !== 'object') return;
    const pd = o.providerData && typeof o.providerData === 'object' ? o.providerData : {};
    // 认字段不认行类型：WorkBuddy 的用量行没有 role/type === 'assistant'。
    // Prefer providerData.usage (richer: carries cached_tokens / reasoning_tokens
    // details); fall back to message.usage (Anthropic shape) only if absent.
    const usageRaw = pd.usage || (o.message && o.message.usage);
    if (!usageRaw || typeof usageRaw !== 'object') return;
    // 积分是 providerData 上的兄弟字段，不在 usage 里面（形状见文件头注释）。
    const rawUsage = pd.rawUsage && typeof pd.rawUsage === 'object' ? pd.rawUsage : null;
    const normalized = normalizeUsage(usageRaw, rawUsage ? rawUsage.credit : 0);
    if (normalized.tokens <= 0 && normalized.credit <= 0) return;
    const model = pd.model || (o.message && o.message.model) || o.model || 'unknown';
    const messageId = pd.messageId || o.id || `${o.requestId || ''}:${o.timestamp || ''}`;
    const ts = parseTimestamp(o.timestamp);
    if (fileState.replaying && ts < Date.now() - BACKFILL_MS) return;
    record(ts, model, normalized, messageId);
  }

  async function scanFile(file) {
    let stat;
    try { stat = await fsp.stat(file); } catch { return; }
    const fileState = state.files[file] || { offset: 0, carry: '' };
    if (fileState.offset > stat.size) {
      state.diagnostics.truncated = (state.diagnostics.truncated || 0) + 1;
      // JSONL transcripts are rotated by WorkBuddy. Keep the message ledger
      // for deduplication, but restart the byte cursor so rows written after
      // the rotation are not permanently skipped.
      fileState.offset = 0;
      fileState.carry = '';
      fileState.replaying = true;
    }
    if (fileState.offset === stat.size) return;
    const stream = fs.createReadStream(file, { start: fileState.offset, encoding: 'utf8' });
    let carry = fileState.carry || '';
    try {
      for await (const chunk of stream) {
        const lines = (carry + chunk).split('\n');
        carry = lines.pop() || '';
        for (const line of lines) {
          if (!line || line.charCodeAt(0) !== 123) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          try { processObject(fileState, file, o); } catch {}
        }
      }
    } catch {}
    fileState.offset = stat.size;
    fileState.carry = carry;
    fileState.replaying = false;
    state.files[file] = fileState;
  }

  async function performScan() {
    load();
    scanning = true;
    try {
      const files = (await listFiles()).sort();
      for (const file of files) {
        try { await scanFile(file); } catch {}
      }
      state.diagnostics.lastScanTs = Date.now();
      state.diagnostics.scannedFiles = files.length;
      pruneDaily();
      scheduleSave();
    } catch {
    } finally {
      scanning = false;
    }
  }

  function scan() { return operations.scan(performScan); }

  function getStats() {
    const todayKey = dayKey(Date.now());
    const today = { ...emptyDay(), ...(state.daily[todayKey] || {}) };
    const byModel = state.byModelByDay[todayKey] ? { ...state.byModelByDay[todayKey] } : {};
    for (const key of Object.keys(byModel)) byModel[key] = { ...emptyDay(), ...byModel[key] };
    return {
      today,
      lifetime: { ...emptyDay(), ...state.lifetime },
      hourlyTok: (state.hourlyByDay[todayKey] || new Array(24).fill(0)).slice(),
      hourly: (state.hourlyCostByDay[todayKey] || new Array(24).fill(0)).slice(),
      daily: Object.fromEntries(Object.entries(state.daily).map(([key, value]) => [
        key, { ...emptyDay(), ...value },
      ])),
      byModel,
      diagnostics: { ...state.diagnostics },
    };
  }

  function priceInfo() {
    let live = false;
    let ts = 0;
    let source = 'builtin';
    // 价目条数 = 内存价表的模型数（loadPricing 已合并缓存+override）。
    // 之前在这里又遍历缓存逐行累加，导致条数被重复计算约 2 倍——已修正。
    const count = Object.keys(instancePricing._models || {}).length;
    try {
      const c = JSON.parse(fs.readFileSync(pricingPaths.pricingCachePath, 'utf8'));
      if (c && c.pricing && typeof c.pricing === 'object') {
        live = true; source = 'models.dev'; ts = Number(c.ts) || 0;
      }
    } catch {}
    try { fs.accessSync(pricingPaths.pricingOverridePath); live = true; source = 'override'; } catch {}
    const stale = ts > 0 && Date.now() - ts > 48 * 60 * 60 * 1000;
    // exactOnly: we never estimate, so report estimate:false honestly.
    return { live, count, ts, source, stale, estimate: false };
  }

  // A price refresh must also update already persisted aggregates. The raw
  // message ledger is the source of truth, so rescan it with the new table.
  function reloadPricing() {
    return rebuild();
  }

  async function rebuild() {
    return operations.exclusive(async () => {
      load();
      // A missing transcript tree is a valid offline/deleted-source case, not
      // evidence that the user's accumulated ledger should be reset.
      if (!(await listFiles()).length) {
        saveNow();
        return getStats();
      }
      const oldLifetime = { ...state.lifetime };
      state.files = {};
      state.messages = {};
      state.daily = {};
      state.hourlyByDay = {};
      state.hourlyCostByDay = {};
      state.byModelByDay = {};
      state.lifetime = emptyDay();
      state.diagnostics = { lastScanTs: 0, scannedFiles: 0, events: 0 };
      instancePricing = loadPricing(pricingPaths.pricingCachePath, pricingPaths.pricingOverridePath);
      await performScan();
      state.lifetime = mergeLifetime(oldLifetime, state.lifetime);
      saveNow();
      return getStats();
    });
  }

  function start(intervalMs = 30000) {
    load();
    scan();
    timer = setInterval(scan, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  return { start, stop, scan, rebuild, getStats, priceInfo, reloadPricing, _state: state, _processObject: processObject };
}

module.exports = { createWorkbuddyMetering, normalizeUsage, priceFor, usageCost };
