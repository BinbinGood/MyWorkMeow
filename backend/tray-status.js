'use strict';

// 托盘菜单顶部的状态行。
//
// 改版原因：原先这里把 Codex 写死在菜单最上面 —— 不管用户接的是哪个 agent，
// 点开托盘第一眼看到的都是 Codex 账户邮箱 + 5h/7d 额度。本项目支持 Claude /
// Codex / WorkBuddy / TRAE / opencode 五种，把其中一个当成默认既没有依据，也不
// 是用户想要的：机器上没装 Codex 时那几行只会显示「未找到 Codex，正在自动重试」。
//
// 现在改成按「实际接入、且确实产生过用量」的数据源生成分组行，Codex 额度块只在
// 检测到 Codex 且额度可用时才出现。这里保持纯函数，方便回归测试直接断言行内容。
//
// 2026-09-15 二次调整：用户定了每行口径 ——
//   标题 / Token·费用 / 积分（今日消耗 · 剩余）
// 「令牌」改回行业通用的 Token；「N 轮」去掉（托盘是速览位，轮次没人看）；
// 积分不再显示「累计消耗」，改为「今日 + 剩余」，剩余由用户手填的每期总量减去
// 本机已用得出（backend/credit-cycle.js）。
//
// 2026-09-15 三次调整：Token 与费用并成一行，且「等价费用」简化为「费用」。
// 费用仍然只在真的是正数时出现在那一行里（见 money() 的注释）。

const MAX_SOURCES = 3;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 令牌数量级缩写。桌宠托盘是速览场景，1,234,567 不如 1.2M 好读。
function compact(value) {
  const n = num(value);
  if (n <= 0) return '0';
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(value) {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded);
}

// API 等价费用只在真的是正数时返回。WorkBuddy 的默认模型 hy3 没有公开价目，
// 它的 cost 恒为 0；显示「$0.00」会被读成「不要钱」，而实情是「这个模型的价钱
// 我们查不到」。多模型混用时这个数也只覆盖有价目的那些，是个**下限**。
function money(value) {
  const n = num(value);
  if (n <= 0) return null;
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

function fmtCredit(n) {
  return n >= 1000 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

// 今日消耗的积分：0 不显示。hy3 恒为 0，显示「积分 0」会被误读成额度用完了。
function creditText(value) {
  const n = num(value);
  return n <= 0 ? null : fmtCredit(n);
}

// 剩余额度：这里 **0 是有效值**（额度确实用尽了，应当显示），只有「没配额度」
// 才返回 null。注意必须先用 === null/undefined 判断，不能直接 Number()——
// Number(null) === 0 会把「没配」误判成「用尽」。
function quotaText(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return fmtCredit(n);
}

// 只有「被检测到」且「历史上真的跑过」的数据源才占一行。后者避免装完还没用过的
// 工具在托盘里占位。
function isReportable(source) {
  if (!source || source.detected !== true) return false;
  return num(source.lifetimeTokens) > 0 || num(source.lifetimeCredit) > 0;
}

function sourceRows(source, t) {
  const rows = [];
  const tokens = compact(source.tokens);
  const cost = money(source.cost);
  // Token 与费用合并成一行：托盘是速览位，两行压一行少占一个菜单位。
  // 费用为 0 时（hy3 这类没有公开价目的模型恒为 0）整行退化成纯 Token，
  // 而不是打印一个会被读成「不要钱」的 $0.00。
  rows.push(cost
    ? t('tray.sourceUsage', { tokens, cost })
    : t('tray.sourceTokens', { tokens }));
  // 积分行：今日消耗与剩余额度各自独立，谁有值就带谁。
  // creditRemaining === null 表示用户还没填每期额度（不是 0）——那种情况下
  // 只显示今日消耗，整段「剩余」不出现。
  const used = creditText(source.credit);
  const left = quotaText(source.creditRemaining);
  if (used && left !== null) rows.push(t('tray.sourceCredit', { credit: used, left }));
  else if (used) rows.push(t('tray.sourceCreditUsed', { credit: used }));
  else if (left !== null) rows.push(t('tray.sourceCreditLeft', { left }));
  return rows;
}

// 输入 rows 之外的东西都由调用方取好（这里不碰文件系统、不碰 Electron）。
// 输出直接就是 Menu.buildFromTemplate 能吃的形状。
//
// 分隔线只在**块之间**插入，不在最前面 —— 菜单开头挂一条 separator 在 macOS 上
// 会渲染成一段空白，看起来像渲染坏了。
function buildStatusRows(input = {}) {
  const t = typeof input.t === 'function' ? input.t : (key) => key;
  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .filter(isReportable)
    .sort((a, b) => num(b.tokens) - num(a.tokens))
    .slice(0, MAX_SOURCES);
  const codexRows = Array.isArray(input.codexRows) ? input.codexRows : [];
  const showCodex = input.codexReady === true && codexRows.length > 0;

  const blocks = sources.map((source) => [
    { label: t('tray.sourceTitle', { name: source.label }), enabled: false },
    ...sourceRows(source, t).map((label) => ({ label, enabled: false })),
  ]);
  if (showCodex) blocks.push(codexRows.slice());
  if (!blocks.length) return [{ label: t('tray.noSources'), enabled: false }];

  const rows = [];
  blocks.forEach((block, index) => {
    if (index > 0) rows.push({ type: 'separator' });
    rows.push(...block);
  });
  return rows;
}

// 额度槽位归谁。设置页「喵底部展示栏」那一项和底部展示栏的额度徽标共用这一个
// 判断，抽成纯函数是因为「谁占这一格」很容易写错，而且错了要隔一层才看得出来：
// 早先的版本要求 Codex 的额度**已经就绪**才归它（status === 'ready'），于是额度
// 拉取中 / 拉取失败的那段时间槽位会落到别的 Agent 上 —— 用户接的明明是 Codex，
// 设置页那一项却写成别的名字、还多出一张「积分额度」手填卡片，看起来就像
// 「Codex 的选项没了」。归属只看「装没装」，有没有数字是另一回事。
//
//   codexDetected → Codex（额度没到时 ready:false，徽标先显示 --）
//   否则 creditSource → 那个积分型数据源
//   都没有 → none（槽位置灰，而不是继续显示某个 Agent 的空壳）
function slotOwner(input = {}) {
  if (input.codexDetected === true) {
    return { kind: 'codex', id: 'codex', label: 'Codex', ready: input.codexReady === true };
  }
  const row = input.creditSource;
  if (!row || !row.id) return { kind: 'none', id: null, label: null, ready: false };
  return { kind: 'credit', id: row.id, label: row.label, ready: true };
}

module.exports = {
  MAX_SOURCES,
  compact,
  money,
  creditText,
  quotaText,
  isReportable,
  slotOwner,
  buildStatusRows,
};
