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

// 金额只在真的是正数时返回文本：WorkBuddy 的默认模型 hy3 没有公开价目，
// cost 恒为 0，显示「$0.00」会被误读成「不要钱」。
function money(value) {
  const n = num(value);
  if (n <= 0) return null;
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

function creditText(value) {
  const n = num(value);
  if (n <= 0) return null;
  return n >= 1000 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function contextText(context) {
  if (!context || typeof context !== 'object') return null;
  const used = num(context.used);
  const size = num(context.size);
  if (used <= 0 || size <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.round((used / size) * 100)));
  return { used: compact(used), size: compact(size), percent: String(percent) };
}

// 只有「被检测到」且「历史上真的跑过」的数据源才占一行。后者避免装完还没用过的
// 工具在托盘里占位。
function isReportable(source) {
  if (!source || source.detected !== true) return false;
  return num(source.lifetimeTokens) > 0 || num(source.lifetimeCredit) > 0;
}

function sourceRows(source, t) {
  const rows = [];
  rows.push(t('tray.sourceTokens', {
    tokens: compact(source.tokens),
    rounds: String(Math.round(num(source.msgs))),
  }));
  const cost = money(source.cost);
  if (cost) rows.push(t('tray.sourceCost', { cost }));
  const today = creditText(source.credit);
  if (today) {
    rows.push(t('tray.sourceCredit', {
      credit: today,
      total: creditText(source.lifetimeCredit) || '0',
    }));
  }
  const context = contextText(source.context);
  if (context) rows.push(t('tray.sourceContext', context));
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

module.exports = {
  MAX_SOURCES,
  compact,
  money,
  creditText,
  contextText,
  isReportable,
  buildStatusRows,
};
