'use strict';

// 托盘菜单顶部的状态行。
//
// 改版历史（每一版都是用户口径变了，不是修 bug）：
//
// v1 把 Codex 写死在最上面 —— 机器上没装 Codex 时那几行只会显示「未找到 Codex」。
// v2 改成按「实际接入、且确实产生过用量」的数据源分组，Codex 额度块只在就绪时附加。
// v3（2026-09-15）用户定了每行口径：标题 / Token·费用 / 积分（今日 + 剩余）。
//
// v5（2026-09-15，当前）：用户看到「设置里写 Codex、托盘却显示 WorkBuddy」之后
// 放弃继续调「额度槽位归谁」，直接换了口径 ——
//
//     「有多少个 agent 有效，设置就显示几个按钮，然后任务栏也对应一行。
//       托盘不一定是 N 行，就按照现在的格式，一行最多可以显示多少个，
//       然后多余的就换行。」
//
// 于是：
//   · 不再按「跑过没有」过滤（检测到就算有效）
//   · 不再排序（固定用调用方给的顺序 = 注册表顺序，行不会跳来跳去）
//   · 不再截断（有几个显示几个）
//   · 不再有「额度槽位归谁」的概念（每个 agent 各显示自己的额度）
//   · 每个 agent 的信息拼成一行；超过宽度上限就在片段边界折行，
//     续行用全角空格做悬挂缩进（同一行的**片段内部**不做断字，
//     一个片段本身超宽就让它独占一行，宁可溢出也不把词切两半）
//   · 没有数字时不删行，写一行状态文字（例如「积分未设置每期总量」）
//
// 这里保持纯函数：不碰文件系统、不碰 Electron，输出直接是
// Menu.buildFromTemplate 能吃的形状，回归测试可以直接断言行内容。

// 一行的显示列数上限。1 个汉字/全角标点 = 2 列，1 个 ASCII = 1 列。
// 32 列≈16 个汉字；macOS 菜单里这个宽度不会折成两排，也不会宽到贴近屏幕边。
const ROW_WIDTH_LIMIT = 32;

// macOS 屏幕顶部菜单栏（Tray.setTitle）的列数上限，只有右键菜单的一半。
// 菜单栏是**和别的 App 抢地方**：右侧还挤着输入法、时间、控制中心，而且
// 一旦超宽 macOS 会静默裁掉尾部 —— 裁成半个数字比不显示更糟。16 列≈8 个汉字。
const TITLE_WIDTH_LIMIT = 16;

// 菜单栏片段之间的分隔。这里不能用 PART_SEP（`　·　` 占 5 列，16 列的预算里
// 两个分隔符就吃掉 10 列），用两个半角空格，1 个片段 1 个分隔符只花 2 列。
const TITLE_SEP = '  ';

// 片段之间的分隔符。沿用 v3 的全角空格 + 中点，和托盘其它地方一致。
const PART_SEP = '　·　';
// 折行后的续行缩进。全角空格 = 2 列，正好让续行挂在名字下面。
const CONTINUATION_INDENT = '　';

// 令牌数量级缩写。桌宠托盘是速览场景，1,234,567 不如 1.2M 好读。
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

