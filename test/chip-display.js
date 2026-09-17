'use strict';
const assert = require('assert');
const config = require('../backend/config');
const { loadRenderer } = require('./dom-stub');
assert.strictEqual(config.sanitize({}).showStatus, true);
assert.strictEqual(config.sanitize({}).showCat, true);
assert.strictEqual(config.sanitize({ showStatus: 'true' }).showStatus, true);
assert.strictEqual(config.sanitize({}).showTokens, false);
assert.strictEqual(config.sanitize({}).showCost, true);
assert.strictEqual(config.sanitize({ showTokens: true }).showTokens, true);
assert.strictEqual(config.sanitize({ showCost: 'true' }).showCost, true);

// ── 额度开关：按 Agent 逐个 ──────────────────────────────────────────────────
// 以前是一个布尔 showQuota + 一个会动态改名的「额度槽位」。2026-09-15 换成
// quotaAgents 映射：**缺省放行**，只有显式 false 才是关掉。要防的正靶有两个：
//   1. sanitize 把开关写回共享的 DEFAULTS（顶层 Object.freeze 冻不住内嵌对象）
//   2. 改一个 Agent 的开关时整表覆盖，把别的 Agent 的开关抹了（这条在 main.js）
assert.strictEqual(config.sanitize({}).quotaAgents.workbuddy, undefined,
  'an unmentioned agent defaults to enabled (absent, not false)');
assert.strictEqual(config.sanitize({ quotaAgents: { codex: false } }).quotaAgents.codex, false);
assert.strictEqual(config.sanitize({ quotaAgents: { codex: 'no' } }).quotaAgents.codex, undefined,
  'a non-boolean toggle is ignored rather than coerced');
assert.strictEqual(config.sanitize({ showQuota: false }).quotaAgents.workbuddy, false,
  'a legacy showQuota:false migrates so the upgrade does not re-enable a hidden badge');
assert.strictEqual(config.sanitize({ showQuota: true }).quotaAgents.codex, true,
  'a legacy showQuota:true migrates into every agent');
config.sanitize({ quotaAgents: { codex: false } });
assert.strictEqual(config.sanitize({}).quotaAgents.codex, undefined,
  'sanitize never leaks the callers toggle into the shared defaults');

// ── 托盘菜单与底部展示栏解耦（2026-09-16）───────────────────────────────────
// trayAgents 是新增的独立开关。迁移口径：用户还没显式写过 trayAgents 时，
// 用 quotaAgents 作初值（升级后之前关掉的托盘行不会自己亮回来）；一旦写过，
// 就和 quotaAgents 彻底脱钩。
assert.strictEqual(config.sanitize({}).trayAgents.workbuddy, undefined,
  'an unmentioned tray agent defaults to enabled');
assert.strictEqual(config.sanitize({ quotaAgents: { codex: false } }).trayAgents.codex, false,
  'trayAgents seeds from quotaAgents on first run after upgrade');
assert.strictEqual(config.sanitize({ quotaAgents: { codex: false }, trayAgents: { codex: true } }).trayAgents.codex, true,
  'an explicit trayAgents value wins over the migrated seed');
assert.strictEqual(
  config.sanitize({ quotaAgents: { codex: false }, trayAgents: { codex: true } }).quotaAgents.codex,
  false, 'toggling the tray must not touch the bottom-bar toggle');
assert.strictEqual(config.sanitize({ showQuota: false }).trayAgents.workbuddy, false,
  'the legacy showQuota:false also migrates into the tray map');

const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/agents.js', 'shared/pet-insights.js', 'renderer/icons.js', 'renderer/pet.js']);
// 底部展示栏现在是「每个检测到的 Agent 一份额度」，所以渲染揣包里必须带上
// quotaAgents 列表 —— 它同时驱动胶囊徽标、托盘行、设置页的开关。
const codexAgent = { id: 'codex', label: 'Codex', quota: { kind: 'codex', ready: true, status: null } };
const stats = { today: { tokens: 1234, cost: 0.123 }, sessions: [], bg: {}, idleMs: 1000,
  quotaAgents: [codexAgent],
  codexQuota: { status: 'ready', windows: { fiveHour: { remainingPercent: 20, resetsAt: 1800000000 }, weekly: { remainingPercent: 5 } } } };
