'use strict';

// Structural checks for the reduced pet surface. The cat keeps its state,
// radial menu, ask card and action center; the removed session window, language
// switcher, audio path, and old territory/loot visuals must not come back
// accidentally.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('renderer/pet.css');
const js = read('renderer/pet.js');
const html = read('renderer/pet.html');
const main = read('main.js');
const preload = read('preload.js');
const config = read('backend/config.js');
const i18n = read('shared/i18n.js');
const panel = read('renderer/panel.js');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

assert(/const POPUP_W = 520;/.test(js), 'popup measurement width must remain stable');
assert(/const ASK_VIEWPORT_MAX_H = 520;/.test(js), 'ask measurement must retain its height cap');
assert(/function fitPopup[\s\S]*el === askEl[\s\S]*ASK_VIEWPORT_MAX_H/.test(js), 'ask popup must keep dynamic sizing');
assert(/\.ask\s*\{[\s\S]*background\s*:\s*rgba\(255, 255, 255, 0\.98\)/.test(css), 'ask card styling must remain');

// 需要人工确认的弹窗曾经出过一次「样式表还停留在旧 DOM」的问题：CSS 里写着
// .ask-submit / .ask-input，而 HTML/JS 早就换成了 .ask-btn / .ask-other / #ask-text，
// 于是输入框和「返回 / 提交回答 / 去终端」三个按钮退化成浏览器默认样式，
// 跟整体设计语言完全不搭。这里把「每个真正用到的 class 都必须有样式」钉住。
{
  const askClasses = new Set();
  for (const m of (html + js).matchAll(/class=["'`]([^"'`]+)/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('ask-')) askClasses.add(c);
  }
  for (const m of js.matchAll(/classList\.(?:add|remove|toggle)\(\s*'([^']+)'/g)) {
    if (m[1].startsWith('ask-')) askClasses.add(m[1]);
  }
  // 由 JS 动态附加的状态类,不带 ask- 前缀,单独列出
  for (const c of ['sel', 'multi', 'warn', 'perm-row', 'primary', 'act', 'allow', 'deny', 'sugg']) {
    askClasses.add(c);
  }
  const unstyled = [...askClasses].filter(
    (c) => !new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![a-zA-Z0-9_-])`).test(css),
  );
  assert.deepStrictEqual(unstyled, [], `ask dialog classes without any CSS: ${unstyled.join(', ')}`);
  assert(!/\.ask-submit|\.ask-input\b/.test(css), 'stale ask CSS for the old DOM must not come back');
  assert(/#ask-text\s*\{/.test(css) && /#ask-text:focus/.test(css), 'the custom-answer input must stay styled');
  assert(/\.ask-btn\s*\{[\s\S]*?\}/.test(css) && /\.ask-btn\.primary\s*\{/.test(css),
    'ask footer buttons must keep the secondary/primary pair');
  assert(/\.ask-term\s*\{[^}]*background:\s*#5a3a2a/.test(css),
    'the go-to-terminal button must reuse the peek-focus dark fill');
  // 头尾固定、中部滚动:.ask 封顶必须和 pet.js 的 ASK_VIEWPORT_MAX_H 对齐,
  // 否则长问题会把顶栏和按钮挤出窗口。
  assert(/\.ask\s*\{[\s\S]*?max-height:\s*min\(520px/.test(css), 'ask card must cap at the JS viewport height');
  assert(/\.ask-scroll\s*\{[^}]*overflow-y:\s*auto/.test(css), 'only the ask body may scroll');
}
assert(/\.action-pop\s*\{/.test(css) && /id="action-pop"/.test(html), 'action center must remain');
assert(/id="ask"/.test(html) && /id="sessions"/.test(html), 'ask card and status dots must remain');
assert(/\.peek\s*\{/.test(css) && /id="peek"/.test(html), 'left-click work peek must remain');
assert(/\.peek-row-project\s*\{[^}]*display:\s*block[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s.test(css), 'long peek task titles must stay inside their grid column');
assert(/\.peek-row-detail\s*\{[^}]*display:\s*block[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis/s.test(css), 'peek task details must stay inside their grid column');
assert(/\.bubble\.hidden\s*\{[\s\S]*?display:\s*none;/.test(css), 'hidden completion bubbles must leave the flex layout');
assert(/\.chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*21px;/.test(css), 'resting capsule must keep its full height');
assert(/function handleCatClick\(\)[\s\S]*openPeek\(\)/.test(js), 'short cat click must route to the work peek');
assert(/const HIT_SEL = '[^']*#peek/.test(js), 'work peek must participate in transparent-window hit testing');
assert(/if \(!g\.moved && Math\.abs\(dx\) \+ Math\.abs\(dy\) > 4\) g\.moved = true/.test(js), 'drag threshold must remain ahead of click dispatch');

const sessionPopupRefs = /sesslist|sl-(?:rows|sub|title|back|session-view|loot|search|filters|archived-toggle|new|panel)|sessListOpen|toggleSessList|openSessList|closeSessList|renderSessList|setSessionPrefs|set-session-prefs/;
assert(!sessionPopupRefs.test(js + css + html + main + preload + config), 'session popup code and IPC must be removed');
assert(!/左键短按[^\n]*会话|会话列表 HUD/.test(js + css + html), 'cat click must not mention the removed session window');

const soundRefs = /muted|toggleMute|toggle-mute|AudioContext|webkitAudioContext|\bSOUND\b|\bbeep\s*\(/;
assert(!soundRefs.test(js + main + preload + config), 'sound playback and mute controls must be removed');
assert(!/\.(?:mp3|wav|ogg|m4a)\b/i.test(walk(path.join(root, 'assets')).join('\n')), 'audio assets must be removed');

assert(!/\bLANGS\b|\bsetLang\b|\bgetLang\b|tray\.language|lang\.(?:zh|en|ja)|cfg\.lang|config\.get\(\)\.lang/.test(main + js + panel + preload + config + i18n), 'language switching code must be removed');
assert(!/const (?:en|ja)\s*=/.test(i18n) && /const DICT = \{ zh \}/.test(i18n), 'only the Chinese dictionary must remain');
assert(/document\.documentElement\.lang = 'zh-CN'/.test(js) && /document\.documentElement\.lang = 'zh-CN'/.test(panel), 'renderers must stay in Chinese');

assert(/#stage\.edge-below\s*\{[^}]*justify-content\s*:\s*flex-start\s*;/s.test(css), 'top-edge layout must remain');
assert(/anchoredLayoutPayload/.test(js) && /choosePopupLayout/.test(js), 'popup sizing must preserve the visible pet anchor');
assert(/PetGeometry\.cornerMenuLayout/.test(js), 'radial menu geometry must remain bounded');
assert(/getWindowMetrics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(IPC\.GET_WINDOW_METRICS\)/.test(preload), 'radial menu must retain window metrics access');
assert(/ipcMain\.handle\(IPC\.GET_WINDOW_METRICS/.test(main), 'main process must retain window metrics IPC');

const radialSource = js.match(/const MENU = \[[\s\S]*?\n\];/)?.[0] || '';
assert(!/menu\.(?:pending|background)/.test(radialSource), 'radial menu must remove duplicate panel entries');
assert.strictEqual((radialSource.match(/window\.pet\.openPanel\(/g) || []).length, 1, 'radial menu must keep one detail entry');
assert(/menu\.privacy/.test(radialSource) && /'ON'[\s\S]*'OFF'/.test(radialSource),
  'radial menu must show the compact privacy ON/OFF action');
assert(!/menu\.quit|window\.pet\.quit/.test(radialSource), 'radial menu must leave whole-app quit in the tray');
assert(/const COMPACT_MENU = \[MENU\[2\], MENU\[0\], MENU\[1\]\];/.test(js),
  'hidden-cat actions must use their dedicated horizontal order');
assert(/function buildCompactRadial\(\)/.test(js) && /dataset\.layout = 'compact'/.test(js),
  'hidden-cat context menu must build a compact toolbar layout');
assert(/\.radial\[data-layout="compact"\] \.radial-compact\s*\{[\s\S]*?display:\s*flex;/.test(css),
  'hidden-cat context menu must render as a horizontal toolbar');
assert(/\.sessions\s*\{[\s\S]*?min-width:\s*120px;/.test(css), 'session dots must retain a centred minimum width');
assert(/#stage\.cat-hidden #compact-row \.sessions\s*\{[\s\S]*?min-width:\s*0;/.test(css),
  'compact session dots must shrink to their intrinsic width beside the capsule');
// ── 横向贴边（左右）与胶囊的按需内缩 ────────────────────────────────────────
// 这两条规则是「猫能真的贴到屏幕左右缘」的**唯一**实现：窗口 320 宽而猫只有 120
// 宽，左右各约 100px 透明留白，主进程 applyPetSize 会把窗口钳进工作区 —— 只有把
// 整列拉到窗口缘、让猫的窗内偏移变成 0，反解出的窗口原点才正好落在工作区缘上，
// 那 100px 不会被钳掉。2026-09-16 我误判这套是纯胶囊样式而删掉，用户实测「往左右
// 拖松开后自动处在比较靠中间的位置」，就是被钳走的那 100px。
assert(/#stage\.edge-left\s*\{[^}]*align-items\s*:\s*flex-start\s*;/s.test(css),
  'left-edge snapping must pull the column to the window edge');
assert(/#stage\.edge-right\s*\{[^}]*align-items\s*:\s*flex-end\s*;/s.test(css),
  'right-edge snapping must pull the column to the window edge');
// 光有 #stage 那条不够：列宽由最宽的孩子（胶囊）决定，不加这条**猫**仍停在列中央。
assert(/#stage\.edge-left:not\(\.cat-hidden\) #compact-row\s*\{[^}]*align-items\s*:\s*flex-start\s*;/s.test(css)
  && /#stage\.edge-right:not\(\.cat-hidden\) #compact-row\s*\{[^}]*align-items\s*:\s*flex-end\s*;/s.test(css),
  'the compact row must put the cat itself on the snapped side');
// 胶囊比猫宽，整列贴边时它会被带出去。补偿走 --chip-shift（按需最小位移），
// 且必须是 transform —— margin 会参与布局、量进 measuredRestingWidth，变成
// 「变宽 → 位移 → 又变宽」的自激。
assert(/\.chip\s*\{[\s\S]*?transform:\s*translateX\(var\(--chip-shift/.test(css),
  'the capsule must be nudged by transform, never by layout-affecting margins');
assert(/PetGeometry\.capsuleShift/.test(js) && /--chip-shift/.test(js),
  'the renderer must compute the capsule shift from the pet post-move screen position');
// 旧补丁不能回来：从前是贴边把整列甩过去、再给 .chip 补一个 justify-content: center
// 找回中心。那条既解决不了溢出，也和 --chip-shift 抢同一件事。
assert(!/#stage\.edge-(?:left|right)[^{]*\.chip\s*\{[^}]*justify-content/s.test(css),
  'the superseded justify-content patch on .chip must not return');
assert(/#compact-row\s*\{[\s\S]*?align-items:\s*center;/.test(css),
  'centred under the cat remains the default when not snapped to an edge');
// 单宠时代（2026-08-07 起）：不再有 per-tool 名牌，agent-tag 样式必须整体移除
assert(!/agent-tag/.test(css), 'per-tool agent tag styles must be gone (single unified pet)');
assert(/function positionProp\(\)[\s\S]*propEl\.style\.left/.test(js), 'action prop must use the visible cat geometry');
assert(!/#stage\.edge-right \.prop/.test(css), 'action prop must not use a fixed edge offset');
assert(/function pointerScreenX\(e\)/.test(js) && /function pointerScreenY\(e\)/.test(js), 'dragging must normalize pointer coordinates');
assert(/g !== gesture \|\| gesture\.win/.test(js), 'stale async window-position results must not cross drag gestures');
assert(/grabX:\s*pointerClientX\(e\)/.test(js) && /grabY:\s*pointerClientY\(e\)/.test(js),
  'dragging must preserve the in-window grab point');
assert(/screen\.getCursorScreenPoint\(\)/.test(main),
  'the main process must resolve drag movement from the authoritative OS cursor');
assert(/if \(nextX === b\.x && nextY === b\.y\) return/.test(main),
  'the main process must stop same-position BrowserWindow feedback');
assert(/lastEndedDragId === dragId/.test(main) && /IPC\.END_WIN_DRAG/.test(main),
  'released drag sessions must reject late move frames');
assert(/setWinPos:\s*\(x, y, dragOffset\)/.test(preload),
  'the preload bridge must forward the stable drag offset');
assert(/function queueDragMove[\s\S]*requestAnimationFrame/.test(js),
  'renderer drag messages must coalesce to one latest move per paint frame');
assert(/document\.addEventListener\('keydown',[\s\S]*e\.key !== 'Escape'[\s\S]*window\.pet\.closePanel\(\)/.test(panel), 'detail panel must close on Escape');

console.log('popup style checks passed');
