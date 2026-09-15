'use strict';
const assert = require('assert');
const config = require('../backend/config');
const { loadRenderer } = require('./dom-stub');
assert.strictEqual(config.sanitize({}).showStatus, true);
assert.strictEqual(config.sanitize({}).showCat, true);
assert.strictEqual(config.sanitize({ showStatus: 'true' }).showStatus, true);
assert.strictEqual(config.sanitize({}).showQuota, true);
assert.strictEqual(config.sanitize({}).showTokens, false);
assert.strictEqual(config.sanitize({}).showCost, true);
assert.strictEqual(config.sanitize({ showTokens: true }).showTokens, true);
assert.strictEqual(config.sanitize({ showCost: 'true' }).showCost, true);
const w = loadRenderer(['shared/i18n.js', 'shared/states.js', 'shared/pet-assets.js', 'shared/pet-insights.js', 'renderer/pet.js']);
const stats = { today: { tokens: 1234, cost: 0.123 }, sessions: [], bg: {}, idleMs: 1000,
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
  estimate: { tokens: 200000, cost: 1.25, usedPercent: 20, estimatedTotalTokens: 1000000, estimatedTotalCost: 6.25 },
} });
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'a Pro-style weekly-only quota must hide the empty 5h badge');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.period, '7d');
w.elements('chip-quota').dispatch('click');
assert.strictEqual(w.elements('quota-popover-rows').children.length, 1,
  'the weekly-only popover must hide the empty 5h row');
assert.strictEqual(w.elements('quota-popover-insight').hidden, false,
  'the quota popover must show the weekly usage estimate when available');
w.elements('chip-quota').dispatch('click');
const compactStats = { ...stats, sessions: [{ state: 'working', agent: 'codex', createdAt: 100 }],
  chipDisplay: { showCat: false, showStatus: true, showQuota: true, showTokens: false, showCost: false } };
w.handlers.stats(compactStats);
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), true);
assert.strictEqual(w.elements('cat').getAttribute('aria-hidden'), 'true');
assert.strictEqual(w.elements('chip-context').textContent.startsWith('⚙️'), true,
  'the working-state icon must remain inside the capsule');
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
w.handlers.stats({ ...stats, chipDisplay: { showCat: true, showStatus: true, showQuota: true, showTokens: false, showCost: false } });
assert.strictEqual(w.elements('stage').classList.contains('cat-hidden'), false);
w.handlers.stats({ ...stats, chipDisplay: { showStatus: false, showQuota: true, showTokens: false, showCost: false } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-quota').hidden, false);
assert.strictEqual(w.elements('chip-tokens-sep').hidden, true);
w.handlers.stats({ ...stats, chipDisplay: { showStatus: false, showQuota: false, showTokens: false, showCost: true } });
assert.strictEqual(w.elements('chip-context').hidden, true);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert.strictEqual(w.elements('chip-cost').hidden, false);
w.handlers.stats({ ...stats, codexQuota: { status: 'ready', windows: {
  fiveHour: { remainingPercent: 75, resetsAt: 1800003600 }, weekly: { remainingPercent: 60 },
} } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '75%');
assert.strictEqual(w.elements('chip-quota').children[1].textContent, '60%');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'normal');
w.handlers.stats({ ...stats, chipDisplay: { showQuota: false, showTokens: true, showCost: false } });
assert.strictEqual(w.elements('chip-quota').hidden, true);
assert.strictEqual(w.elements('chip-tokens').hidden, false);
assert.strictEqual(w.elements('chip-cost-sep').hidden, true);
assert(!w.elements('chip').title.includes('$'));
w.handlers.stats({ ...stats, codexQuota: { status: 'unavailable' } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '--');

// ── 积分型额度槽位（接 WorkBuddy 这类余额只在服务端的 Agent）────────────────────
// 徽标左侧的标签由 pet.css 用 attr(data-period) 渲染。这里要防的正靶：上一版把
// data-period 直接写成 'credit'，界面上出现的是「credit 1.8K」——一个英文单词，
// 而且没说清是剩余还是已用。现在必须是本地化的词标签 + data-kind，后者驱动
// CSS 放宽宽度（62px 装不下「剩余积分」四个字加数值）并补冒号。
const creditSlot = {
  kind: 'credit', id: 'workbuddy', label: 'WorkBuddy',
  today: 98.6, cycleUsed: 1694.7, remaining: 1809.9, monthly: 3600, resetDay: 1,
};
w.handlers.stats({ ...stats, chipDisplay: { showQuota: true, showTokens: false, showCost: false },
  quotaSlot: creditSlot });
const creditBadge = w.elements('chip-quota').children[0];
assert.strictEqual(w.elements('chip-quota').children.length, 1,
  'a credit slot renders exactly one badge (no 5h/7d pair)');
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
w.handlers.stats({ ...stats, chipDisplay: { showQuota: true, showTokens: false, showCost: false },
  quotaSlot: { ...creditSlot, remaining: 0 } });
assert.strictEqual(w.elements('chip-quota').children[0].textContent, '0',
  'an exhausted quota reads 0, not --');
assert.strictEqual(w.elements('chip-quota').children[0].dataset.level, 'red',
  'an exhausted quota turns the accent red');

// 还没填每期总量 → remaining 为 null，显示 -- 而不是 0
w.handlers.stats({ ...stats, chipDisplay: { showQuota: true, showTokens: false, showCost: false },
  quotaSlot: { kind: 'credit', id: 'workbuddy', label: 'WorkBuddy', remaining: null, monthly: null } });
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
