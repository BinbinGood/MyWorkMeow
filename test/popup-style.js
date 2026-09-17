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
// ── 横向：钳猫本体，不钳窗口 ────────────────────────────────────────────────
// 2026-09-17：横向贴边那半套（#stage.edge-left/.edge-right + 两条 #compact-row
// 覆盖）已退役。它从来不是功能，是变通 —— 那时主进程 applyPetSize 钳的是**透明
// 窗口**，窗口 520 宽而猫只有 120 宽、左右各 200px 留白，猫想待在离屏幕缘 200px
// 以内时窗口原点会被钳掉、猫被推走（屏幕左右各一条 200px 的「环带」，即用户报的
// E3/E4）。把整列 align-items 甩到窗口缘、让猫的窗内偏移变成 0，正是为了让反解出
// 的原点刚好落在工作区缘上、绕开那次钳制。
// 现在钳的对象换成猫本体（main.js clampCatOrigin），窗口原点允许悬出屏幕，工作区
// 内每个像素都直接可达 —— 真贴边自然成立，也不再有对齐翻转造成的中间帧（E1）。
assert(!/#stage\.edge-(?:left|right)[^\n]*\{/.test(css),
  'horizontal edge classes must stay retired: the clamp now targets the cat, so the band they worked around is gone');
assert(!/['"]edge-(?:left|right)['"]/.test(js),
  'the renderer must not toggle horizontal edge classes any more');
assert(/function clampCatOrigin\(/.test(main),
  'the main process must clamp the visible cat horizontally, not the transparent frame');
assert(!/x = Math\.min\(Math\.max\(x, wa\.x\), wa\.x \+ wa\.width - width\);/.test(main),
  'the old frame-clamping line must not return: it is what created the 200px dead band at each screen edge');
// 胶囊比猫宽，居中在猫正下方时可能探出工作区。补偿走 --chip-shift（按需最小位移），
// 且必须是 transform —— margin 会挤压兄弟节点、把整列的布局宽度推出去。
assert(/\.chip\s*\{[\s\S]*?transform:\s*translateX\(var\(--chip-shift/.test(css),
  'the capsule must be nudged by transform, never by layout-affecting margins');
assert(/PetGeometry\.capsuleShift\(/.test(js) && /--chip-shift/.test(js),
  'the renderer must compute the capsule shift from the pet post-move screen position');
// 2026-09-16：上一版注释在这里断言「transform 量不到 measuredRestingWidth 里去」，
// 那句话是错的。transform 不参与**布局**，但会把祖先的 scrollWidth 撑大：实测
// --chip-shift 从 0 到 204px，#compact-row.scrollWidth 从 275 变成 479（正好 +204），
// 而 .chip 自己仍是 275。measuredRestingWidth 读的就是 scrollWidth，于是位移原封
// 不动喂回帧宽 → 帧宽长过横向贴边判定的旧上限 → 猫被主进程钳离边缘一百多像素。
// 用户实测：「出现调用工具的尺寸/思考中，图标自动往中间移动了一点，不靠边了」。
// compactRow 本来就是冗余项（猫可见/隐藏两种模式下都恰等于 chip 宽度），移除零损失。
assert(/function measuredRestingWidth\(\)[\s\S]*?\n\}/.test(js), 'resting width measurement must remain');
{
  const fn = js.match(/function measuredRestingWidth\(\)[\s\S]*?\n\}/)[0];
  assert(!/compactRow/.test(fn),
    'measuredRestingWidth must not read #compact-row: .chip transform inflates its scrollWidth and feeds the shift back into the frame width');
  assert(/\[chip, sessionsEl\]/.test(fn),
    'resting width must come from the capsule and session dots themselves');
}
// 横向不能再引入任何「帧宽像素上限」当判据：静息帧宽是内容内蕴的（额度徽标全开时
// 胶囊 480 宽 → 帧宽 504），拿固定像素数去卡它维度上就是错的。竖直方向的帧高门保留。
assert(!/RESTING_FRAME_MAX_W/.test(js),
  'the horizontal snapping gate must not be reinstated as a fixed frame-width cap');
// 横向的 infer 门（inferHorizontalFrameClamp）也已随横向贴边一起退役。它存在的意义
// 是「窗口被钳住了但猫还没到边」这个状态，而钳猫之后这个状态不再存在。顺带一提：它
// 上一版是**永真**的死门（`windowRect.width <= restingFrameWidth() + 2`，而静息帧
// 恒等于 restingFrameWidth()），正是 E3/E4 那条 200px 环带没被拦住的直接原因。
assert(!/inferHorizontalFrameClamp/.test(js),
  'the horizontal frame-clamp inference must stay retired: nothing clamps the frame horizontally any more');
assert(/function restingFrameWidth\(\)/.test(js),
  'the resting frame width must have a single shared definition');
{
  const fn = js.match(/function fitRestingFrame\([\s\S]*?\n\}/)?.[0] || '';
  assert(/restingFrameWidth\(\)/.test(fn),
    'fitRestingFrame must use the same resting-width definition as the edge gate');
}
assert(/inferVerticalFrameClamp:\s*snapshot\.windowRect\.height <= RESTING_FRAME_MAX_H/.test(js),
  'the vertical frame-height gate must remain: a tall popup clamped to the screen top would masquerade as a top-edge drag');
// 弹窗布局只判竖直方向了：横向恒居中，帧宽涨到多少猫都停在原地，所以不再需要把
// 目标帧宽喂进几何层（旧的 popupWidth / popupHorizontal 已删）。
assert(/popupEdgeLayout\(height, options\.popupHeight\)/.test(js),
  'the popup layout call must only carry the vertical inputs it still needs');
assert(!/popupWidth/.test(js),
  'popupWidth must stay retired: horizontal popup alignment no longer exists');
// positionProp 的可用区间必须按**屏幕**算。窗口原点现在合法地可以悬出屏幕（单侧最多
// (帧宽-120)/2 ≈ 200px），猫贴住屏幕左缘时窗口左边那 200px 留白整块在屏幕外 ——
// 只按视口算会以为「左边还有 200px 空位」，把道具放到屏幕外。
{
  const fn = js.match(/function positionProp\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert(/browserWorkArea\(\)/.test(fn) && /window\.screenX/.test(fn),
    'positionProp must intersect the viewport with the work area, not assume the whole frame is on-screen');
}
assert(/#compact-row\s*\{[\s\S]*?align-items:\s*center;/.test(css),
  'the cat stays centred in its column: horizontal alignment no longer switches at all');
// ── 弹窗的按需内缩（--pop-shift）────────────────────────────────────────────
// 这一条补的是钳猫方案**差点漏掉**的后果，而且必须钉死，因为它替代的是一层**顺手的、
// 没人写下来的**保护：旧代码里 #stage.edge-left { align-items: flex-start } 把整列拉到
// 窗口左缘，而那个缘本身被钳在 wa.x —— 也就是说横向贴边那半套顺手保护了弹窗不出屏。
// 删掉横向贴边时这层保护一起没了：弹窗改由 #stage 的 align-items:center 居中在 520 宽
// 的窗口里，而钳猫之后窗口原点合法地悬出屏幕（猫贴死左缘时原点 = wa.x-200），于是
// .peek（320 宽）落在 wa.x-100、.ask / .bubble（340 宽）落在 wa.x-110 —— 探出屏幕被裁。
// 补偿走 --pop-shift（applyPopupShift 复用 capsuleShift 的「按需最小位移」口径）。
assert(/function applyPopupShift\(/.test(js) && /--pop-shift/.test(js),
  'popups must be nudged inward: after the cat-clamp, a centred popup hangs 100~110px off the screen edge');
// 位移必须落在 position:relative 的 left 上。
// **不能用 transform**：.peek / .ask / .think 的入场动画 keyframes 结尾就是
// `transform: none`（@keyframes peekIn / askIn / thinkIn），动画一跑完就把位移擦掉 ——
// 静态审查看不出来，只在屏幕上坏。.bubble 还额外有 transition: transform 和
// .bubble.hidden { transform: translateY(8px) scale(0.96) }。
// **也不能用 margin**：margin 会挤压兄弟节点、把整列的布局宽度推出去（2026-09-16 的
// 教训，见上面 measuredRestingWidth 那段）。relative 的 left 和 transform 一样只在
// 绘制期偏移、不参与布局，所以不会喂回帧宽。
{
  const rule = css.match(/\.peek,\s*\.ask,\s*\.bubble,\s*\.think\s*\{[^}]*\}/)?.[0] || '';
  assert(/position:\s*relative;/.test(rule) && /left:\s*var\(--pop-shift/.test(rule),
    'the popup shift must ride on position:relative + left');
  assert(!/transform/.test(rule),
    'the popup shift must not use transform: the peek/ask/think entry keyframes end at `transform: none` and would erase it');
  assert(!/margin/.test(rule),
    'the popup shift must not use margin: margin squeezes siblings and inflates the column layout width');
}
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
