'use strict';

// Regression test for backend/tray-status.js —— 托盘菜单顶部的状态行。
//
// 这一版要守的口径（2026-09-15 用户定的）：
//   1. **检测到**的 Agent 各占一段，不管今天有没有用量 —— 位置从此固定
//   2. 不排序、不截断 —— 顺序就是注册表顺序，有几个显示几个
//   3. 没有「额度槽位归谁」的概念 —— 每个 Agent 显示自己的额度
//   4. 一个 Agent 的信息拼成一行，超过宽度上限在**片段边界**折行
//   5. 暂时拿不到数字时不删行，改留一行状态文字
//
// 要防的正靶：以前托盘按「今天有没有用量」过滤、还只留前三名，于是设置页写着
// Codex、托盘里却只有 WorkBuddy —— 用户看到的是「两处对不上」。

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

// IANA 检查：托盘里出现未翻译的键名（比如 'tray.rowCredit' 原样输出）是最容易
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

// ── 显示宽度 ──────────────────────────────────────────────────────────────────
// 折行完全建立在这个度量之上，先把它钉死：汉字/全角标点 = 2 列，ASCII = 1 列。
assert(tray.displayWidth('abc') === 3, 'ASCII counts one column');
assert(tray.displayWidth('今日') === 4, 'CJK counts two columns');
assert(tray.displayWidth('　') === 2, 'the ideographic space counts two columns');
assert(tray.displayWidth('5h　82%') === 7, 'mixed width adds up (5h=2 + 全角空格=2 + 82%=3)');
assert(tray.displayWidth(null) === 0, 'displayWidth tolerates null');
// 旧区符号（U+2600–U+27BF）的宽度：2026-09-16 之前 isWideCodePoint 从 0x1F300
// 起算，把 ✋ ⚙ ✅ 都判成 1 列 —— 折行预算算虚了，行会实际超宽。
// 而 ⚙️ 是 U+2699 + U+FE0F 两个码位，变体选择符本身不占位。
assert(tray.displayWidth('✋') === 2, 'U+270B is two columns (below the old 1F300 floor)');
assert(tray.displayWidth('✅') === 2, 'U+2705 is two columns');
assert(tray.displayWidth('⚙️') === 2, 'the variation selector in ⚙️ adds no column');
assert(tray.displayWidth('🌿') === 2, 'U+1F33F is two columns');
assert(tray.displayWidth('💤') === 2, 'U+1F4A4 is two columns');

// ── 行生成：本机真实形态 ──────────────────────────────────────────────────────
const workbuddy = {
  id: 'workbuddy',
  label: 'WorkBuddy',
  detected: true,
  tokens: 222_000_000,
  cost: 3.55,
  quota: { kind: 'credit', ready: true, remaining: 1696 },
};

const rows = tray.buildStatusRows({ agents: [workbuddy], t });
assert(rows.length === 2, `a single agent wraps into 2 lines (got ${rows.length})`);
assert(rows[0].label === 'WorkBuddy　积分剩余 1696', `first line starts with the name (got ${rows[0].label})`);
assert(rows[1].label.startsWith('Token'), 'continuation lines are flush-left (no indent)');
assert(tray.displayWidth(rows[1].label) <= tray.ROW_WIDTH_LIMIT,
  `continuation stays within the width budget (got ${tray.displayWidth(rows[1].label)})`);
assertTranslated(rows, 'the agent block renders');
const text = flat(rows);
assert(text.includes('222M'), 'today tokens are shown');
assert(/Token/.test(text) && !/令牌/.test(text), 'the unit reads Token, not 令牌');
assert(text.includes('$3.55'), 'estimated cost is shown when positive');
assert(text.includes('1696'), 'remaining credit is shown');
assert(rows.every((row) => row.enabled === false), 'status rows are non-clickable info rows');

// 顺序不再被改动 —— 上一版会按用量排序，那正是「昨天在第一行、今天在第三行」的来源
const unsortedInput = [
  { id: 'a', label: 'A', detected: true, tokens: 10, quota: null },
  { id: 'b', label: 'B', detected: true, tokens: 999_999, quota: null },
  { id: 'c', label: 'C', detected: true, tokens: 1, quota: null },
];
assert(flat(tray.buildStatusRows({ agents: unsortedInput, t })).indexOf('A')
  < flat(tray.buildStatusRows({ agents: unsortedInput, t })).indexOf('B'),
'the input order is preserved — no re-sorting by usage');

