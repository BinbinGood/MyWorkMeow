'use strict';

// Regression test for backend/tray-status.js —— 托盘菜单顶部的状态行。
//
// 这次改动要防的正靶：托盘菜单曾经把 Codex 写死在最上面，用户接的是别的 agent
// 时第一眼看到的仍是 Codex 账户邮箱和额度（没装 Codex 时那几行只会显示「未找到
// Codex，正在自动重试」）。所以下面既断言「该显示的显示」，也断言「不该显示的
// 一个字都不出现」。

const i18n = require('../shared/i18n');
const tray = require('../backend/tray-status');

const t = i18n.t;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

function labels(rows) {
  return rows.filter((row) => row.type !== 'separator').map((row) => row.label);
}

function flat(rows) {
  return labels(rows).join('\n');
}

// IANA 检查：托盘里出现未翻译的键名（比如 'tray.sourceTitle' 原样输出）是最容易
// 漏掉的回归，这里统一兜住。
function assertTranslated(rows, msg) {
  const text = flat(rows);
  assert(!/tray\.[a-zA-Z]/.test(text), `${msg} (no untranslated i18n keys leak)`);
}

// ── 格式化 ────────────────────────────────────────────────────────────────────
assert(tray.compact(0) === '0', 'compact(0)');
assert(tray.compact(999) === '999', 'compact keeps small numbers exact');
assert(tray.compact(1000) === '1K', 'compact uses K');
assert(tray.compact(1_234_567) === '1.2M', 'compact uses M with one decimal below 100');
assert(tray.compact(55_060_264) === '55.1M', 'compact handles real token counts');
assert(tray.compact(123_000_000) === '123M', 'compact drops the decimal at 100+');
assert(tray.money(0) === null, 'money hides a zero cost (hy3 has no public price)');
assert(tray.money(1.016709612) === '$1.02', 'money formats to cents');
assert(tray.money(150.4) === '$150', 'money drops cents above 100');
assert(tray.creditText(0) === null, 'creditText hides a zero credit');
assert(tray.creditText(63.82) === '63.8', 'creditText keeps one decimal');
assert(tray.creditText(1734.43) === '1734', 'creditText drops the decimal above 1000');
assert(tray.contextText(null) === null, 'contextText tolerates null');
assert(tray.contextText({ used: 0, size: 300000 }) === null, 'contextText needs a positive used');
assert(JSON.stringify(tray.contextText({ used: 219254, size: 300000 }))
  === JSON.stringify({ used: '219K', size: '300K', percent: '73' }), 'contextText renders used/size/percent');
assert(tray.contextText({ used: 400000, size: 300000 }).percent === '100', 'contextText clamps the percent');

// ── 行生成 ────────────────────────────────────────────────────────────────────
const workbuddy = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  detected: true,
  tokens: 55_060_264,
  msgs: 427,
  cost: 1.2521,
  credit: 63.82,
  lifetimeTokens: 282_013_281,
  lifetimeCredit: 1734.43,
  context: { used: 219254, size: 300000 },
};

const rows = tray.buildStatusRows({ sources: [workbuddy], codexRows: [], codexReady: false, t });
assert(rows[0].label === 'WorkBuddy　今日', `no leading separator, the group header is first (got ${rows[0].label})`);
assert(rows.every((row) => row.type !== 'separator'), 'a single source needs no separator at all');
assertTranslated(rows, 'source group renders');
const text = flat(rows);
assert(text.includes('55.1M') && text.includes('427 轮'), 'today tokens + rounds are shown');
assert(text.includes('$1.25'), 'estimated cost is shown when positive');
assert(text.includes('63.8') && text.includes('1734'), 'credit shows today + lifetime');
assert(text.includes('219K / 300K') && text.includes('73%'), 'context water level is shown');
assert(!/Codex/.test(text), 'no Codex row when Codex is not ready — this is the bug being fixed');
assert(rows.every((row) => row.type === 'separator' || row.enabled === false),
  'all status rows are non-clickable info rows');

// 未接入的来源绝不出现
const withCodexOff = tray.buildStatusRows({
  sources: [workbuddy, { id: 'codex', label: 'Codex', detected: false, tokens: 0, lifetimeTokens: 0 }],
  codexRows: [{ label: 'Codex　账户 a***@example.com' }],
  codexReady: false,
  t,
});
assert(!/Codex/.test(flat(withCodexOff)),
  'a detected:false source is dropped even if rows were supplied for it');

// 装了 Codex 且额度可用时，额度块必须回来（别把功能一起删掉）
const withCodex = tray.buildStatusRows({
  sources: [workbuddy],
  codexRows: [{ label: 'Codex　账户 a***@example.com · Plus', enabled: false }],
  codexReady: true,
  t,
});
assert(/Codex　账户/.test(flat(withCodex)), 'the Codex quota block still renders when Codex is present');
assert(labels(withCodex)[0] === 'WorkBuddy　今日',
  'codexRows are appended after the source groups, not pinned to the top');
assert(withCodex.some((row) => row.type === 'separator'), 'blocks are separated from each other');

// 装过但从未产生用量 → 不占位
const neverUsed = tray.buildStatusRows({
  sources: [{ id: 'trae', label: 'TRAE', detected: true, tokens: 0, lifetimeTokens: 0 }],
  codexReady: false,
  t,
});
assert(labels(neverUsed).length === 1 && labels(neverUsed)[0] === t('tray.noSources'),
  'a detected but never-used source falls back to the "no sources" line');
assertTranslated(neverUsed, 'the empty state renders');

// 什么都没接入
const empty = tray.buildStatusRows({ sources: [], codexReady: false, t });
assert(empty.length === 1 && empty[0].label === t('tray.noSources'), 'the empty state is a single line');
const emptyNoT = tray.buildStatusRows({});
assert(emptyNoT.length === 1, 'buildStatusRows tolerates a missing t function');

// 排序 + 上限
const many = tray.buildStatusRows({
  sources: [
    { id: 'a', label: 'A', detected: true, tokens: 10, lifetimeTokens: 10 },
    { id: 'b', label: 'B', detected: true, tokens: 300, lifetimeTokens: 300 },
    { id: 'c', label: 'C', detected: true, tokens: 200, lifetimeTokens: 200 },
    { id: 'd', label: 'D', detected: true, tokens: 100, lifetimeTokens: 100 },
  ],
  codexReady: false,
  t,
});
const order = labels(many).filter((l) => l.endsWith('今日')).map((l) => l[0]);
assert(order.length === tray.MAX_SOURCES, `at most ${tray.MAX_SOURCES} source groups (got ${order.length})`);
assert(order.join('') === 'BCD', `most-used source first (got ${order.join('')})`);

assert(tray.isReportable({ detected: true, lifetimeCredit: 5 }) === true,
  'a credit-only source is reportable');
assert(tray.isReportable({ detected: false, lifetimeTokens: 10 }) === false,
  'an undetected source is never reportable');

// 每个新文案键都必须真的存在于词典里
for (const key of ['tray.sourceTitle', 'tray.sourceTokens', 'tray.sourceCost',
  'tray.sourceCredit', 'tray.sourceContext', 'tray.noSources']) {
  assert(typeof t(key) === 'string' && t(key) !== key, `i18n has ${key}`);
}

console.log('\nTRAY STATUS TESTS PASSED');
