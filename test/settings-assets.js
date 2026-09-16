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
// 注意锚在 id=" 上，不能用裸子串：菜单栏那组开关叫 menuBar-showQuota-toggle，
// 裸子串会把它误判成复活的旧槽位。
assert(!html.includes('id="showQuota-toggle"'), 'the single dynamic quota slot toggle is gone');
assert(!/quota-slot-title|quota-slot-description/.test(html), 'the renamed slot title/description placeholders are gone');
assert(/quotaAgentList\s*=\s*\$\('quota-agent-list'\)/.test(js), 'the renderer must drive the list container');
assert(/window\.pet\.getQuotaAgents\(\)/.test(js), 'the list is populated from the main process agent roster');
assert(/quotaAgents:\s*\{\s*\[agent\.id\]/.test(js), 'toggling must patch one agent, never rewrite the whole map');
assert(!/creditQuotaSection\.hidden/.test(js),
  'the hand-filled credit card must not appear and disappear dynamically');
// Codex / Credit / 无额度三种描述文案都要真存在 —— 这段走的是插值 key，
// i18n 的正则扫描抓不到，只能在这里显式钉住。
for (const key of ['settings.quotaAgentsKicker', 'settings.quotaAgentCodexDescription',
  'settings.quotaAgentCreditDescription', 'settings.quotaAgentNoneDescription',
  'settings.quotaAgentToggle', 'settings.quotaAgentsLoading']) {
  assert(require('../shared/i18n').t(key) !== key, `i18n has ${key}`);
}

// ── 屏幕顶部菜单栏（macOS）────────────────────────────────────────────────────
// 2026-09-16 新增。三条容易回归的性质：
//   1. 四个开关必须都在，且 id 前缀 menuBar- 不能和底部展示栏那四个撞
//   2. 走现成的 SET_CHIP_DISPLAY 通道（新开 channel 要改 preload.js 手抄副本）
//   3. 非 macOS 必须把整段移除 —— Electron 在 Windows/Linux 上 setTitle 是
//      no-op，留着四个点了没反应的开关比没有更糟
assert(html.includes('id="menu-bar-section"'), 'settings must host the menu-bar section');
for (const key of ['showStatus', 'showQuota', 'showTokens', 'showCost']) {
  assert(html.includes(`id="menuBar-${key}-toggle"`), `the menu bar needs a ${key} toggle`);
}
assert(/setChipDisplay\(\{ menuBar:/.test(js), 'the menu bar rides the existing chip-display channel');
assert(/menuBar:\s*\{\s*\[key\]/.test(js), 'toggling must patch one key, never rewrite the whole object');
assert(/section\.remove\(\)/.test(js), 'non-macOS must drop the whole section, not show dead toggles');
assert(/patch\.menuBar = merged/.test(main), 'the main process must merge menu-bar keys instead of overwriting');
assert(/refreshTrayTitle\(\)/.test(main), 'saving must refresh the menu bar right away');
assert(/title === lastTrayTitle/.test(main),
  'setTitle must short-circuit on unchanged text — emitStats runs every 4s');
for (const key of ['settings.menuBarSection', 'settings.menuBarShowStatus', 'settings.menuBarShowQuota',
  'settings.menuBarShowTokens', 'settings.menuBarShowCost', 'settings.menuBarHint', 'settings.menuBarSaved']) {
  assert(require('../shared/i18n').t(key) !== key, `i18n has ${key}`);
}

console.log('settings asset interaction contract checks passed');