// 也不再截断 —— 上一版最多只显示三个
const fourAgents = ['A', 'B', 'C', 'D'].map((label, i) => ({
  id: label.toLowerCase(), label, detected: true, tokens: 10 * (i + 1), quota: null,
}));
const fourText = flat(tray.buildStatusRows({ agents: fourAgents, t }));
for (const label of ['A', 'B', 'C', 'D']) {
  assert(fourText.includes(`${label}　`), `${label} still gets a row with four agents — nothing is truncated`);
}

// 未接入的来源绝不出现
const withCodexOff = tray.buildStatusRows({
  agents: [workbuddy, { id: 'codex', label: 'Codex', detected: false, tokens: 0, quota: null }],
  t,
});
assert(!/Codex/.test(flat(withCodexOff)), 'a detected:false agent is dropped');

// ── 折行 ──────────────────────────────────────────────────────────────────────
// 折行只在片段边界发生：宁可让一个超长片段独占一行，也不把「正在自动重试」
// 这种词从中间切开。
const longStatus = tray.agentLines({
  id: 'x', label: 'X', detected: true, tokens: 0, cost: 0,
  quota: { kind: 'codex', ready: false, status: '未找到 Codex，正在自动重试', windows: [] },
}, t);
assert(longStatus.length === 1, 'an over-wide part gets its own line instead of being chopped');
assert(!longStatus[0].endsWith('　') && !/　$/.test(longStatus[0]), 'no trailing separator on a single-part line');

// limit 真的生效
const narrow = tray.agentLines(workbuddy, t, 10);
assert(narrow.every((line, i) => i === 0 || !line.startsWith('　')),
  'every continuation line is flush-left (no indent)');
assert(narrow.length > 2, `a tight limit forces more lines (got ${narrow.length})`);

// 片段顺序固定：额度 → Token → 费用
const parts = tray.agentParts(workbuddy, t);
assert(parts.length === 3, `credit + tokens + cost (got ${parts.length})`);
assert(/积分/.test(parts[0]) && /Token/.test(parts[1]) && /费用/.test(parts[2]),
  'parts are ordered quota → tokens → cost');
assertTranslated(tray.buildStatusRows({ agents: [workbuddy], t }), 'the ordered parts render');

// ── 无数据时不删行 ────────────────────────────────────────────────────────────
// 「检测到但今天还没用量」也算有效 —— 用户明确要求「有几个有效就显示几个」，
// 所以退化成「暂无数据」，而不是整段消失。
const neverUsed = tray.buildStatusRows({
  agents: [{ id: 'trae', label: 'TRAE', detected: true, tokens: 0, cost: 0, quota: null }],
  t,
});
assert(labels(neverUsed).length === 1, 'a detected agent with no data still gets one line');
assert(labels(neverUsed)[0] === `TRAE　${t('tray.rowNoData')}`,
  `it says TRAE + no-data (got ${labels(neverUsed)[0]})`);
assertTranslated(neverUsed, 'the no-data line renders');

// 积分型但没填每期总量：保留整行，说清楚为什么没有数字。
// 关键是不能打印「积分剩余 0」—— 那会被读成「额度用完了」。
const creditUnset = tray.buildStatusRows({
  agents: [{ id: 'w', label: 'W', detected: true, tokens: 1000, cost: 0, quota: { kind: 'credit', ready: false, remaining: null } }],
  t,
});
assert(!/剩余\s*0/.test(flat(creditUnset)), 'an unset credit quota never prints 剩余 0');
assert(flat(creditUnset).includes(t('tray.rowCreditUnset')), 'it says the per-cycle total is unset');

// 反过来：剩余真的是 0（额度确实用尽）必须显示出来
const creditExhausted = tray.buildStatusRows({
  agents: [{ id: 'w', label: 'W', detected: true, tokens: 0, cost: 0, quota: { kind: 'credit', ready: true, remaining: 0 } }],
  t,
});
assert(/剩余 0/.test(flat(creditExhausted)), 'a genuinely exhausted quota prints 剩余 0');

// ── Codex：就绪 vs 未就绪 ─────────────────────────────────────────────────────
const codexReady = tray.buildStatusRows({
  agents: [{
    id: 'codex', label: 'Codex', detected: true, tokens: 1_234_567, cost: 2.1,
    quota: { kind: 'codex', ready: true, status: null, windows: [{ label: '5h', percent: 82 }, { label: '7d', percent: 64 }] },
  }],
  t,
});
assert(/5h\s*82%/.test(flat(codexReady)) && /7d\s*64%/.test(flat(codexReady)),
  'a ready Codex shows its 5h / 7d windows');

