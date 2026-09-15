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
assert(tray.creditText(0) === null, 'creditText hides a zero credit');
assert(tray.creditText(63.82) === '63.8', 'creditText keeps one decimal');
assert(tray.creditText(1734.43) === '1734', 'creditText drops the decimal above 1000');
assert(tray.money(0) === null, 'money hides a zero cost (hy3 has no public price)');
assert(tray.money(1.016709612) === '$1.02', 'money formats to cents');
assert(tray.money(150.4) === '$150', 'money drops cents above 100');
// 剩余额度与「今日消耗」的关键差别：0 是**有效值**（额度确实用尽），必须显示出来。
// 而 null 表示「用户还没填每期额度」，必须隐藏。这俩不能混 —— 注意
// Number(null) === 0，所以 quotaText 必须先做 null 判断再转数字。
assert(tray.quotaText(null) === null, 'quotaText hides an unset quota');
assert(tray.quotaText(undefined) === null, 'quotaText hides an undefined quota');
assert(tray.quotaText('') === null, 'quotaText hides an empty quota');
assert(tray.quotaText(0) === '0', 'quotaText KEEPS a real zero — the quota is genuinely exhausted');
assert(tray.quotaText(1512.4) === '1512', 'quotaText formats a large remainder');
assert(tray.quotaText(-5) === null, 'quotaText rejects a negative quota');

// ── 行生成 ────────────────────────────────────────────────────────────────────
const workbuddy = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  detected: true,
  tokens: 55_060_264,
  msgs: 427,             // 仍然喂进来，但应当被忽略（轮次已从口径里去掉）
  cost: 1.2521,
  credit: 63.82,
  creditRemaining: 1512.4,
  lifetimeTokens: 282_013_281,
  lifetimeCredit: 1734.43,
};

const rows = tray.buildStatusRows({ sources: [workbuddy], codexRows: [], codexReady: false, t });
assert(rows[0].label === 'WorkBuddy　今日', `no leading separator, the group header is first (got ${rows[0].label})`);
assert(rows.every((row) => row.type !== 'separator'), 'a single source needs no separator at all');
assertTranslated(rows, 'source group renders');
const text = flat(rows);
assert(text.includes('55.1M'), 'today tokens are shown');
assert(/Token/.test(text), 'the token unit reads Token, not 令牌');
assert(!/令牌/.test(text), 'the old 令牌 wording is gone');
assert(!/轮/.test(text) && !/427/.test(text), 'rounds are gone from the row (and msgs is ignored)');
assert(text.includes('$1.25'), 'estimated cost is back, shown when positive');
// Token 与费用必须在**同一行** —— 用户要求合并，分成两行就回归了。
const usageRow = labels(rows).find((l) => /Token/.test(l));
assert(/\$1\.25/.test(usageRow), `cost shares the Token row (got ${usageRow})`);
assert(/费用/.test(usageRow), 'the row says 费用, not 等价费用');
assert(!/等价费用/.test(text), 'the old 等价费用 wording is gone');
assert(text.includes('63.8') && text.includes('1512'), 'credit shows today + remaining');
assert(!/累计/.test(text) && !/1734/.test(text), 'the lifetime credit is no longer printed');
assert(!/上下文/.test(text), 'no context water level row — removed by request');
assert(labels(rows).length === 3, `a group is header + usage + credit (got ${labels(rows).length} rows)`);
assert(!/Codex/.test(text), 'no Codex row when Codex is not ready — this is the bug being fixed');
assert(rows.every((row) => row.type === 'separator' || row.enabled === false),
  'all status rows are non-clickable info rows');

// 没填每期额度时（creditRemaining === null），「剩余」那一段整体不出现，
// 只留今日消耗 —— 而不是显示一个会被读成「额度用完了」的 0。
const noQuota = tray.buildStatusRows({
  sources: [{ id: 'w', label: 'W', detected: true, tokens: 1000, credit: 12.5, lifetimeTokens: 1000 }],
  codexReady: false,
  t,
});
assert(/积分　12.5/.test(flat(noQuota)) && !/剩余/.test(flat(noQuota)),
  'an unset quota drops the 剩余 segment instead of printing 0');

// 反过来：今日积分为 0（hy3）但填了额度时，只显示剩余。
const leftOnly = tray.buildStatusRows({
  sources: [{ id: 'w', label: 'W', detected: true, tokens: 1000, credit: 0, creditRemaining: 1400, lifetimeTokens: 1000 }],
  codexReady: false,
  t,
});
assert(/积分　剩余 1400/.test(flat(leftOnly)) && !/积分　0/.test(flat(leftOnly)),
  'a zero today-credit still shows the remaining quota, without printing 积分 0');

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

