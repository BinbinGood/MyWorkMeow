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
// 「某个东西必须保持退役」这类反向断言只能看**代码**：退役的理由本身就写在注释里
// （「inferHorizontalFrameClamp 曾是永真的死门，正是 E3/E4 环带的直接原因」），
// 拿整份文件去 test 会被自己的说明文字绊倒。只剥「整行都是注释」的行 —— 不按 // 的
// 位置切，避免把 'http://…' 之类字符串里的内容当注释、误删真代码而变成假通过。
const codeOnly = (src) => src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
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
// 2026-09-18（E2）：行动中心必须是 #stage 这条 flex 列的普通成员，**不能**按帧定位。
// 帧高恒为 PET_FRAME_H(744) 之后帧顶恒在猫上方约 600px，而且合法地悬在屏幕外（钳的是
// 猫本体，不是窗口），所以旧的 `position:absolute; top:14px` 会把它扔到屏幕外。
// 按帧底（bottom）定位同样不行：#stage.edge-below（猫贴屏幕顶）时整列翻成 flex-start、
// 帧底落到猫下方约 620px 的屏幕外，换个方向掉出去。只有交给 flex 列两个方向都对。
{
  const rule = css.match(/\.action-pop\s*\{[^}]*\}/)?.[0] || '';
  // `[;{\s]` 前缀是必要的：直接写 \btop: / \bbottom: 会连 margin-top / margin-bottom
  // 一起匹配（`-` 是非单词字符，\b 在它后面成立），而那两个是这条规则**应该**有的。
  assert(!/position:\s*absolute/.test(rule) && !/[;{\s]top:/.test(rule) && !/[;{\s]bottom:/.test(rule),
    'the action center must ride the #stage flex column, not the frame: with a constant 744px frame both the frame top (above the cat, off-screen) and the frame bottom (below the cat when edge-below) land outside the work area');
  assert(/width:\s*min\(496px/.test(rule),
    'the action center needs an explicit width now that left+right no longer stretch it: 496 = 520-24 keeps the horizontal geometry pixel-identical to the absolute-positioned version');
  // 猫贴屏幕顶时整列翻转，行动中心必须跟着 .bubble/.ask/.peek/.quota-popover 一起
  // 挪到猫**下方**，否则它会留在猫上方的屏幕外。
  assert(/#stage\.edge-below\s+\.action-pop\s*\{[^}]*order:\s*4/.test(css),
    'the action center must flip below the cat in edge-below, like every other popup in the column');
}
// 2026-09-18（E2）：帧高恒定是这次修复的本体。用户报的是「任务气泡点击出现，点其他
// 位置消失的时候……往上消失，然后再出现，给人的感觉还是卡卡的」。实测（probeF/probeI）：
// 开/关气泡时窗口高度与 y 原点分帧落地，屏幕上看到的相位错帧**幅度恰好等于帧高差**；
// 把 delta 人为压到 0 → 16/16 例零闪现，delta 原样 → 16 例中 7 例可见。
// 所以帧高不许再跟内容走。两处常量必须同源（改一处就得改两处），且 targetSize 不许
// 再读 customSize.h —— 否则弹窗态存下的高度会绕过恒定性、把 delta 放回来。
assert(/const PET_FRAME_H = POPUP_BOTTOM \+ ASK_VIEWPORT_MAX_H \+ 24;/.test(js),
  'the renderer frame height must stay derived from the popup budget, not hand-written');
assert(/const PET_FRAME_H = 744;/.test(main),
  'the main process frame height must stay pinned to the same 744 the renderer derives (POPUP_BOTTOM 200 + ASK_VIEWPORT_MAX_H 520 + 24)');
{
  const fn = main.match(/function targetSize\([\s\S]*?\n\}/)?.[0] || '';
  assert(/return \{ w, h: PET_FRAME_H \};/.test(fn) && !/customSize\.h/.test(fn),
    'targetSize must return the constant frame height and must not read customSize.h: a popup-time height stored in config would smuggle the frame-height delta (and E2s upward flash) back in');
}
{
  const fn = js.match(/function fitPopup\([\s\S]*?\n\}/)?.[0] || '';
  assert(!/winH/.test(fn) && (fn.match(/PET_FRAME_H/g) || []).length >= 2,
    'fitPopup must stop computing a frame height from content: both setRequestedPetSize passes send the constant PET_FRAME_H');
}
// 帧高恒定只有在窗口被允许悬出屏幕时才成立（猫上方那 ~600px 留白常在屏幕外），
// 这条由 makePetWindow 的 enableLargerThanScreen 撑着 —— 那一条另有 pin，见下。
// 存盘必须连帧高一起存：y 是帧原点、猫贴帧底，不存 h 的话旧配置（按 340 帧存的 y）
// 会被按 744 解读 → 猫下移 404px 再被钳回屏幕底，**升级后第一次启动就跳位**。
assert(/petPosition: \{ x: b\.x, y: b\.y, w: b\.width, h: b\.height \}/.test(main),
  'the persisted pet position must include the frame height: y is the frame origin and the cat sits at the frame bottom, so an old 340-frame y read as a 744 frame drops the cat 404px on first launch after the upgrade');
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
// 2026-09-17（F4）：钳猫方案的**前置条件**——桌宠窗口必须开 enableLargerThanScreen。
// 钳猫的地基是「窗口原点可以合法地悬出屏幕」（猫贴死屏幕缘时原点 = wa.x - 200），
// 而 macOS 默认不允许：AppKit 的 NSWindow constrainFrameRect:toScreen: 会钳回工作区。
// 它只在窗口**失焦**时钳（静息 / 气泡打开 / 纯改高度 / setAlwaysOnTop /
// setVisibleOnAllWorkspaces / 同矩形 setBounds 实测全不触发，原点稳在 -200），
// 而 closePeek() 里就有一次 window.pet.blurPet() → PET_BLUR → w.blur()：3ms 后原点
// 被钳到 wa.x，没有 will-move、没有任何 JS setBounds，随后 applyPetSize 忠实地按
// 这个已被污染的 b.x 反解，猫净移动 max(0, 200 - 离缘距离) px、方向恒朝屏幕中心。
// 用户原话：「主要喵处于边缘的环带内，打开气泡再关闭……自动移到靠中间的位置」。
// 实测 A/B（2 屏 × 左右缘 × 离缘 {0,40,199} × 4 轮）：关 = 48 例中 46 例漂移，
// 开 = 48/48 零漂移。
// 这条断言只能保证「这一行还在」。Electron 文档措辞是「resized larger than screen」
// 而不是「moved off screen」，所以语义若被上游收窄，静态检查是看不出来的 ——
// 升级 Electron 后必须手工复验贴边开关气泡。
{
  const petWin = main.match(/const win = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0] || '';
  assert(/transparent:\s*true/.test(petWin) && /backgroundColor:\s*'#00000000'/.test(petWin),
    'the first BrowserWindow in main.js must still be the transparent pet window');
  assert(/enableLargerThanScreen:\s*true/.test(petWin),
    'the pet window must set enableLargerThanScreen: macOS clamps an off-screen frame back into the work area on blur, and closePeek() blurs — that is what moves the cat toward screen centre (F4)');
}
// 胶囊比猫宽，居中在猫正下方时可能探出工作区。补偿走 --chip-shift（按需最小位移），
// 且必须是 transform —— margin 会挤压兄弟节点、把整列的布局宽度推出去。
assert(/\.chip\s*\{[\s\S]*?transform:\s*translateX\(var\(--chip-shift/.test(css),
  'the capsule must be nudged by transform, never by layout-affecting margins');
assert(/PetGeometry\.capsuleShift\(/.test(js) && /--chip-shift/.test(js),
  'the renderer must compute the capsule shift from the pet post-move screen position');
// 2026-09-17（F1）：位移必须封顶，而且渲染端必须把猫宽传下去。溢出量本身是无上限的 ——
// 猫被拖出屏幕时它随距离线性增长，于是胶囊被一路推回屏幕里、和猫脱开（用户原话：
// 「拖动喵到边缘，继续往边缘拖的时候，喵会移出屏幕，但是底部胶囊没有跟随，一直保持
// 在屏幕里面」）。上限含 margin，等于「猫贴死缘时那个位移」，所以出屏与贴边两种输入
// 算出同一个值 —— 松手后主进程钳猫**不通知渲染端**，渲染端手里那个「过期」出屏坐标
// 因此正好还是对的，不需要回报通道。算术与饱和性质由 test/pet-geometry.js 全扫。
{
  const fn = read('shared/pet-geometry.js').match(/function capsuleShift\([\s\S]*?\n  \}/)?.[0] || '';
  assert(/petWidth = PET_BODY_W/.test(fn) && /\(width - body\) \/ 2\) \+ pad/.test(fn),
    'capsuleShift must cap its displacement at the cat-flush-to-edge value: the raw overflow is unbounded and detaches the capsule from an off-screen cat');
  for (const caller of ['applyCapsuleShift', 'applyPopupShift']) {
    const src = js.match(new RegExp(`function ${caller}\\([\\s\\S]*?\\n\\}`))?.[0] || '';
    assert(/capsuleShift\(\{[\s\S]*?petWidth:/.test(src),
      `${caller} must forward petWidth so the cap tracks the real anchor width`);
  }
}
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
assert(!/inferHorizontalFrameClamp/.test(codeOnly(js)),
  'the horizontal frame-clamp inference must stay retired: nothing clamps the frame horizontally any more');
assert(/function restingFrameWidth\(\)/.test(js),
  'the resting frame width must have a single shared definition');
// 2026-09-17（F2）：帧宽必须**取偶**。用户实测：「喵处于大概上次那种环带区域，点击
// 出现气泡，点其他位置，气泡关闭后，喵有概率会移动位置，而且这个只在右边缘的时候
// 才出现。」#stage 恒 align-items:center → 猫的窗内偏移 = (帧宽-120)/2，帧宽为奇数时
// 它带 .5（真机 Electron 实测 F=521 时 #cat 的 getBoundingClientRect().left = 200.5）。
// 带小数的 screenX 进 anchoredPetOrigin 的 Math.round(x.5) 在 JS 里**恒向上**，
// applyPetSize 再由取整后的原点反推 inset、clampCatOrigin 又取一次整 —— 一次
// setPetSize 净 +1px。「有概率」= 帧宽碰巧是奇数才有；「只在右边缘」= 到处都在漂，
// 只有右缘会撞上 clampCatOrigin 的上界、饱和成一次可见的跳动。
// 奇数帧宽真的可达：measuredRestingWidth 读的是带小数的 getBoundingClientRect().width，
// 外面套 Math.ceil，520..900 之间任何奇数都产得出来（帧宽卡在 520 下限时才碰不到）。
// 漂移量的算术由 test/pet-edge-cycle.js 全扫（含奇数帧宽的反向对照）。
{
  const fn = js.match(/function restingFrameWidth\(\)[\s\S]*?\n\}/)?.[0] || '';
  assert(/return w \+ \(w % 2\);/.test(fn),
    'restingFrameWidth must force an even frame width: an odd width puts the cat at a .5 in-window offset, and two Math.round steps amplify it into +1px of one-way drift per popup open/close (F2)');
}
{
  const fn = js.match(/function fitRestingFrame\([\s\S]*?\n\}/)?.[0] || '';
  assert(/restingFrameWidth\(\)/.test(fn),
    'fitRestingFrame must use the same resting-width definition as the edge gate');
}
// 2026-09-18（E2）：inferVerticalFrameClamp 整体退役，和横向的 inferHorizontalFrameClamp
// 同一个论证。它的语义是「透明窗口已经被钳在工作区上缘、而猫还困在窗口的留白里」，
// 而竖直方向的钳制现在也换成了钳猫（main.js clampCatOriginY）：猫顶到工作区上缘就是
// 窗口能上到的极限，「窗口被拦住而猫没到边」这个状态不再存在，无从推断也无需推断。
// 钉的是**整体消失**而不是「值恒为 false」—— 上一次留下的死门（永真的
// inferHorizontalFrameClamp）正是 E3/E4 那条环带没被拦住的直接原因。
assert(!/inferVerticalFrameClamp/.test(codeOnly(js)),
  'the vertical frame-clamp inference must stay retired, not linger as an always-false expression: after clampCatOriginY the "window blocked but cat not at the edge" state cannot happen, and a dead gate is exactly what let the E3/E4 dead zones through');
// 弹窗布局只判竖直方向了：横向恒居中，帧宽涨到多少猫都停在原地，所以不再需要把
// 目标帧宽喂进几何层（旧的 popupWidth / popupHorizontal 已删）。
// 2026-09-18（E2）：帧高恒定后 height 也不必喂了 —— 它恒等于 PET_FRAME_H，喂进去
// 只是个常量。但 popupHeight **必须继续是弹窗内容的真实高度**：上/下让位的判据是
// 「猫上方放不放得下这个弹窗」，跟着帧高变成常量的话判据就永久失效。
assert(/popupEdgeLayout\(options\.popupHeight\)/.test(js),
  'the popup layout call must carry the popup CONTENT height, not the now-constant frame height: the above/below decision is about whether the content fits over the cat');
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
// **不能用 transform**：.bubble 有 `transition: opacity .25s, transform .25s` 且
// .bubble.hidden { transform: translateY(8px) scale(0.96) } —— 用 transform 承载
// --pop-shift 会被这条直接覆盖掉。历史上 .peek / .ask / .think 的入场 keyframes 也
// 都以 `transform: none` 收尾，同样会擦掉位移；那些 keyframes 现在已改成纯 opacity
// 淡入（见下面 E2 那条 pin），但只要有人把位移写成 transform，任何一次动画/过渡回归
// 都会重新踩中 —— 静态审查看不出来，只在屏幕上坏。
// **也不能用 margin**：margin 会挤压兄弟节点、把整列的布局宽度推出去（2026-09-16 的
// 教训，见上面 measuredRestingWidth 那段）。relative 的 left 和 transform 一样只在
// 绘制期偏移、不参与布局，所以不会喂回帧宽。
{
  const rule = css.match(/\.peek,\s*\.ask,\s*\.bubble,\s*\.think\s*\{[^}]*\}/)?.[0] || '';
  assert(/position:\s*relative;/.test(rule) && /left:\s*var\(--pop-shift/.test(rule),
    'the popup shift must ride on position:relative + left');
  assert(!/transform/.test(rule),
    'the popup shift must not use transform: .bubble transitions transform and .bubble.hidden sets one, which would erase the shift');
  assert(!/margin/.test(rule),
    'the popup shift must not use margin: margin squeezes siblings and inflates the column layout width');
}
// ── E2 收尾：弹层入场动画不许带几何变换 ─────────────────────────────────────────
// E2 是「气泡开关时画面卡卡的、往上消失再出现」。**窗口层已经彻底干净**：真机探针
// （/tmp/probeG1.py 阶段 1）连跑 20 轮开关，帧的 x/y/w/h 四个维度 delta 全为 0、
// bounds trace 长度恒为 1（整轮一次都没变）、猫的屏幕坐标漂移 [0,0]。恒高那半套
// （PET_FRAME_H 恒定、fitPopup 不跟内容改帧高）也同时拿到了第一份有效性证据：
// #peek 内容高度在 290↔133 之间跳了 157px，帧高一动不动。
//
// 剩下的抖动全部在**渲染层**，而且被逐帧 rAF 探针钉到了唯一一个元素上：
//   #cat   逐帧恒定 [200,599,120,120]
//   #stage 逐帧恒定 [0,0,520,744]
//   #peek  视觉顶边 295.2 → 283.8（移了 11.4px），跨 13~14 帧
// 11.4px 能被旧 keyframes 精确解释：translateY(7px) + scale(0.97) 对 290.2 高的卡片
// 造成 (290.2-281.5)/2 = 4.35px 的中心缩放偏移，7 + 4.35 = 11.35。transform 不进
// layout，所以这是纯视觉位移 —— 但 520px 宽的正文要按 0.97~1.0 的非整数比例逐帧
// 重采样，那就是用户反复说的「残影」。改成纯 opacity 淡入后两样都没了。
//
// 这条 pin 钉住「不许把位移加回来」。四个弹层同病同治，一起钉：
{
  // 用括号计数取块，不用正则：这些 keyframes 有单行写法（`@keyframes askIn { from {…} to {…} }`）
  // 也有多行写法，而 `[\s\S]*?\n\}` 在单行写法下会一路吃到后面**别的**规则的收尾花括号，
  // 把无关的 transform 算进来（第一版就这么误报了）。
  const keyframeBlock = (name) => {
    const at = css.search(new RegExp('@keyframes\\s+' + name + '\\s*\\{'));
    if (at < 0) return null;
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
    }
    return null;
  };
  for (const name of ['askIn', 'peekIn', 'quotaPopoverIn', 'thinkIn']) {
    const block = keyframeBlock(name);
    assert(block, `@keyframes ${name} must exist`);
    assert(!/transform/.test(block),
      `@keyframes ${name} must not animate transform: the translateY+scale entry slide is E2's remaining judder (11.4px of visual drift over ~13 frames, measured per-frame on a real window) and it also fights --pop-shift`);
    assert(/opacity/.test(block),
      `@keyframes ${name} must keep the opacity fade: it is the whole animation now`);
  }
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