w.handlers.stats(stats);
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), false);
assert.strictEqual(w.elements('cat').getAttribute('aria-hidden'), 'false');
assert.strictEqual(w.elements('chip-tokens').hidden, true);
assert.strictEqual(w.elements('chip-cost').hidden, false);
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '20%');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'amber');
assert.strictEqual(w.elements('chip-quota').children[1].dataset.level, 'red');
assert.strictEqual(w.elements('chip-quota').children[1].textContent, '5%');
assert.strictEqual(w.elements('chip').title, '', 'the capsule must not use a native hover tooltip');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), true);
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), false);
assert.strictEqual(w.elements('quota-popover-rows').children.length, 2);
assert(w.elements('quota-popover-rows').children[0].children[1].children[1].textContent.includes('刷新'));
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover').classList.contains('hidden'), true);
w.handlers.stats({ ...stats, codexQuota: {
  status: 'ready',
  windows: { fiveHour: null, weekly: { remainingPercent: 80, usedPercent: 20, resetsAt: 1800000000 } },
  estimate: { tokens: 200000, cost: 1.25, samplePercent: 20, usedPercent: 20, estimatedTotalCost: 6.25, estimatedRemainingCost: 5 },
} });
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'a Pro-style weekly-only quota must hide the empty 5h badge');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.period, '7d');
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover-rows').children.length, 1,
  'the weekly-only popover must hide the empty 5h row');
assert.strictEqual(w.elements('quota-popover-insight').hidden, false,
  'the quota popover must show the weekly usage estimate when available');
assert.strictEqual(w.elements('quota-popover-insight').children[1].className, 'quota-estimate-grid');
assert.strictEqual(w.elements('quota-popover-insight').children[1].children[0].children[1].textContent, '≈ $6.25');
assert.strictEqual(w.elements('quota-popover-insight').children[1].children[1].children[1].textContent, '≈ $5.00');
w.handlers.stats({ ...stats, codexQuota: { ...stats.codexQuota,
  estimate: { tokens: 0, cost: 0, samplePercent: 0, estimatedTotalCost: null },
} });
assert.strictEqual(w.elements('quota-popover-insight').children[1].className, 'quota-estimate-pending',
  'missing estimate must show collecting state instead of a zero-capacity card');
w.handlers.stats({ ...stats, codexQuota: { ...stats.codexQuota,
  estimate: { basis: 'cycle', cost: 7, usedPercent: 7, samplePercent: 7, estimatedTotalCost: 100, estimatedRemainingCost: 93 },
} });
assert.strictEqual(w.elements('quota-popover-insight').children[0].children[1].textContent, '动态参考');
assert(w.elements('quota-popover-insight').children[2].textContent.includes('已用 7%'));
assert.strictEqual(w.elements('quota-popover-insight').children[1].children[1].children[1].textContent, '≈ $93.00');
w.handlers.stats({ ...stats, codexQuota: { ...stats.codexQuota,
  estimate: { basis: 'cycle', confidence: 'early', cost: 1, usedPercent: 1, samplePercent: 1, estimatedTotalCost: 100, estimatedRemainingCost: 99 },
} });
assert.strictEqual(w.elements('quota-popover-insight').children[0].children[1].textContent, '初步估算');
assert.strictEqual(w.elements('quota-popover-insight').children[1].className, 'quota-estimate-grid', '1% consumption already shows an estimate');
w.elements('chip-quota').dispatch('click');
const compactStats = { ...stats, sessions: [{ state: 'working', agent: 'codex', createdAt: 100 }],
  chipDisplay: { showCat: false, showStatus: true, showTokens: false, showCost: false, quotaAgents: { codex: true } } };
w.handlers.stats(compactStats);
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), true);
assert.strictEqual(w.elements('cat').getAttribute('aria-hidden'), 'true');
assert.strictEqual(w.elements('chip-context').textContent.startsWith('⚙️'), true,
  'the working-state icon must remain inside the capsule');
// 2026-09-16 用户实测：压缩上下文时胶囊显示的是「干活中」。其中一层是这里 ——
// 旧写法在两个及以上忙碌会话时把标签整段换成「N 个任务」，状态词彻底消失，
// 所以单会话时看着是对的、多会话时就错了（用户说的「有时候又是对的」）。
// 现在计数缀在状态词后面，两个事实都保住。
w.handlers.stats({ ...compactStats, sweepingCount: 1, workingCount: 1, sessions: [
  { state: 'sweeping', agent: 'claude', createdAt: 100 },
  { state: 'working', agent: 'codex', createdAt: 101 },
] });
assert.strictEqual(w.elements('chip-context').textContent, '🧹 清理上下文 ×2',
  'multiple busy sessions must keep the state word and only append the count');
assert.strictEqual(w.elements('chip').getAttribute('aria-label').startsWith('清理上下文 · 共 2 个任务'),
  true, 'the accessible label spells out both the state and the task count');
w.handlers.stats({ ...compactStats, sweepingCount: 1, sessions: [
  { state: 'sweeping', agent: 'claude', createdAt: 100 },
] });
assert.strictEqual(w.elements('chip-context').textContent.startsWith('🧹 清理上下文'), true,
  'a single compacting session shows the same state word without a count suffix');
