'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/settings.html');
const js = read('renderer/settings.js');
const css = read('renderer/settings.css');
const main = read('main.js');
const preload = read('preload.js');

for (const id of ['tab-expressions', 'asset-gallery', 'asset-inspector', 'asset-add', 'asset-replace', 'asset-remove',
  'asset-reset', 'asset-variants', 'remove-bg-toggle']) {
  assert(html.includes(`id="${id}"`), `settings must expose ${id}`);
}
assert(/img-src 'self' data: workmeow-asset:/.test(html), 'settings CSP must allow only the controlled custom asset scheme');
assert(html.includes('../shared/pet-assets.js'), 'settings must use the shared visual slot registry');
assert(/importPetGif\(selectedSlotId, mode/.test(js), 'the selected slot must drive imports');
assert(/importExpression\('append'\)/.test(js), 'adding a GIF must preserve the current playlist');
assert(/importExpression\('replace-one'\)/.test(js) && /assetId: mode === 'replace-one'/.test(js),
  'replacement must target the selected playlist item');
assert(/assetRemove\.addEventListener/.test(js) && /removePetAsset/.test(js) && /resetPetSlot/.test(js),
  'selected built-in or custom entries must be removable and the state must be resettable');
assert(/window\.confirm/.test(js), 'destructive playlist operations must require confirmation');
assert(/checkerboard/.test(css) && /asset-grid/.test(css) && /asset-action\.danger/.test(css),
  'the gallery must make transparency, every state, and destructive actions visually clear');
assert(/e\.sender !== settingsWin\.webContents/.test(main), 'mutating asset IPC must reject non-settings renderers');
assert(/filters: \[\{ name: 'GIF 动画', extensions: \['gif'\]/.test(main), 'native picker must be restricted to GIF files');
assert(/PET_ASSETS: 'pet-assets:changed'/.test(preload), 'live asset changes must be exposed to renderers');

// ── 底部展示栏：每个有效 Agent 一个额度开关 ──────────────────────────────────
// 2026-09-15 之前这里是一个会动态改名的「额度槽位」（接 Codex 就叫 Codex、否则
// 叫 WorkBuddy），于是「设置页写 Codex、托盘写 WorkBuddy」看着自相矛盾。现在按
// Agent 拆开：**检测到几个就渲染几个开关**，位置和名字都固定。
assert(html.includes('id="quota-agent-list"'), 'settings must host a per-agent quota list');
assert(html.includes('data-i18n="settings.quotaAgentsKicker"'), 'the per-agent list needs its section kicker');
assert(!html.includes('id="showQuota-toggle"'), 'the single dynamic quota slot toggle is gone');
assert(!/quota-slot-title|quota-slot-description/.test(html), 'the renamed slot title/description placeholders are gone');
assert(/quotaAgentList\s*=\s*\$\('quota-agent-list'\)/.test(js), 'the renderer must drive the list container');
assert(/window\.pet\.getQuotaAgents\(\)/.test(js), 'the list is populated from the main process agent roster');
assert(/quotaAgents:\s*\{\s*\[agent\.id\]/.test(js) && /trayAgents:\s*\{\s*\[agent\.id\]/.test(js),
  'each agent toggles two independent maps (bottom bar + tray), never rewriting the whole map');
assert(!/creditQuotaSection\.hidden/.test(js),
  'the hand-filled credit card must not appear and disappear dynamically');
// Codex / Credit / 无额度三种描述文案都要真存在 —— 这段走的是插值 key，
// i18n 的正则扫描抓不到，只能在这里显式钉住。拆成两个开关后，四个新 key 也要钉住。
for (const key of ['settings.quotaAgentsKicker', 'settings.quotaAgentCodexDescription',
  'settings.quotaAgentCreditDescription', 'settings.quotaAgentNoneDescription',
  'settings.agentChipLabel', 'settings.agentTrayLabel',
  'settings.agentChipToggle', 'settings.agentTrayToggle', 'settings.quotaAgentsLoading']) {
  assert(require('../shared/i18n').t(key) !== key, `i18n has ${key}`);
}

// ── 开关必须是真能点的 ────────────────────────────────────────────────────────
// 2026-09-16：曾给「没有额度数据的 Agent」（Claude / TRAE / opencode）加过 locked
// 分支 —— 灰掉 + disabled，理由是底部栏产不出额度徽标。用户实测的反馈是**那个灰
// 开关本身才像坏的**。这组开关现在管的是「显示这个 Agent 的信息」：底部栏的额度
// 徽标 + 托盘弹出菜单里那一行，后者对任何 Agent 都有 Token 和费用可看，所以一个
// 都不该锁。下面几条断言防止再锁回去。
//
// 断言只切 quotaAgentCard 这一段，不扫全文：全文十几处 disabled = true 都在做
// **保存期间**的防重入（点一下→disabled→await→finally 放开），那是对的写法。
const cardFn = /function quotaAgentCard\([\s\S]*?\n}\n/.exec(js);
assert(cardFn, 'quotaAgentCard must still exist');
const card = cardFn[0];
assert(!/switch-locked/.test(js), 'no agent toggle may be greyed out — every one of them does something');
assert(/button\.className = 'switch';/.test(card),
  'the toggle class is a plain literal — no conditional variant that grays some agents out');
assert(card.indexOf('addEventListener') < card.indexOf('return card;'),
  'every card wires up its click handler — no early return that skips it');
assert(card.split('return card;').length === 2,
  'quotaAgentCard has exactly one exit');
assert(/disabled = false/.test(card),
  'the in-flight guard must be released again, otherwise one click kills the toggle for good');

console.log('settings asset interaction contract checks passed');