// 装了 Codex 但额度还没到手：留一行状态，不整块消失 —— 这正是用户最初提的问题
// （设置页写着 Codex、托盘里找不到它）。
const codexPending = tray.buildStatusRows({
  agents: [{
    id: 'codex', label: 'Codex', detected: true, tokens: 0, cost: 0,
    quota: { kind: 'codex', ready: false, status: t('tray.quotaStatusCodexMissing'), windows: [] },
  }],
  t,
});
assert(/Codex/.test(flat(codexPending)), 'a detected-but-unready Codex still gets its line');
assertTranslated(codexPending, 'the pending Codex line renders');

// 多个 Agent 之间插分隔线 —— 折行之后光看行首不容易分辨归属
const two = tray.buildStatusRows({
  agents: [
    workbuddy,
    { id: 'codex', label: 'Codex', detected: true, tokens: 0, cost: 0, quota: { kind: 'codex', ready: false, status: 'pending', windows: [] } },
  ],
  t,
});
assert(two.filter((row) => row.type === 'separator').length === 1,
  'one separator between two agent blocks, none before the first');

// ── 空态 ──────────────────────────────────────────────────────────────────────
const empty = tray.buildStatusRows({ agents: [], t });
assert(empty.length === 1 && empty[0].label === t('tray.noSources'), 'the empty state is a single line');
const emptyNoT = tray.buildStatusRows({});
assert(emptyNoT.length === 1, 'buildStatusRows tolerates a missing t function');
const emptyNoAgents = tray.buildStatusRows({ agents: [{ id: 'x', label: 'X', detected: false }], t });
assert(emptyNoAgents.length === 1, 'agents that are all undetected fall back to the empty line');
// 「都关了」和「没接入」是两种空态，解法不同（一个去设置页，一个去装 hook），
// 所以文案必须分开 —— 共用一句会让用户以为喵坏了。
const allHidden = tray.buildStatusRows({
  agents: [{ ...workbuddy, enabled: false }, { id: 'codex', label: 'Codex', detected: true, enabled: false }],
  t,
});
assert(allHidden.length === 1 && allHidden[0].label === t('tray.allHidden'),
  `all-toggled-off says 都已隐藏, not 尚未接入 (got ${JSON.stringify(labels(allHidden))})`);
assert(t('tray.allHidden') !== t('tray.noSources'), 'the two empty states do not share one sentence');

// 关掉一个不影响其它 —— 这条是真正堵住回归的：buildStatusRows 曾经只看 detected，
// 把 main.js 挂上来的 enabled 白扔了，于是设置页的开关对托盘菜单毫无作用。
const oneOff = tray.buildStatusRows({
  agents: [workbuddy, { id: 'claude', label: 'Claude', detected: true, enabled: false, tokens: 1200, cost: 3.4 }],
  t,
});
assert(!/Claude/.test(flat(oneOff)), 'an enabled:false agent is dropped from the tray menu');
assert(/WorkBuddy/.test(flat(oneOff)), 'its neighbours are untouched');
assert(oneOff.filter((row) => row.type === 'separator').length === 0,
  'no separator is left dangling where the hidden agent used to be');

// ── i18n ──────────────────────────────────────────────────────────────────────
for (const key of ['tray.rowWindow', 'tray.rowStatus', 'tray.rowCredit', 'tray.rowCreditUnset',
  'tray.rowTokens', 'tray.rowCost', 'tray.rowNoData', 'tray.noSources']) {
  assert(typeof t(key) === 'string' && t(key) !== key, `i18n has ${key}`);
}

// 上一版的键不能悄悄复活 —— 它们对应的是已被替换掉的「三行块」口径
for (const gone of ['tray.sourceTitle', 'tray.sourceUsage', 'tray.sourceCredit',
  'tray.sourceTokens', 'tray.sourceCreditUsed', 'tray.sourceCreditLeft']) {
  assert(t(gone) === gone, `${gone} is gone from the dictionary`);
}

// 费用为 0 时不留「费用 --」，整段不出现
const zeroCost = tray.buildStatusRows({
  agents: [{ id: 'a', label: 'A', detected: true, tokens: 1000, cost: 0, quota: null }],
  t,
});
assert(!/费用/.test(flat(zeroCost)) && !/\$/.test(flat(zeroCost)),
  'a zero cost leaves no cost segment at all');

console.log('\nTRAY STATUS TESTS PASSED');