assert.strictEqual(w.elements('chip-context').textContent.includes('×'), false,
  'the count suffix must not appear when only one session is busy');
// 下面测道具图标的落位，得先把状态放回 working —— sweeping 是**高优先级稳态**，
// pet.js 的 operation 分支会 hold 住它、根本不调 playAction/positionProp
//（那正是「清理上下文时不被工具事件降级成干活中」的设计）。不复位的话
// propEl.style.left 压根没被赋值过，断言拿到 undefined，看着像落位算错了。
w.handlers.stats(compactStats);
w.window.innerWidth = 320;
w.elements('stage').getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 340 });
w.elements('chip').getBoundingClientRect = () => ({ left: 150, top: 300, width: 130, height: 21 });
w.elements('sessions').getBoundingClientRect = () => ({ left: 80, top: 275, width: 50, height: 21 });
w.handlers.event({ kind: 'operation', tool: 'Bash', icon: '⚙️', detail: '调用工具' });
assert.strictEqual(w.elements('prop').style.left, '45px',
  'the live tool icon must sit to the left of the first status dot');
w.elements('sessions').getBoundingClientRect = () => ({ left: 100, top: 275, width: 95, height: 21 });
w.handlers.stats({ ...compactStats, sessions: [
  { state: 'working', agent: 'codex', createdAt: 100 },
  { state: 'thinking', agent: 'claude', createdAt: 101 },
] });
assert.strictEqual(w.elements('prop').style.left, '65px',
  'the live tool icon must follow the first dot when parallel sessions change');
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: { codex: true } } });
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), false);
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: false, showTokens: false, showCost: false, quotaAgents: { codex: true } } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-quota').hidden, false);
assert.strictEqual(w.elements('chip-tokens-sep').hidden, true);
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: false, showTokens: false, showCost: true, quotaAgents: { codex: false } } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-quota').hidden, true,
  'turning the only agent off hides the whole quota block');
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert.strictEqual(w.elements('chip-cost').hidden, false);
w.handlers.stats({ ...stats, codexQuota: { status: 'ready', windows: {
  fiveHour: { remainingPercent: 75, resetsAt: 1800003600 }, weekly: { remainingPercent: 60 },
} } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '75%');
assert.strictEqual(w.elements('chip-quota').children[1].textContent, '60%');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'normal');
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: true, showTokens: true, showCost: false, quotaAgents: { codex: false } } });
assert.strictEqual(w.elements('chip-quota').hidden, true);
assert.strictEqual(w.elements('chip-tokens').hidden, false);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert(!w.elements('chip').title.includes('$'));
w.handlers.stats({ ...stats, codexQuota: { status: 'unavailable' } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '--');

// ── 多个 Agent 并存 ─────────────────────────────────────────────────────────
// 这是本轮改动的中心：Codex 的 5h/7d 和 WorkBuddy 的积分可以同时出现在胶囊里，
// 而且各自能被独立关掉。以前是「二选一」，两者永远不可能同框。
const creditAgent = {
  id: 'workbuddy', label: 'WorkBuddy',
  quota: { kind: 'credit', ready: true, today: 98.6, cycleUsed: 1694.7, remaining: 1809.9,
    monthly: 3600, resetDay: 1, cycleStart: '2026-09-01' },
};
w.handlers.stats({
  ...stats,
  quotaAgents: [creditAgent, codexAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: {} },
});
assert.strictEqual(w.elements('chip-quota').children.length, 3,
  'one credit badge plus the Codex 5h/7d pair, side by side');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.kind, 'credit',
  'the first badge is the credit one, in registry order');
w.handlers.stats({
  ...stats,
  quotaAgents: [creditAgent, codexAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: { codex: false } },
});
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'disabling Codex leaves only the WorkBuddy credit badge');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.kind, 'credit');
w.handlers.stats({
  ...stats,
  quotaAgents: [creditAgent, codexAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: { workbuddy: false } },
});
assert.strictEqual(w.elements('chip-quota').children.length, 2,
  'disabling WorkBuddy leaves the Codex 5h/7d pair');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.period, '5h');

// ── 没有额度数据的 Agent（Claude / TRAE / opencode）─────────────────────────────
// 2026-09-16 的回归靶子。这类 Agent 的 quota 恒为 null（source-registry 没给它们
// creditQuota，trayAgentRows() 于是回 null），activeAgentBadges 会在
// `if (kind !== 'codex') continue` 处直接跳过 —— 零徽标。
// 旧代码的可见性按「开着的 Agent 数」算，把它计成 1，于是 #chip-quota 显示了
// 但里面是空的：用户看到的就是「claude 按钮开了以后啥也没显示」，只剩 4px padding。
// 可见性必须按**徽标数**算。
const noQuotaAgent = { id: 'claude', label: 'Claude', quota: null };
w.handlers.stats({ ...stats, quotaAgents: [noQuotaAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: true, quotaAgents: {} } });
assert.strictEqual(w.elements('chip-quota').children.length, 0,
  'an agent with no quota data produces no badges');