// 全角判定。够用就行：CJK、假名、谚文、全角标点、常见 emoji 都算 2 列。
function isWideCodePoint(code) {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0x303e)   // 含 U+3000 全角空格
    || (code >= 0x3041 && code <= 0x33ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xa000 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    // 下面两段是 2026-09-16 为菜单栏补的。托盘菜单行里全是中文和数字，
    // 碰不到它们；菜单栏的状态片段却正是 ✋(U+270B) / ⚙(U+2699) / 🌿(U+1F33F)
    // 这类**旧区**符号 —— 它们不在上面的 1F300+ 区间里，漏判会被当成 1 列，
    // 于是 16 列的预算实际超出，macOS 静默裁掉尾部。
    || (code >= 0x2600 && code <= 0x27bf)   // 杂项符号 + 装饰符号（⚙ ✋ ✅ ☕…）
    || (code >= 0x1f000 && code <= 0x1f2ff) // 麻将/牌/围合字母数字
  );
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text == null ? '' : text)) {
    const code = ch.codePointAt(0);
    // 变体选择符（U+FE0F 等）本身不占位，只是把前一个字符渲染成 emoji 形态。
    // `⚙️` 是 U+2699 + U+FE0F 两个码位，算成 2+1=3 列就把预算算虚了。
    if (code === 0xfe0e || code === 0xfe0f || code === 0x200d) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

// 一个 agent 的信息片段。每个片段自带单位/名词 —— 压到一行之后，
// 光看「1696」已经不知道是积分还是 token 了。
// 顺序：额度（或额度状态）→ Token → 费用。
function agentParts(agent, t) {
  const parts = [];
  const quota = agent && agent.quota && typeof agent.quota === 'object' ? agent.quota : null;

  if (quota && quota.kind === 'codex') {
    // 额度没到手时不留空占位，写状态文字（用户选的：留一行状态文字）。
    const windows = quota.ready && Array.isArray(quota.windows) ? quota.windows : [];
    if (windows.length) {
      for (const w of windows) {
        const percent = Number(w && w.percent);
        parts.push(t('tray.rowWindow', {
          label: String((w && w.label) || ''),
          percent: Number.isFinite(percent) ? String(Math.round(percent)) : '--',
        }));
      }
    } else if (quota.status) {
      parts.push(t('tray.rowStatus', { status: quota.status }));
    }
  } else if (quota && quota.kind === 'credit') {
    const left = quotaText(quota.remaining);
    parts.push(left !== null ? t('tray.rowCredit', { left }) : t('tray.rowCreditUnset'));
  }

  const tokens = num(agent && agent.tokens);
  if (tokens > 0) parts.push(t('tray.rowTokens', { tokens: compact(tokens) }));
  const cost = money(agent && agent.cost);
  if (cost) parts.push(t('tray.rowCost', { cost }));

  return parts;
}

// 一个 agent → 1..N 行。第一行以名字开头，续行用全角空格悬挂缩进。
// 折行只在片段边界发生：宁可让一个超长片段独占一行（轻微溢出），
// 也不把「正在自动重试」这种词从中间切开。
function agentLines(agent, t, limit = ROW_WIDTH_LIMIT) {
  const budget = Number.isFinite(limit) && limit > 0 ? limit : ROW_WIDTH_LIMIT;
  const name = String((agent && agent.label) || (agent && agent.id) || '');
  const head = name ? `${name}　` : '';
  const parts = agentParts(agent, t);
  // 一个片段都没有（既没有额度也没有用量）也算有效 —— 用户要的是「有几个就显示几个」，
  // 所以退化成一行「暂无数据」，而不是整行消失。
  if (!parts.length) parts.push(t('tray.rowNoData'));

  const lines = [];
  let line = null;
  for (const part of parts) {
    if (line === null) {
      line = head + part;
      continue;
    }
    if (displayWidth(line) + displayWidth(PART_SEP) + displayWidth(part) <= budget) {
      line += PART_SEP + part;
    } else {
      lines.push(line);
      line = CONTINUATION_INDENT + part;
    }
  }
  lines.push(line);
  return lines;
}

// agents 里只保留 detected === true 的，顺序按调用方给的顺序（= 注册表顺序），
// 这里不排序、不截断 —— 有效 agent 一定有自己的行，几个就是几个。
// agent 之间插一条分隔线：折行之后光看行首已经不容易分辨归属了。
function buildStatusRows(input = {}) {
  const t = typeof input.t === 'function' ? input.t : (key) => key;
  const limit = input.limit;
  const agents = (Array.isArray(input.agents) ? input.agents : [])
    .filter((agent) => agent && agent.detected === true);
  if (!agents.length) return [{ label: t('tray.noSources'), enabled: false }];

  const rows = [];
  for (const agent of agents) {
    if (rows.length) rows.push({ type: 'separator' });
    for (const line of agentLines(agent, t, limit)) rows.push({ label: line, enabled: false });
  }
  return rows;
}

// ── macOS 屏幕顶部菜单栏（Tray.setTitle）─────────────────────────────────────────
//
// 2026-09-16 用户要求：「仿照喵底部栏，在顶部任务栏也增加开关」。
//
// 与右键菜单（buildStatusRows）的三处**故意**不同，都是宽度逼出来的：
//   1. 菜单栏是**全局聚合**，不是「每个 Agent 一段」。按 displayWidth 估：
//      1 个 Agent 带额度约 9 列，2 个就 20 列，5 个不可能。所以状态数字是所有
//      Agent 求和，额度只取「第一个启用且真有额度数据的 Agent」。
//   2. 预算 16 列（TITLE_WIDTH_LIMIT），是右键菜单 32 列的一半。
//   3. 超限就**整段丢掉后面的片段**，绝不中途截断 —— 半个数字比没有更糟，
//      而且 macOS 超宽时自己就会静默裁尾，必须在这里先控住。
//
// 隐私：只吃计数和用量数字。这些是 privacy.protectStats() **不脱敏**的字段。
// active.project 之类会被脱敏的东西绝不能进来 —— 菜单栏是全局可见的，
// 旁边坐个人就能看到项目名。
//
// 纯函数：不碰 Electron，直接单测。

// 状态片段。口径对齐胶囊（renderer/pet.js 的 renderContextCapsule）：
// 同一时刻只显示优先级最高的那一类，不并列 —— 菜单栏没有并列的宽度。
function titleStatus(status, t) {
  const s = status && typeof status === 'object' ? status : {};
  const n = (value) => {
    const v = Number(value);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  const waiting = n(s.waiting);
  const needsinput = n(s.needsinput);
  const error = n(s.error);
  const sweeping = n(s.sweeping);
  const active = n(s.active);
  // 「等你」把授权和回复合并计数：菜单栏上这两者对用户是同一个动作（去处理一下）。
  if (waiting > 0) return t('tray.titleWaiting', { count: String(waiting + needsinput) });
  if (error > 0) return t('tray.titleError', { count: String(error) });
  if (needsinput > 0) return t('tray.titleNeedsinput', { count: String(needsinput) });
  // 压缩上下文单独一档，排在 active 之前。否则它被并进 active 的求和里，画成
  // ⚙️（就是「干活中」的图标）—— 与胶囊、猫、右键菜单三处的口径不一致，
  // 用户看到的「压缩时显示干活中」很可能正是这里（2026-09-16）。
  if (sweeping > 0) return t('tray.titleSweeping', { count: String(sweeping) });
  if (active > 0) return t('tray.titleActive', { count: String(active) });
  // 空闲态也给一个字符：菜单栏彻底空着会让人怀疑喵挂了。
  return t(s.sleeping ? 'tray.titleSleeping' : 'tray.titleIdle');
}

// 额度片段。取第一个「启用 + 检测到 + 真有数字」的 Agent，其余忽略。
// 「启用」复用底部栏那套 quotaAgents 开关（enabled !== false），不另立一张表 ——
// 用户在设置页关掉 Codex 的额度，底部栏和菜单栏同时生效。
function titleQuota(agents, t) {
  for (const agent of (Array.isArray(agents) ? agents : [])) {
    if (!agent || agent.detected === false || agent.enabled === false) continue;
    const quota = agent.quota && typeof agent.quota === 'object' ? agent.quota : null;
    if (!quota) continue;
    if (quota.kind === 'codex') {
      const windows = quota.ready && Array.isArray(quota.windows) ? quota.windows : [];
      // 两个窗口只放**剩余最少**的那个：菜单栏是预警位，先看见快用完的那个。
      let worst = null;
      for (const w of windows) {
        const percent = Number(w && w.percent);
        if (!Number.isFinite(percent)) continue;
        if (worst === null || percent < worst.percent) worst = { label: String((w && w.label) || ''), percent };
      }
      if (worst) {
        return t('tray.titleQuotaWindow', { label: worst.label, percent: String(Math.round(worst.percent)) });
      }
      continue;   // 装了 Codex 但额度没到手 —— 菜单栏不写状态文字，太宽，让位给别的片段
    }
    if (quota.kind === 'credit') {
      const left = quotaText(quota.remaining);
      if (left !== null) return t('tray.titleCredit', { left });
    }
  }
  return null;
}

// display 里四个开关的默认值必须和 config.js 的 DEFAULTS.menuBar 一致，
// 否则「设置还没落盘」的那一瞬间菜单栏和设置页会不一样。
function titleParts(input, t) {
  const display = input.display && typeof input.display === 'object' ? input.display : {};
  const totals = input.totals && typeof input.totals === 'object' ? input.totals : {};
  const parts = [];
  if (display.showStatus !== false) parts.push(titleStatus(input.status, t));
  if (display.showQuota === true) parts.push(titleQuota(input.agents, t));
  if (display.showTokens === true) {
    const tokens = num(totals.tokens);
    if (tokens > 0) parts.push(compact(tokens));
  }
  if (display.showCost === true) {
    const cost = money(totals.cost);
    if (cost) parts.push(cost);
  }
  return parts.filter(Boolean);
}

function buildTrayTitle(input = {}) {
  const t = typeof input.t === 'function' ? input.t : (key) => key;
  const limitRaw = Number(input.limit);
  const budget = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : TITLE_WIDTH_LIMIT;
  const parts = titleParts(input, t);
  if (!parts.length) return '';

  // 第一个片段无条件保留（它最重要，而且单个片段本身超不过 ~7 列）。
  // 之后逐个试拼，第一个装不下的就**连它带后面全部丢掉** —— 允许「跳过它、
  // 接着塞后面更短的」会让片段顺序在不同数值下变来变去，看着像 bug。
  let title = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const next = title + TITLE_SEP + parts[i];
    if (displayWidth(next) > budget) break;
    title = next;
  }
  return title;
}

module.exports = {
  ROW_WIDTH_LIMIT,
  TITLE_WIDTH_LIMIT,
  compact,
  money,
  creditText,
  quotaText,
  displayWidth,
  isWideCodePoint,
  agentParts,
  agentLines,
  buildStatusRows,
  buildTrayTitle,
};
