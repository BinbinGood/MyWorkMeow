'use strict';

// Regression test for backend/workbuddy-metering.js.
// Uses temp dirs only (no real ~/.workbuddy / ~/.workmeow), and exercises:
//  - real token counting from providerData.usage (OpenAI camelCase)
//  - cached_tokens extracted from inputTokensDetails
//  - exact-only pricing: a priced model gets cost>0, an unknown model (hy3) gets $0

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { createWorkbuddyMetering } = require('../backend/workbuddy-metering');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

async function main() {
  // 用「今天」构造时间戳，避免硬编码日期跨午夜后 today 桶错位。
  const _n = new Date();
  const todayTs = (h) => `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;
  const historicalTs = Date.now() - 2 * 24 * 60 * 60 * 1000;

  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-meter-test-'));
  const projects = path.join(base, 'projects', 'proj-x', 'sess-1');
  await fsp.mkdir(projects, { recursive: true });
  const jsonl = path.join(projects, 'a.jsonl');

  const lines = [
    // hy3 line (unknown model → should cost $0), with cached tokens in details
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: todayTs(10),
      providerData: {
        model: 'hy3', messageId: 'm1',
        usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050,
          inputTokensDetails: [{ cached_tokens: 900 }], outputTokensDetails: [{ reasoning_tokens: 5 }] },
      },
    }),
    // priced model line (gpt-4o present in temp cache → cost>0)
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: todayTs(11),
      providerData: {
        model: 'gpt-4o', messageId: 'm2',
        usage: { inputTokens: 2000, outputTokens: 100, totalTokens: 2100,
          inputTokensDetails: [{ cached_tokens: 0 }], outputTokensDetails: [] },
      },
    }),
    // a non-assistant line that must be ignored
    JSON.stringify({ type: 'message', role: 'user', content: 'hi' }),
    // Anthropic 形状（message.usage）：cache_creation 是缓存「写入」，
    // cache_read 是缓存「读取」——两者必须分开计价，且 input 折算为含缓存口径。
    // 价目（下方 models.claude-x）：input 3 / output 15 / cachedInput 0.3 / cacheWrite5m 3.75
    // regularInput = (100+200+50) - 50 - 200 = 100
    // cost = 100*3 + 40*15 + 50*0.3 + 200*3.75 = 300+600+15+750 = 1665 /1e6
    JSON.stringify({
      type: 'assistant', timestamp: todayTs(12),
      message: {
        id: 'msg-a1', model: 'claude-x',
        usage: { input_tokens: 100, output_tokens: 40,
          cache_creation_input_tokens: 200, cache_read_input_tokens: 50 },
      },
    }),
    // WorkBuddy writes numeric Unix milliseconds in real transcripts. This
    // old row must stay in its source day instead of being moved to scan time.
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: historicalTs,
      providerData: {
        model: 'old-workbuddy-model', messageId: 'historical-m1',
        usage: { inputTokens: 700, outputTokens: 30, totalTokens: 730 },
      },
    }),
  ];
  await fsp.writeFile(jsonl, lines.join('\n') + '\n', 'utf8');

  // temp pricing cache: only gpt-4o is known (no hy3)
  const cache = {
    ts: Date.now(), source: 'test', url: '',
    pricing: {},
    models: { 'gpt-4o': { input: 2.5, output: 10, cachedInput: 1.25 },
      'claude-x': { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75 } },
  };
  const cachePath = path.join(base, 'pricing-cache.json');
  await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');

  // Simulate the pre-v6 ledger that incorrectly put all numeric-timestamp
  // rows into today's bucket. Loading it must trigger the automatic rebuild.
  const todayKey = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, '0')}-${String(_n.getDate()).padStart(2, '0')}`;
  await fsp.writeFile(path.join(base, 'workbuddy-usage.json'), JSON.stringify({
    schemaVersion: 5,
    daily: { [todayKey]: { tokens: 999999, msgs: 99 } },
    byModelByDay: { [todayKey]: { 'stale-model': { tokens: 999999, msgs: 99 } } },
  }), 'utf8');

  const m = createWorkbuddyMetering({
    projectsDir: path.join(base, 'projects'),
    stateDir: base,
    pricingCachePath: cachePath,
    pricingOverridePath: path.join(base, 'no-override.json'),
  });
  await m.scan();
  const s = m.getStats();

  assert(s.today.tokens === 3150 + 390, `today tokens summed (got ${s.today.tokens})`);
  assert(s.today.input === 3000 + 350 && s.today.output === 150 + 40, 'input/output summed');
  assert(s.today.cachedInput === 950, `cached read tokens (got ${s.today.cachedInput})`);
  assert(s.today.cacheWrite === 200, `cache write tokens split from read (got ${s.today.cacheWrite})`);
  assert(s.today.reasoningOutput === 5, `reasoning tokens (got ${s.today.reasoningOutput})`);

  const by = s.byModel;
  assert(by.hy3 && by['gpt-4o'] && by['claude-x'], 'all three models present in byModel');
  assert(!by['old-workbuddy-model'], 'numeric historical timestamp is not counted as today');
  const historicalDay = new Date(historicalTs);
  const historicalKey = `${historicalDay.getFullYear()}-${String(historicalDay.getMonth() + 1).padStart(2, '0')}-${String(historicalDay.getDate()).padStart(2, '0')}`;
  assert(s.daily[historicalKey] && s.daily[historicalKey].tokens === 730,
    'numeric historical timestamp stays in its original day');
  assert(by.hy3.cost === 0, `hy3 has no price → cost $0 (got ${by.hy3.cost})`);
  // gpt-4o: 2000 input (2000*2.5=5000) + 100 output (100*10=1000) = 6000 /1e6 = 0.006
  assert(by['gpt-4o'].cost > 0, `gpt-4o priced → cost>0 (got ${by['gpt-4o'].cost})`);
  // Anthropic 形状：缓存写入按 cacheWrite5m 价、缓存读取按 cacheRead 价
  const expectedAnth = 1665 / 1e6;
  assert(Math.abs(by['claude-x'].cost - expectedAnth) < 1e-9,
    `anthropic-shape cache write/read priced separately (got ${by['claude-x'].cost}, want ${expectedAnth})`);

  // exact-only: priceInfo must NOT report estimate
  const pi = m.priceInfo();
  assert(pi.estimate === false, 'priceInfo.estimate is false (no estimation policy)');

  // Streaming correction: the same messageId may report a larger cumulative
  // total later, but it must remain one assistant round.
  m._processObject({}, jsonl, {
    type: 'message', role: 'assistant', timestamp: todayTs(11),
    providerData: {
      model: 'gpt-4o', messageId: 'm2',
      usage: { inputTokens: 2100, outputTokens: 100, totalTokens: 2200 },
    },
  });
  const streamed = m.getStats();
  assert(streamed.today.tokens === 3640, `streaming delta added once (got ${streamed.today.tokens})`);
  assert(streamed.today.msgs === 3, `streaming update does not add a round (got ${streamed.today.msgs})`);

  // Reloading pricing must rebuild existing history, not only change the
  // in-memory lookup for future messages.
  cache.models.hy3 = { input: 1, output: 2, cachedInput: 0.1 };
  await fsp.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  await m.reloadPricing();
  const repriced = m.getStats();
  assert(repriced.byModel.hy3.cost > 0, `pricing reload reprices history (got ${repriced.byModel.hy3.cost})`);
  assert(repriced.today.msgs === 3, `rebuild keeps one round per message (got ${repriced.today.msgs})`);

  // idempotent re-scan must not double count
  await m.scan();
  const s2 = m.getStats();
  assert(s2.today.tokens === 3540, `re-scan does not double count (got ${s2.today.tokens})`);

  // A rotated transcript must reset its cursor. Existing message ids remain
  // deduped, while a new message appended to the shorter file is counted.
  await fsp.writeFile(jsonl, lines[0] + '\n' + JSON.stringify({
    type: 'message', role: 'assistant', timestamp: todayTs(13),
    providerData: { model: 'gpt-4o', messageId: 'm-rotated', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  }) + '\n', 'utf8');
  await m.scan();
  assert(m.getStats().today.tokens === 3555, `rotated transcript resumes from byte zero (got ${m.getStats().today.tokens})`);
  const lifetimeBeforeRebuild = m.getStats().lifetime.tokens;
  await fsp.writeFile(jsonl, lines[0] + '\n', 'utf8');
  await m.rebuild();
  assert(m.getStats().lifetime.tokens >= lifetimeBeforeRebuild,
    'rebuild preserves WorkBuddy lifetime when a rotated source is incomplete');

  // ── 真实 WorkBuddy 行形状（2026-09 本机实测）──────────────────────────────
  // 一次模型请求落成 type:'function_call'（要工具）或 type:'message'（文本回复），
  // 转录里**没有** role/type === 'assistant' 的行。usage 挂在 providerData.usage
  // 上，同一行还带一份数值等价的 message.usage —— 必须只算一次。
  // 旧实现要求 role/type === 'assistant'，所以真实数据上用量恒为 0。
  const realBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'wb-real-'));
  const realDir = path.join(realBase, 'projects', 'Users-binbin-WorkBuddy-2026-09-15-20-00-26');
  await fsp.mkdir(realDir, { recursive: true });
  const nowMs = Date.now();
  await fsp.writeFile(path.join(realDir, 'sess.jsonl'), [
    JSON.stringify({
      id: 'gen-1', type: 'function_call', timestamp: nowMs - 60_000,
      providerData: {
        model: 'hy4-preview', messageId: 'real-m1',
        usage: {
          requests: 1, inputTokens: 38243, outputTokens: 280, totalTokens: 38523,
          inputTokensDetails: [{ cached_tokens: 24832 }],
          outputTokensDetails: [{ reasoning_tokens: 191 }],
        },
      },
      message: { usage: { input_tokens: 38243, output_tokens: 280, total_tokens: 38523, cache_read_input_tokens: 24832 } },
    }),
    JSON.stringify({
      id: 'gen-2', type: 'message', timestamp: nowMs - 30_000,
      providerData: {
        model: 'deepseek-v4-flash', messageId: 'real-m2',
        usage: { requests: 1, inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
      },
      message: { usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 } },
    }),
    // 不带 usage 的行必须被忽略
    JSON.stringify({ id: 'r1', type: 'reasoning', timestamp: nowMs - 20_000, text: 'thinking…' }),
    JSON.stringify({ id: 'r2', type: 'function_call_result', timestamp: nowMs - 10_000, callId: 'c1' }),
  ].join('\n') + '\n', 'utf8');

  const real = createWorkbuddyMetering({
    projectsDir: path.join(realBase, 'projects'),
    stateDir: realBase,
    pricingCachePath: path.join(realBase, 'absent-cache.json'),
    pricingOverridePath: path.join(realBase, 'absent-override.json'),
  });
  await real.scan();
  const rs = real.getStats();
  assert(rs.today.tokens === 39623, `real function_call/message rows counted (got ${rs.today.tokens})`);
  assert(rs.today.msgs === 2, `one round per usage row (got ${rs.today.msgs})`);
  assert(rs.today.cachedInput === 24832, `cached_tokens read from inputTokensDetails (got ${rs.today.cachedInput})`);
  assert(rs.today.reasoningOutput === 191, `reasoning_tokens counted (got ${rs.today.reasoningOutput})`);
  assert(rs.today.input === 39243, `input not double counted through message.usage (got ${rs.today.input})`);
  assert(rs.byModel['hy4-preview'] && rs.byModel['deepseek-v4-flash'], 'model read from providerData.model');
  // 幂等：再扫一次不能翻倍
  await real.scan();
  assert(real.getStats().today.tokens === 39623, `re-scan of real-shaped rows stays idempotent (got ${real.getStats().today.tokens})`);
  await fsp.rm(realBase, { recursive: true, force: true });

  // cleanup
  await fsp.rm(base, { recursive: true, force: true });
  console.log('\nALL WORKBUDDY-METERING TESTS PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