// 装了 Codex 但额度还没到手：整块 5h/7d 不画（没数字的占位是噪音），但必须留**一行**
// 说明额度归它 —— 否则设置页那一项写着「Codex 订阅额度」、托盘却只有 WorkBuddy 的
// 今日用量，用户看到的是「两处对不上」（2026-09-15 反馈）。
const codexPending = tray.buildStatusRows({
  sources: [workbuddy],
  codexReady: false,
  codexPending: true,
  codexPendingRows: [{ label: t('tray.quotaPending', { status: t('tray.quotaStatusUnavailable') }), enabled: false }],
  t,
});
assert(/Codex/.test(flat(codexPending)), 'a detected-but-unready Codex still gets one line in the tray');
assert(labels(codexPending).length === 4,
  `header + usage + credit + the one Codex line (got ${labels(codexPending).length})`);
assert(codexPending.some((row) => row.type === 'separator'),
  'the pending Codex line is its own block, separated from the sources');
assertTranslated(codexPending, 'the pending Codex line renders');

// 额度到手后只画整块，不能两行同时出现
const readyWins = tray.buildStatusRows({
  sources: [workbuddy],
  codexReady: true,
  codexPending: true,
  codexRows: [{ label: 'Codex　账户 a***@example.com · Plus' }],
  codexPendingRows: [{ label: 'Codex　额度暂不可用' }],
  t,
});
assert(/账户/.test(flat(readyWins)) && !/暂不可用/.test(flat(readyWins)),
  'the ready quota block replaces the pending line');

// 没接 Codex：pending 行给了也不许出现（防止「插一行就冒一行」）
const noCodexPending = tray.buildStatusRows({
  sources: [workbuddy],
  codexReady: false,
  codexPending: false,
  codexPendingRows: [{ label: 'Codex　额度暂不可用' }],
  t,
});
assert(!/Codex/.test(flat(noCodexPending)), 'pending rows need the explicit codexPending flag');

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

// ── 额度槽位归谁 ──────────────────────────────────────────────────────────────
// 正靶：早先要求 Codex 的额度「已经就绪」才归它，于是额度拉取中/失败的那段时间
// 槽位会落到别的 Agent 上 —— 设置页那一项就写成别的名字，用户看到的是
// 「我用的是 Codex，选项怎么没了」。
const wbSource = { id: 'workbuddy', label: 'WorkBuddy' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
assert(same(tray.slotOwner({ codexDetected: true, codexReady: true, creditSource: wbSource }),
  { kind: 'codex', id: 'codex', label: 'Codex', ready: true }),
'an installed Codex owns the slot');
assert(same(tray.slotOwner({ codexDetected: true, codexReady: false, creditSource: wbSource }),
  { kind: 'codex', id: 'codex', label: 'Codex', ready: false }),
'Codex keeps the slot BEFORE its quota arrives — this is the reported bug');
assert(same(tray.slotOwner({ codexDetected: true, codexReady: false }),
  { kind: 'codex', id: 'codex', label: 'Codex', ready: false }),
'Codex owns the slot even with no credit source to fall back to');
assert(same(tray.slotOwner({ codexDetected: false, codexReady: true, creditSource: wbSource }),
  { kind: 'credit', id: 'workbuddy', label: 'WorkBuddy', ready: true }),
'with no Codex installed the credit source takes the slot');
assert(same(tray.slotOwner({ codexDetected: false }),
  { kind: 'none', id: null, label: null, ready: false }),
'nothing detected → the slot is empty, not someone else\'s shell');
assert(tray.slotOwner({ creditSource: { label: 'no id' } }).kind === 'none',
  'a credit source without an id cannot own the slot');
assert(tray.slotOwner().kind === 'none', 'slotOwner tolerates no input');

// 每个新文案键都必须真的存在于词典里
for (const key of ['tray.sourceTitle', 'tray.sourceTokens', 'tray.sourceUsage',
  'tray.sourceCredit', 'tray.sourceCreditUsed', 'tray.sourceCreditLeft', 'tray.noSources',
  'tray.quotaPending']) {
  assert(typeof t(key) === 'string' && t(key) !== key, `i18n has ${key}`);
}

// 上一轮删掉的键不能悄悄复活
for (const gone of ['tray.sourceContext', 'tray.sourceCost']) {
  assert(t(gone) === gone, `${gone} is gone from the dictionary`);
}

// 积分为 0 且没填额度的数据源（WorkBuddy 的默认模型 hy3 就是这种）不该出现积分行
const noCredit = tray.buildStatusRows({
  sources: [{ id: 'a', label: 'A', detected: true, tokens: 1000, msgs: 2, lifetimeTokens: 1000 }],
  codexReady: false,
  t,
});
assert(labels(noCredit).length === 2 && !/积分/.test(flat(noCredit)),
  'no credit and no quota drops the credit row entirely');
// 费用为 0 时那一行退化成纯 Token —— 既不能出现 $0.00，也不要留个「费用 --」
const usageOnly = labels(noCredit).find((l) => /Token/.test(l));
assert(!/\$/.test(usageOnly) && !/费用/.test(usageOnly),
  `a zero cost leaves the row as bare Token (got ${usageOnly})`);

console.log('\nTRAY STATUS TESTS PASSED');