assert.strictEqual(w.elements('chip-quota').hidden, true,
  'a quota block with zero badges must be hidden, not shown as an empty slot');
// 分隔符跟着走：额度段整段不存在时，它后面那个分隔符不能挂在空气上。
w.handlers.stats({ ...stats, quotaAgents: [noQuotaAgent],
  chipDisplay: { showCat: true, showStatus: false, showTokens: false, showCost: true, quotaAgents: {} } });
assert.strictEqual(w.elements('chip-quota').hidden, true);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true,
  'with status off and the quota block empty, the cost separator has nothing to follow');
// 混着来：没数据的 Agent 不该影响有数据的那个。
w.handlers.stats({ ...stats, quotaAgents: [noQuotaAgent, codexAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: {} } });
assert.strictEqual(w.elements('chip-quota').hidden, false);
assert.strictEqual(w.elements('chip-quota').children.length, 2,
  'a quota-less agent must not crowd out or duplicate the Codex 5h/7d pair');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.period, '5h');

// ── 积分型额度（接 WorkBuddy 这类余额只在服务端的 Agent）────────────────────────
// 徽标左侧的标签由 pet.css 用 attr(data-period) 渲染。这里要防的正靶：上一版把
// data-period 直接写成 'credit'，界面上出现的是「credit 1.8K」——一个英文单词，
// 而且没说清是剩余还是已用。现在必须是本地化的词标签 + data-kind，后者驱动
// CSS 放宽宽度（62px 装不下「剩余积分」四个字加数值）并补冒号。
w.handlers.stats({ ...stats, quotaAgents: [creditAgent],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: {} } });
const creditBadge = w.elements('chip-quota').children[0];
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'a credit agent renders exactly one badge (no 5h/7d pair)');
assert.strictEqual(creditBadge.dataset.kind, 'credit', 'the credit badge is tagged so CSS can widen it');
assert.strictEqual(creditBadge.dataset.period, '剩余积分',
  `the badge label is a localized word, not the literal "credit" (got ${creditBadge.dataset.period})`);
// compactTokens 用的是小写 k（1.8k），与托盘那边的 K/M 不同 —— 这里锁住实际渲染，
// 免得以后有人「顺手统一大小写」把用户已经看惯的显示改掉。
assert.strictEqual(creditBadge.textContent, '1.8k', 'the badge value is the remaining credit');
assert(!/credit/.test(creditBadge.dataset.period), 'the raw English word must not reach the label');
assert(creditBadge.dataset.level === 'normal',
  '1809.9 / 3600 is a comfortable remainder, so the accent stays neutral');

// 填了 0 剩余 → 这是「额度用尽」，必须显示 0 而不是 --（-- 是「没配额度」）
w.handlers.stats({ ...stats, quotaAgents: [{ ...creditAgent, quota: { ...creditAgent.quota, remaining: 0 } }],
  chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: {} } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '0',
  'an exhausted quota reads 0, not --');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'red',
  'an exhausted quota turns the accent red');

// 还没填每期总量 → remaining 为 null，显示 -- 而不是 0
w.handlers.stats({ ...stats, quotaAgents: [{
  id: 'workbuddy', label: 'WorkBuddy',
  quota: { kind: 'credit', ready: false, today: 0, cycleUsed: null, remaining: null, monthly: null, resetDay: null, cycleStart: null },
}],
chipDisplay: { showCat: true, showStatus: true, showTokens: false, showCost: false, quotaAgents: {} } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '--',
  'an unset quota reads --, never 0');

// 点开弹层：走积分那一支，不画 Codex 的 5h/7d。
// dom-stub 的 textContent 不会向上聚合，所以自己递归拼一遍（只拼真实的子元素，
// 否则断言会因为「父节点 textContent 恒为空」而永远通过）。
const flatText = (el) => (el.textContent || '')
  + (el.children || []).map(flatText).join('');
w.elements('chip-quota').dispatch('click');
assert(/WorkBuddy/.test(w.elements('quota-popover-title').textContent),
  'the credit popover is titled after the source agent');
const popoverText = flatText(w.elements('quota-popover-rows')) + w.elements('quota-popover-title').textContent;
assert(popoverText.includes('剩余'), 'the credit popover shows the remaining credit row');
assert(!/5h|7d/.test(popoverText),
  `the credit popover must not render the Codex 5h/7d rows (got ${popoverText})`);
assert(!/Codex/.test(popoverText), 'the credit popover must not mention Codex at all');
w.elements('chip-quota').dispatch('click');

console.log('chip display checks passed');
process.exit(0);
