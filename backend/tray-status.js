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
// 2026-09-15 收窄：每个分组只保留**总览**口径 —— 今日令牌 + 轮次，以及有正数时
// 才出现的今日积分/累计积分。原先还带「等价费用」和「当前会话上下文水位」两行，
// 都已按用户要求去掉：前者对 hy3 这类无公开价目的模型恒为 0（看着像「不要钱」），
// 后者跟着当前会话实时跳，在托盘这种速览位反而分散注意力。

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

// 积分（credit）只在真的是正数时返回文本。WorkBuddy 的默认模型 hy3 既没有公开
// 价目也不计积分，恒为 0，显示「0」会被误读成「额度已经用完」。
function creditText(value) {
  const n = num(value);
  if (n <= 0) return null;
  return n >= 1000 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
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
  const today = creditText(source.credit);
  if (today) {
    rows.push(t('tray.sourceCredit', {
      credit: today,
      total: creditText(source.lifetimeCredit) || '0',
    }));
  }
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
  creditText,
  isReportable,
  buildStatusRows,
};
