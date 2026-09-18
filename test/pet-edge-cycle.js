'use strict';

// 「开弹窗 / 关弹窗不能把猫挪走」的端到端回归。
//
// 为什么单独一个 suite：test/pet-geometry.js 只能验 shared/pet-geometry.js 这一段
// 纯函数，而用户看到的那些 bug 都不在任何单个函数里 —— 它们出在**链条**上：
//   渲染端 choosePopupLayout / chooseRestingLayout 选方向
//   → anchoredLayoutPayload 反推「猫该落在哪个屏幕像素」
//   → 主进程 anchoredPetOrigin 反解窗口原点
//   → applyPetSize 钳制
// 每一环单独看都对，合起来猫平移 200px。2026-09-16 我在这条链上连栽三次（详见
// test/popup-style.js 的注释），静态推理两次给出错答案，所以这里改成跑真实序列、
// 断言猫的屏幕像素**逐格不变**。
//
// 2026-09-17 大改：钳制对象从**窗口帧**换成**猫本体**（main.js clampCatOrigin）。
// 旧模型里横向有三种对齐（left/center/right）和两条 infer 吸附分支，那整套是为了
// 绕开「钳窗口」而存在的变通 —— 窗口 520 宽而猫 120 宽、左右各 200px 透明留白，
// 猫想待在离屏幕缘 200px 以内时窗口原点会被钳掉、猫被推走（屏幕左右各一条 200px
// 的「环带」，即用户报的 E3/E4）。钳猫之后横向恒居中、工作区内每个像素都可达，
// 所以模型里的 horizontal 维度整体退役，换成下面的可达性全扫。
//
// 模型的忠实度靠文件末尾那组「源码仍然长这样」的断言兜住：下面每个公式旁边都注了
// 它抄自哪一行，末尾再用正则确认那些行还在。模型漂了就会红，而不是静静地通过。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const geometry = require('../shared/pet-geometry');

const root = path.join(__dirname, '..');
const petJs = fs.readFileSync(path.join(root, 'renderer/pet.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const petCss = fs.readFileSync(path.join(root, 'renderer/pet.css'), 'utf8');

// 「某个东西必须保持退役」这类反向断言只能看**代码**：退役的理由本身就写在注释里
// （「inferHorizontalFrameClamp 曾是永真的死门，正是 E3/E4 环带的直接原因」），
// 拿整份文件去 test 会被自己的说明文字绊倒。只剥「整行都是注释」的行 —— 不按 // 的
// 位置切，避免把 'http://…' 之类字符串里的内容当注释、误删真代码而变成假通过。
const codeOnly = (src) => src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
const petJsCode = codeOnly(petJs);
const mainJsCode = codeOnly(mainJs);

const CAT = 120;        // #cat 是 120×120
const CAT_H = 120;      // #cat 同样写死 120 高，且无 transform
const POPUP_W = 520;    // renderer/pet.js 的 POPUP_W

// ── 竖直常量（2026-09-18，E2）────────────────────────────────────────────────
// 帧高从「跟着内容变」改成**恒定** 744 = POPUP_BOTTOM(200) + ASK_VIEWPORT_MAX_H(520) + 24。
// 实测（probeF/probeI）：开关气泡时窗口高度与 y 原点分帧落地，屏幕上看到的相位错帧
// 幅度**恰好等于帧高差**；把差压到 0 → 16/16 例零闪现。所以 delta 归零就是修法本身。
// 旧的 `const FRAME_H = 340; // BASE_H` 是个定义后从未使用的死变量，这里换成真在用的一组。
const FRAME_H_CONST = 744;   // main.js / renderer/pet.js 的 PET_FRAME_H
const BASE_FRAME_H = 340;    // 老配置（petPosition 无 h）与测试桩的兜底口径
const BELOW_RESERVE = 28;    // main.js RESTING_BELOW_RESERVE：猫下方胶囊那一截

// 猫在窗口里的横向偏移。横向贴边退役后 #stage 恒 align-items: center，所以这是
// 一个只由帧宽决定的常量 —— 不再依赖任何「对齐」状态。这个 inset 就是窗口原点
// 允许悬出屏幕的最大量。
const catInset = (frameW) => (frameW - CAT) / 2;

// renderer/pet.js anchoredLayoutPayload 的 xOffset —— 注意 viewportW 是**当前**帧宽
// （窗口还没 resize），而 main.js 反解时用的是**目标**帧宽。这个不对称是真实存在的，
// 模型必须照抄，不能图省事两边都用目标帧宽。
function anchorXOffset(frameNow) {
  return catInset(frameNow) + CAT / 2 - frameNow / 2;
}

// main.js anchoredPetOrigin 的 localX（center 分支；left/right 两条留着只为兼容
// 旧锚点，渲染端恒发 center，所以模型只走这一条）。
function anchorLocalX(frameTarget, xOffset) {
  return frameTarget / 2 + xOffset - CAT / 2;
}

// 一次 setPetSize：从（当前窗口原点、当前帧宽）走到（目标帧宽），返回主进程实际
// 落定的窗口原点与猫的屏幕位置。
//
// 关键改动：钳的是**猫**。猫钳进 [wa.x, waRight - CAT]，再按 inset 反解原点 ——
// 原点因此允许 < wa.x 或 > waRight - frameTarget，这正是环带消失的原因。
// 抄自 main.js clampCatOrigin + applyPetSize 的横向分支。
function step(workArea, winX, frameNow, frameTarget) {
  const waRight = workArea.x + workArea.width;
  const screenX = winX + catInset(frameNow);

  const xOffset = anchorXOffset(frameNow);
  const localX = anchorLocalX(frameTarget, xOffset);
  const rawCatX = Math.round(screenX - localX) + catInset(frameTarget);

  // clampCatOrigin：钳猫，再反解原点。
  const maxCatX = Math.max(workArea.x, waRight - CAT);
  const catX = Math.min(Math.max(rawCatX, workArea.x), maxCatX);
  const settled = Math.round(catX - catInset(frameTarget));
  return { winX: settled, catX: settled + catInset(frameTarget) };
}

// ── 竖直向模型（2026-09-18，E2）──────────────────────────────────────────────
// 抄自 main.js clampCatOriginY + applyPetSize 的竖直分支，以及渲染端
// anchoredLayoutPayload 的 yAlign / yOffset。两种布局：
//   yAlign 'bottom'（edgeLayout.vertical === 'above'，常态）：#stage 是
//     justify-content:flex-end，整列贴帧**底** → 猫下方那一截（belowContent，
//     胶囊 margin-top 2 + min-height 21 那种）是真内容，必须整段可见。
//   yAlign 'top'（#stage.edge-below，猫贴屏幕顶）：整列贴帧**顶**，猫是
//     order:0 排第一 → 猫上方几乎没东西（aboveContent≈0），猫下方那 600 多像素
//     是空的透明帧尾、**不是**内容，所以下界只保护 RESTING_BELOW_RESERVE。
function catLocalY(frameH, layout) {
  return layout.yAlign === 'top' ? layout.aboveContent : frameH - layout.belowContent - CAT_H;
}

// 一次 setPetSize 的竖直分支：从（当前窗口 y、当前帧高）走到（目标帧高）。
// 注意 yOffset 用**当前**帧高量（渲染端 viewportH 是 window.innerHeight，窗口还没
// resize），而 localY 用**目标**帧高反解 —— 和横向那个不对称同源，模型必须照抄。
function stepY(workArea, winY, frameNow, frameTarget, layout) {
  const catScreenY = winY + catLocalY(frameNow, layout);
  // anchoredLayoutPayload：yOffset = yAlign === 'top' ? rect.top : viewportH - rect.bottom
  const yOffset = layout.yAlign === 'top' ? layout.aboveContent : layout.belowContent;
  // anchoredPetOrigin：localY = yAlign === 'top' ? yOffset : height - yOffset - anchor.height
  const localY = layout.yAlign === 'top' ? yOffset : frameTarget - yOffset - CAT_H;
  const anchoredY = Math.round(catScreenY - localY);
  const insetY = catScreenY - anchoredY;            // applyPetSize: anchor.screenY - anchored.y
  const belowReserve = layout.yAlign === 'bottom'
    ? Math.max(0, frameTarget - insetY - CAT_H)
    : BELOW_RESERVE;
  // clampCatOriginY：上界只要求猫顶 >= wa.y（猫上方那几百像素透明留白允许悬出屏幕
  // 上方，靠 enableLargerThanScreen 撑着）；下界连猫下方的内容一起保护。
  const maxCatY = Math.max(workArea.y, workArea.y + workArea.height - CAT_H - belowReserve);
  const clamped = Math.min(Math.max(catScreenY, workArea.y), maxCatY);
  const settledWinY = Math.round(clamped - insetY);
  return { winY: settledWinY, catY: settledWinY + insetY, insetY, belowReserve };
}

// 该屏幕上的实际帧高：main.js applyPetSize 的 `h = Math.min(h, wa.height)`。
const effFrameH = (workArea) => Math.min(FRAME_H_CONST, workArea.height);


//
// 钳猫之后横向不再有「两种对齐来回摆动」的可能（对齐维度整体没了），所以这里预期
// **一轮**就收敛。上界仍留 6 轮并断言收敛：真正不能接受的是来回摆动，那会让猫抽搐。
function settleToFixpoint(workArea, restingW, winX, where) {
  let cur = winX;
  for (let round = 1; round <= 6; round++) {
    const next = step(workArea, cur, restingW, restingW);
    if (next.winX === cur) {
      return { winX: cur, catX: next.catX, rounds: round };
    }
    cur = next.winX;
  }
  assert.fail(`${where}：落位 6 轮仍未收敛（最后停在窗口 x=${cur}）`);
}

// 完整一轮：落位到不动点 → 开弹窗（fitPopup 会连下发两拍，第三拍验幂等）→ 关弹窗
// （closePeek → resetPetSize → fitRestingFrame，此时窗口还是 520 宽）→ 再落位。
//
// 入参是**猫的屏幕位置**（不再是窗口原点）。这是钳猫带来的简化：以前窗口位置才是
// 权威量、猫的位置是推出来的，而且「猫离左缘 199px」这种输入在静息帧 688 时根本
// 不可达（窗口早被钳过）；现在工作区内每个猫位置都可达，按猫铺点才是对的维度。
function cycle(workArea, restingW, catX0, where) {
  const winX0 = Math.round(catX0 - catInset(restingW));
  const rest = settleToFixpoint(workArea, restingW, winX0, where);

  let cur = { winX: rest.winX, frame: restingW };
  const popupBeats = [];
  const popupWins = [];
  for (let beat = 0; beat < 3; beat++) {
    const next = step(workArea, cur.winX, cur.frame, POPUP_W);
    cur = { winX: next.winX, frame: POPUP_W };
    popupBeats.push(next.catX);
    popupWins.push(next.winX);
  }

  const closed = step(workArea, cur.winX, POPUP_W, restingW);
  const resettled = step(workArea, closed.winX, restingW, restingW);

  return {
    resting: rest.catX,
    restingRounds: rest.rounds,
    restingWin: rest.winX,
    popupBeats,
    popupWin: cur.winX,
    popupWins,
    closed: closed.catX,
    resettled: resettled.catX,
  };
}

// 屏幕清单覆盖真实 Mac 的常见与极端情形，含负原点的外接屏（工作区不是从 0 开始，
// 任何把 workArea.x 当 0 的算术都会在这里露出来）。
// 前两条是**用户这台机器实测**的工作区（Electron screen.getAllDisplays 探到的原值，
// 主屏 scale 2、副屏 scale 1 且原点为负）。F2 那个漂移只有在真实屏幕参数下才出现在
// 用户看到的那个位置上，而上一版清单里**没有任何一条**匹配他的机器 —— 这也是为什么
// 这个 suite 一直绿着而屏幕上在漂。别删这两条。
const SCREENS = [
  [{ x: 0, y: 30, width: 1680, height: 956 }, '真机主屏 1680×1050@2x'],
  [{ x: -1998, y: -1410, width: 2560, height: 1410 }, '真机副屏 2560×1440（负原点）'],
  [{ x: 0, y: 24, width: 1440, height: 876 }, '1440×900'],
  [{ x: 0, y: 24, width: 1728, height: 1085 }, '1728 MBP14'],
  [{ x: 0, y: 24, width: 1024, height: 744 }, '1024 最窄 Mac'],
  [{ x: 1440, y: 0, width: 1920, height: 1080 }, '外接屏 x=+1440'],
  [{ x: -1920, y: 0, width: 1920, height: 1080 }, '外接屏 x=-1920'],
  [{ x: 0, y: 24, width: 3440, height: 1416 }, '3440 带鱼屏'],
];

// 静息帧宽是**内容内蕴**的（胶囊 + 会话点，320～900）：320 = 无徽标，438 = 两个额度，
// 504 = 额度徽标全开，688/900 = 极端。这一维必须扫，因为 2026-09-16 那个回归正是
// 「拿一个固定像素上限去卡静息帧宽」造成的 —— 504 的合法静息帧被当成弹窗帧。
//
// 2026-09-17（F2）：这一串**全是偶数**，而且必须全是偶数 —— 因为 restingFrameWidth()
// 现在强制取偶。上一版这里同样全是偶数，但那是**巧合**，不是约束，于是「帧宽为奇数
// 时猫每开关一轮气泡右移 1px」这条链路一次都没被覆盖过，suite 绿着而屏幕上在漂。
// 下面 ODD_WIDTHS 那组是反向对照：它断言奇数帧宽**确实会**漂，所以这一串一旦被换成
// 奇数、或 restingFrameWidth() 的取偶被删掉，立刻红。
const RESTING_WIDTHS = [320, 438, 504, 520, 522, 688, 690, 900];

// F2 的反向对照：奇数帧宽**确实**会漂。这一组不是「期望的行为」，而是「病灶还在原地」
// 的证据 —— 它保证上面那串偶数不是靠巧合过的。
const ODD_WIDTHS = [521, 523, 689, 899];

// 每一轮共用的断言：从落位收敛后的位置起，开关一轮弹窗，猫必须一格不动。
function assertStable(where, r) {
  for (const [beat, catX] of r.popupBeats.entries()) {
    assert.strictEqual(catX, r.resting,
      `${where}：开弹窗第 ${beat + 1} 拍把猫从 ${r.resting} 挪到了 ${catX}`);
  }
  assert.strictEqual(r.closed, r.resting,
    `${where}：关弹窗把猫从 ${r.resting} 挪到了 ${r.closed}`);
  assert.strictEqual(r.resettled, r.resting,
    `${where}：关弹窗后再落位把猫挪到了 ${r.resettled}`);
}

// ── 回归 F2：连续开关多轮，猫不许**累积**位移 ─────────────────────────────────
// 用户实测（F2）：「如果喵处于大概上次那种环带区域，点击出现气泡，点其他位置，气泡
// 关闭后，喵有概率会移动位置，而且这个只在右边缘的时候才出现。」
//
// 为什么 assertStable 抓不到它：assertStable 只跑**一轮**开关。这个 bug 是每轮 +1px
// 的单向漂移 —— 一轮内 popupBeats / closed / resettled 之间确实都相等（漂移发生在
// 「落位 → 开弹窗」这一跳，而 resting 是从**漂过之后**的状态重新量的），要连续跑好几
// 轮、和**最初**的位置比才看得见。所以这里单独一条：链式跑 N 轮，只比首尾。
//
// 成因：#stage 恒 align-items:center → 猫的窗内偏移 inset = (帧宽-120)/2，帧宽为奇数
// 时它带 .5（真机 Electron 实测 F=521 时 #cat 的 getBoundingClientRect().left = 200.5）。
// 带小数的 screenX 进 anchoredPetOrigin 的 Math.round(x.5) 在 JS 里**恒向上**，
// applyPetSize 再由取整后的原点反推 inset、clampCatOrigin 又取一次整 —— 净 +1px/轮。
// 「有概率」= 帧宽碰巧是奇数才有；「只在右边缘」= 到处都在漂，只有右缘会撞上
// clampCatOrigin 的上界、饱和成一次可见的跳动。
// 修法在 renderer/pet.js restingFrameWidth()：帧宽强制取偶，inset 恒为整数。
const DRIFT_ROUNDS = 8;
function chainCycles(workArea, restingW, catX0, rounds) {
  let win = Math.round(catX0 - catInset(restingW));
  for (let round = 1; round <= 6; round++) {
    const next = step(workArea, win, restingW, restingW);
    if (next.winX === win) break;
    win = next.winX;
  }
  const start = win + catInset(restingW);
  let frame = restingW;
  for (let k = 0; k < rounds; k++) {
    for (let beat = 0; beat < 3; beat++) {
      const next = step(workArea, win, frame, POPUP_W);
      win = next.winX;
      frame = POPUP_W;
    }
    let next = step(workArea, win, POPUP_W, restingW);
    win = next.winX;
    frame = restingW;
    next = step(workArea, win, restingW, restingW);
    win = next.winX;
  }
  return { start, end: win + catInset(restingW) };
}
{
  let driftChecked = 0;
  for (const [workArea, label] of SCREENS) {
    const waRight = workArea.x + workArea.width;
    for (const restingW of RESTING_WIDTHS) {
      for (let catX = workArea.x; catX <= waRight - CAT; catX += 7) {
        const r = chainCycles(workArea, restingW, catX, DRIFT_ROUNDS);
        driftChecked++;
        assert.strictEqual(r.end, r.start,
          `${label} 静息帧${restingW} 猫x=${catX}：连开关 ${DRIFT_ROUNDS} 轮气泡后猫从 `
          + `${r.start} 漂到了 ${r.end}（偏 ${r.end - r.start}px）—— 每轮 1px 的单向漂移，`
          + 'assertStable 只看一轮所以看不见，成因是帧宽为奇数导致 inset 带 .5');
      }
    }
  }
  assert(driftChecked > 3000, `漂移扫描覆盖太少（只有 ${driftChecked} 个位置）`);

  // 反向对照：奇数帧宽**必须**还在漂。这一条证明上面那组偶数不是靠巧合绿的 ——
  // 如果哪天 step() 的模型被改成两边都不漂，这里会红，提示模型已经不代表真实链条。
  let oddDrift = 0;
  for (const [workArea] of SCREENS) {
    const waRight = workArea.x + workArea.width;
    for (const restingW of ODD_WIDTHS) {
      for (let catX = workArea.x; catX <= waRight - CAT; catX += 37) {
        const r = chainCycles(workArea, restingW, catX, DRIFT_ROUNDS);
        if (r.end !== r.start) oddDrift++;
      }
    }
  }
  assert(oddDrift > 100,
    `奇数帧宽本该漂移（这是 F2 的病灶），实测只漂了 ${oddDrift} 个位置 —— `
    + '要么模型失真了，要么取偶之外还有别的改动，两种情况都需要重新看一遍');

  // 取偶必须真的落在源码里：模型验的是「偶数不漂」，而现实里帧宽由 restingFrameWidth()
  // 决定。它一旦不取偶，奇数帧宽就真的可达（measuredRestingWidth 读的是带小数的
  // getBoundingClientRect().width，Math.ceil 之后任何奇数都产得出来）。
  assert(/function restingFrameWidth\(\)[\s\S]*?return w \+ \(w % 2\);/.test(petJs),
    'restingFrameWidth 必须强制返回偶数帧宽：奇数帧宽会让猫的窗内偏移带 .5，'
    + '两次 Math.round 把它放大成每开关一轮气泡 +1px 的单向漂移（F2）');
}

// ── 回归一：贴边时开弹窗，猫的横向位置不能变，而且必须真的贴住边 ───────────────
// 用户实测：「喵在靠边的位置，点击以后，弹出来的气泡会自动把喵移动到靠中间的位置，
// 关了气泡以后，又回到边缘了」。
// 这里额外断言猫**真的贴在**工作区缘上 —— 光「不动」不够，还得确认真贴边没坏
// （那正是 6e4e998 那次回归：猫停在离边缘一百多像素的地方，稳定地不动）。
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    for (const [name, catX] of [
      ['猫贴死左缘', workArea.x],
      ['猫贴死右缘', waRight - CAT],
    ]) {
      const where = `${label} 静息帧${restingW} ${name}`;
      const r = cycle(workArea, restingW, catX, where);
      assertStable(where, r);
      assert.strictEqual(r.resting, catX,
        `${where}：猫应该贴在工作区缘 ${catX}，实际停在 ${r.resting}（真贴边坏了）`);
    }
  }
}

// ── 回归二：可达性全扫 —— 环带必须不存在 ──────────────────────────────────────
// 这一条是这次改动的**正面**证明，也是最重要的一条。用户报的 E3/E4 原话：「在屏幕
// 左右边缘有一个环带，只要喵拖到这个区域，会自动根据距离，往中间移动，或者往边缘
// 移动」。环带宽 = (帧宽 - 猫宽)/2，帧宽 520 时是 200px。
//
// 断言：工作区内**每一个**猫位置（逐 1px）落位后都必须原地不动。环带一旦以任何形式
// 回来，某一段 x 会被搬动，这里立刻红。这比「钉几个边界点」强得多 —— 上一版就是逐点
// 期望值写错过（1240 写成 center，实际是 right）。
let reachable = 0;
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    for (let catX = workArea.x; catX <= waRight - CAT; catX += 1) {
      const winX = Math.round(catX - catInset(restingW));
      const settled = step(workArea, winX, restingW, restingW);
      reachable++;
      assert.strictEqual(settled.catX, catX,
        `${label} 静息帧${restingW}：猫想待在 x=${catX}，却被搬到了 ${settled.catX}`
        + `（离左缘 ${catX - workArea.x}px、离右缘 ${waRight - CAT - catX}px —— 环带回来了）`);
    }
  }
}
assert(reachable > 40000, `可达性扫描覆盖太少（只有 ${reachable} 个位置）`);

// 真的超出工作区才允许被钳回边缘 —— 钳制本身还得在，不能为了消环带把猫放飞。
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    const inset = catInset(restingW);
    for (const [name, catX, expect] of [
      ['猫探出左缘 300px', workArea.x - 300, workArea.x],
      ['猫探出右缘 300px', waRight - CAT + 300, waRight - CAT],
    ]) {
      const settled = step(workArea, Math.round(catX - inset), restingW, restingW);
      assert.strictEqual(settled.catX, expect,
        `${label} 静息帧${restingW} ${name}：猫必须被钳回 ${expect}，实际 ${settled.catX}`);
    }
  }
}

// ── 回归三：屏幕中间开弹窗再关掉，猫不能被搬走 ───────────────────────────────
// 关弹窗时 restingEdgeLayout 会在窗口还是 520 宽的时候先跑一次。旧代码里 infer 分支
// 认的却是静息帧那点留白，于是屏幕中间的猫被误判成贴边 —— 实测猫 x=200 被搬到 0、
// x=1180 被搬到 1320，**而且关掉气泡也回不来**（永久位移）。
// 猫落在 199/200/201 这几个点是刻意构造的：那正是旧环带的边界。
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    for (const [name, wantCatX] of [
      ['屏幕正中', workArea.x + Math.round((workArea.width - CAT) / 2)],
      ['猫离左缘 1px', workArea.x + 1],
      ['猫离左缘 30px', workArea.x + 30],
      ['猫离左缘 80px', workArea.x + 80],
      ['猫离左缘 150px', workArea.x + 150],
      ['猫离左缘 199px', workArea.x + 199],
      ['猫离左缘 200px', workArea.x + 200],
      ['猫离左缘 201px', workArea.x + 201],
      ['猫离左缘 260px', workArea.x + 260],
      ['猫右缘离右缘 200px', waRight - CAT - 200],
      ['猫右缘离右缘 199px', waRight - CAT - 199],
      ['猫右缘离右缘 30px', waRight - CAT - 30],
    ]) {
      if (wantCatX < workArea.x || wantCatX > waRight - CAT) continue;
      const where = `${label} 静息帧${restingW} ${name}`;
      const r = cycle(workArea, restingW, wantCatX, where);
      assertStable(where, r);
      assert.strictEqual(r.resting, wantCatX,
        `${where}：猫被误判成贴边，从 ${wantCatX} 搬到了 ${r.resting}`);
    }
  }
}

// ── 全扫：任何猫位置、任何静息帧宽、任何屏幕都不许在开关弹窗时动猫 ─────────────
let checked = 0;
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    for (let catX = workArea.x; catX <= waRight - CAT; catX += 3) {
      const where = `${label} 静息帧${restingW} 猫x=${catX}`;
      const r = cycle(workArea, restingW, catX, where);
      checked++;
      assertStable(where, r);

      // ── 窗口允许悬出屏幕，但猫不许 ──
      // 这一条替换了上一版「弹窗帧必须完整落在工作区内」的断言。那条断言在钳猫之后
      // **本来就该是假的** —— 窗口原点合法地悬出屏幕正是环带消失的机制。但它当时守的
      // 东西是真的（弹窗内容不能被裁），所以拆成两条：这里管猫，下面管内容。
      assert(r.resting >= workArea.x - 0.5 && r.resting + CAT <= waRight + 0.5,
        `${where}：猫（${r.resting}..${r.resting + CAT}）跑出了工作区`);
      for (const [beat, w] of r.popupWins.entries()) {
        const cat = w + catInset(POPUP_W);
        assert(cat >= workArea.x - 0.5 && cat + CAT <= waRight + 0.5,
          `${where}：开弹窗第 ${beat + 1} 拍猫（${cat}）跑出了工作区`);
      }

      // ── 多屏选屏的一般条件 ──
      // 窗口悬出屏幕靠 screen.getDisplayMatching 按重叠面积挑屏来兜。只有单侧悬出
      // 超过帧宽一半时才可能选错屏，而悬出量恒 = inset = (帧宽-猫宽)/2 < 帧宽/2。
      // 这里把这个不变量钉死，而不是只在注释里论证。
      for (const [frame, win] of [[restingW, r.restingWin], [POPUP_W, r.popupWin]]) {
        const overLeft = Math.max(0, workArea.x - win);
        const overRight = Math.max(0, (win + frame) - waRight);
        assert(overLeft <= catInset(frame) && overRight <= catInset(frame),
          `${where}：帧宽 ${frame} 单侧悬出（左 ${overLeft} / 右 ${overRight}）`
          + `超过了 inset ${catInset(frame)}`);
        assert(Math.max(overLeft, overRight) < frame / 2,
          `${where}：帧宽 ${frame} 悬出超过半个帧宽，getDisplayMatching 可能选错屏`);
      }
    }
  }
}
assert(checked > 10000, `全扫覆盖太少（只有 ${checked} 个位置），屏幕/帧宽清单是不是被删空了`);

// ── 回归四：弹窗内容必须完整留在屏幕内 ────────────────────────────────────────
// 这是上一版「弹窗帧必须在工作区内」那条断言真正想守的东西，也是钳猫方案**差点漏掉**
// 的一个后果：弹窗由 #stage 的 align-items:center 居中在 520 宽的窗口里，而窗口原点
// 悬出屏幕，于是 .peek（320 宽）会落在 wa.x-100、.ask（340 宽）落在 wa.x-110 ——
// 探出屏幕外被裁。旧代码里 #stage.edge-left 把整列拉到窗口左缘（那个缘被钳在 wa.x）
// 顺手保护了弹窗，横向贴边删掉时这层保护一起没了。
// 补偿走 --pop-shift + catShift（renderer/pet.js popupShiftPlan，复用 capsuleShift 的
// 「按需最小位移」口径）。这里逐 1px 全扫，确认补偿之后没有任何位置会裁到内容。
//
// 2026-09-18（H3）：这一段整体重写过。H2 的模型是「一个位移，按 frameWidth 压一层」，
// 剩下的亏空（.ask 出屏 20px、阴影被帧墙吃掉）当时判为「属于预期」。**两条都被用户的
// 眼睛推翻了**：「喵靠在右边，左边缘的阴影也没了」「贴边那一侧的圆弧都没了」。
// 现在的模型是**两个位移**，复刻 popupShiftPlan：
//   ideal    = capsuleShift(不传 frameWidth)                 总需求量
//   tight    = max(0, (520 - 弹窗宽)/2 - SHADOW)             帧内安全余量（含阴影）
//   popShift = clamp(ideal, ±tight)                          帧内这一半
//   catShift = popShift - ideal                              溢出这一半，帧去动
// 帧原点因此是 catX - catInset(520) - catShift（主进程按锚点反向挪帧，
// main.js:333 的 inset = anchor.screenX - anchored.x 把偏移读回去），而猫的屏幕
// 位置**不变** —— 这是这套修法的全部要点，下面 catScreen 那条断言就是钉它。
const POPUP_SHADOW_SPREAD = 26;
const POPUPS = [['peek', 320], ['ask', 340], ['bubble', 340]];
let popupChecked = 0;
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const [name, popW] of POPUPS) {
    for (let catX = workArea.x; catX <= waRight - CAT; catX += 1) {
      const ideal = geometry.capsuleShift({
        petCenterX: catX + CAT / 2,
        capsuleWidth: popW,
        workArea,
      });
      const tight = Math.max(0, (POPUP_W - popW) / 2 - POPUP_SHADOW_SPREAD);
      const shift = Math.max(-tight, Math.min(tight, ideal));
      const catShift = Math.round(shift - ideal);
      // 猫在帧内往中心挪 catShift → 帧原点反向挪同样多，猫的屏幕 x 恒等于 catX。
      const winX = catX - catInset(POPUP_W) - catShift;
      // align-items: center → 弹窗在帧内居中；再加 relative left 的位移。
      const inFrame = (POPUP_W - popW) / 2 + shift;
      const left = winX + inFrame;
      popupChecked++;
      // ── 不变式 1：总位移一分不少 ──────────────────────────────────────────
      // 拆分只是换承担者。注意是**减**：弹窗相对猫的位移 = 弹窗在帧内右移 popShift
      // 加上猫在帧内左移 catShift（catShift 为负就是左移），所以 popShift - catShift。
      // 这条一破，弹窗的屏幕落点就不再是 capsuleShift 保证的那个。
      assert(Math.abs((shift - catShift) - ideal) <= 0.5,
        `${label} ${name} 猫x=${catX}：popShift(${shift}) - catShift(${catShift}) ≠ ideal(${ideal})`);
      // ── 不变式 2：猫一动不动 ──────────────────────────────────────────────
      // catShift 是**给猫加的**帧内偏移，帧反向挪同样多才能抵掉。这条是整套修法的
      // 命门：实测（probeRealPath2.py）开窗 200 帧 + 关窗 278 帧零跳变，模型这边
      // 也必须恒等。
      const catScreen = winX + catInset(POPUP_W) + catShift;
      assert(catScreen === catX,
        `${label} ${name} 猫x=${catX}：帧移没抵掉 catShift，猫跑到 ${catScreen}`);
      // ── 断言 A：弹窗不出屏 ────────────────────────────────────────────────
      // H3 之后**零容差**。H2 这里还留着一个 offScreenBudget：
      //   offScreenBudget = max(0, (popW-CAT)/2 - (POPUP_W-popW)/2)
      //   peek 320 → 0；ask/bubble 340 → 20
      // 那 20px 当时判为「数学上关不掉，得把 POPUP_W 抬到 568」。**错了** ——
      // 关不掉的前提是「帧原点只能是 catX-200」，而帧原点可以动。实测
      // probeRealPath2.py：.ask 贴右缘盒子屏幕 [1360,1700]→[1336,1676]，出屏 20→0，
      // POPUP_W 一个字节没动。所以这里改成不给容差。
      assert(left >= workArea.x - 0.5 && left + popW <= waRight + 0.5,
        `${label} ${name}(${popW}宽) 猫x=${catX}：弹窗落在 ${left}..${left + popW}，`
        + `探出工作区 ${workArea.x}..${waRight}（H3 之后这里零容差：帧会跟着挪）`);
      // ── 断言 B：弹窗留在自己那个 520 宽的窗口帧里 ──────────────────────────
      // 上面那条只管屏幕，而真正在裁内容的是 renderer/pet.css:3-7 的
      // html,body{overflow:hidden} —— 它裁的是帧，不是屏幕。修前两个封顶互不知情：
      // capsuleShift 的上限是 (弹窗宽-猫宽)/2+margin，帧内每侧余量是 (520-弹窗宽)/2，
      //   peek 320：余量 100 < 上限 104 → 最多裁 4px
      //   ask/bubble 340：余量 90 < 上限 114 → 最多裁 24px
      // 裁掉的恰好是位移**去向**的那一侧，也就是**远离屏幕边缘**那一侧 —— 精确对上
      // 用户的「不是靠近屏幕边缘不完整，而是另一边」。两个数都真机实测过：
      //   probeEdge 靶 A（peek 320）修前 catX=0    → popShift=104px  L=204 R=524 clipRight=4
      //   probeAsk  A/B（ask  340）修前 catX=0    → popShift=114px  L=204 R=544 clipRight=24
      //   probeAsk  A/B（ask  340）修前 catX=1560 → popShift=-114px L=-24 R=316 clipLeft=24
      // ⚠️ 这一条是 H2 的判定性回归。断言 A 逐 1px 扫了 20000+ 个位置却抓不到 H2，
      // 就是因为它只看 left 的屏幕坐标、从不看帧内坐标。
      assert(inFrame >= -0.5 && inFrame + popW <= POPUP_W + 0.5,
        `${label} ${name}(${popW}宽) 猫x=${catX}：弹窗在帧内落在 ${inFrame}..${inFrame + popW}，`
        + `探出 0..${POPUP_W} 的窗口帧 → 被 html,body{overflow:hidden} 裁掉`
        + `（--pop-shift=${shift} 超过了帧内余量 ${(POPUP_W - popW) / 2}）`);
      // ── 断言 C：H3 的判定性回归 —— 阴影也得在帧里 ──────────────────────────
      // 断言 B 只钳**盒子**，而 box-shadow 画在盒子外面（实测 .peek 21.5px、
      // .ask 21px，getBoundingClientRect 量不到，只能 capturePage 扫 alpha）。
      // H2 钳对了盒子、漏了阴影，盒子贴死帧墙 → 近侧阴影被 overflow:hidden 整块吃掉，
      // 这就是用户报的「喵靠在右边，左边缘的阴影也没了」。
      assert(inFrame - POPUP_SHADOW_SPREAD >= -0.5
             && inFrame + popW + POPUP_SHADOW_SPREAD <= POPUP_W + 0.5,
        `${label} ${name}(${popW}宽) 猫x=${catX}：盒子+阴影在帧内落在 `
        + `${inFrame - POPUP_SHADOW_SPREAD}..${inFrame + popW + POPUP_SHADOW_SPREAD}，`
        + `阴影被帧裁 → 近侧阴影消失（H3 的原始症状）`);
    }
  }
}
assert(popupChecked > 20000, `弹窗溢出扫描覆盖太少（只有 ${popupChecked} 个位置）`);

// 比工作区还宽的弹窗只能对称溢出（中间那段还能读），不许往单侧甩。
for (const [workArea, label] of SCREENS) {
  assert.strictEqual(
    geometry.capsuleShift({ petCenterX: workArea.x + 60, capsuleWidth: workArea.width + 200, workArea }),
    0,
    `${label}：宽过工作区的弹窗必须对称溢出，不许往单侧甩`,
  );
}

// ── 回归五：存盘 / 恢复也得钳猫 ───────────────────────────────────────────────
// 窗口原点现在合法地可以是负数，存盘存的是原点 + 当时的帧宽。换过分辨率、拔过外接屏
// 之后，旧位置可能整块在屏幕外 —— 恢复时必须把猫拉回可见区（main.js restoreWindowOrigin）。
// 这里照抄那个函数的算术验证它。
function restoreCatX(saved, savedW, frameWidth, workArea) {
  const catX = saved.x + (savedW - CAT) / 2;
  const inset = (frameWidth - CAT) / 2;
  const maxCatX = Math.max(workArea.x, workArea.x + workArea.width - CAT);
  const clamped = Math.min(Math.max(catX, workArea.x), maxCatX);
  const originX = Math.round(clamped - inset);
  return originX + inset;
}
{
  const small = { x: 0, y: 24, width: 1440, height: 876 };
  // 上次在 3440 带鱼屏的最右侧（猫 x=3320，帧宽 520 → 原点 3060），现在只剩 1440 宽。
  assert.strictEqual(restoreCatX({ x: 3060, y: 400 }, 520, 520, small), 1440 - CAT,
    '换到窄屏后，屏幕外的存盘位置必须把猫拉回右缘');
  // 上次在 x=-1920 的外接屏（猫 x=-1900，原点 -2100），现在外接屏拔了。
  assert.strictEqual(restoreCatX({ x: -2100, y: 400 }, 520, 520, small), 0,
    '拔掉外接屏后，负坐标的存盘位置必须把猫拉回左缘');
  // 老配置没有 w：按 BASE_W(320) 兜底，等于保持升级前的行为。
  assert.strictEqual(restoreCatX({ x: 700, y: 400 }, 320, 520, small), 700 + (320 - CAT) / 2,
    '老配置（无 w）按 BASE_W 兜底，猫的屏幕位置不变');
  // 帧宽变了但猫在屏幕内 → 猫一格不动（这是 petPosition 带上 w 的全部意义）。
  for (const savedW of [320, 438, 504, 520, 688, 900]) {
    for (const frameW of [320, 520, 900]) {
      const catBefore = 700 + (savedW - CAT) / 2;
      if (catBefore > small.width - CAT) continue;
      assert.strictEqual(restoreCatX({ x: 700, y: 400 }, savedW, frameW, small), catBefore,
        `存盘帧宽 ${savedW} → 新帧宽 ${frameW}：猫的屏幕位置必须不变`);
    }
  }
}

// ── 竖直向：可达性全扫 ───────────────────────────────────────────────────────
// 2026-09-18（E2）。横向那套全扫（钳猫之后工作区内每个 x 都可达）现在竖直也要成立：
// 帧高恒 744 而猫只有 120 高，猫上方约 596px、下方约 20px 都是透明留白，钳窗口会让
// 屏幕上下各出现一条几百像素的死区。这一组按**猫本体**铺点，每个 y 都必须落位不动。
//
// LAYOUTS 覆盖两种竖直布局的真实形状：
//   above（yAlign 'bottom'）—— 整列贴帧底，猫下方是胶囊 / 会话点那一截；
//   edge-below（yAlign 'top'）—— 整列贴帧顶，猫是 order:0 排第一。
const LAYOUTS = [
  { yAlign: 'bottom', belowContent: 23, aboveContent: 0, label: 'above/胶囊 23' },
  { yAlign: 'bottom', belowContent: 28, aboveContent: 0, label: 'above/胶囊+会话点 28' },
  { yAlign: 'bottom', belowContent: 60, aboveContent: 0, label: 'above/胶囊换行 60' },
  { yAlign: 'bottom', belowContent: 200, aboveContent: 0, label: 'above/POPUP_BOTTOM 200' },
  { yAlign: 'top', belowContent: 0, aboveContent: 0, label: 'edge-below/猫贴帧顶' },
  { yAlign: 'top', belowContent: 0, aboveContent: 6, label: 'edge-below/帧顶留 6px' },
];

let vertReach = 0;
for (const [workArea, label] of SCREENS) {
  const frameH = effFrameH(workArea);
  const waBottom = workArea.y + workArea.height;
  for (const layout of LAYOUTS) {
    const reserve = layout.yAlign === 'bottom' ? layout.belowContent : BELOW_RESERVE;
    const maxCatY = Math.max(workArea.y, waBottom - CAT_H - reserve);
    for (let catY = workArea.y; catY <= maxCatY; catY += 1) {
      const winY = Math.round(catY - catLocalY(frameH, layout));
      const r = stepY(workArea, winY, frameH, frameH, layout);
      assert.strictEqual(r.catY, catY,
        `${label} / ${layout.label}：猫在屏幕 y=${catY} 必须落位不动，实际停在 ${r.catY}`);
      // 幂等：再走一拍不许再动（会动就说明有摆动，屏幕上就是抽搐）。
      const again = stepY(workArea, r.winY, frameH, frameH, layout);
      assert.strictEqual(again.catY, catY, `${label} / ${layout.label}：y=${catY} 第二拍又动了`);
      vertReach += 1;
    }
  }
}
assert(vertReach > 30000, `竖直可达性覆盖太少（${vertReach}），别把这组削瘦了`);

// ── 竖直向：帧允许探出，猫和猫下方的内容不许 ─────────────────────────────────
// 这是恒高方案的地基。帧高 744、猫 120，猫贴屏幕顶时帧顶必须能落在 wa.y 上方约
// 596px（靠 makePetWindow 的 enableLargerThanScreen 撑着）；猫贴屏幕底时 edge-below
// 那条帧尾同样合法地探出下沿。反过来，猫本体和猫下方那一截内容一个像素都不许出界。
let vertOverhang = 0;
for (const [workArea, label] of SCREENS) {
  const frameH = effFrameH(workArea);
  const waBottom = workArea.y + workArea.height;
  for (const layout of LAYOUTS) {
    const reserve = layout.yAlign === 'bottom' ? layout.belowContent : BELOW_RESERVE;
    const maxCatY = Math.max(workArea.y, waBottom - CAT_H - reserve);
    for (const catY of [workArea.y, workArea.y + 1, Math.round((workArea.y + maxCatY) / 2), maxCatY]) {
      // 故意从一个**出界**的输入出发（拖动途中猫真的会被拖出屏幕），断言钳制把猫拉回来。
      for (const nudge of [-800, -120, 0, 120, 800]) {
        const winY = Math.round(catY + nudge - catLocalY(frameH, layout));
        const r = stepY(workArea, winY, frameH, frameH, layout);
        assert(r.catY >= workArea.y && r.catY + CAT_H <= waBottom,
          `${label} / ${layout.label}：猫本体必须留在工作区内（catY=${r.catY}）`);
        assert(r.catY + CAT_H + reserve <= waBottom,
          `${label} / ${layout.label}：猫下方那 ${reserve}px 内容必须完整可见（catY=${r.catY}）`);
        vertOverhang += 1;
      }
    }
    // 猫顶贴死工作区上缘时，帧顶必须允许探出上方（否则就是钳窗口，屏幕顶部会出现死区）。
    if (layout.yAlign === 'bottom' && frameH > CAT_H + layout.belowContent) {
      const winY = Math.round(workArea.y - catLocalY(frameH, layout));
      const r = stepY(workArea, winY, frameH, frameH, layout);
      assert.strictEqual(r.catY, workArea.y, `${label} / ${layout.label}：猫必须能贴死工作区上缘`);
      assert(r.winY < workArea.y,
        `${label} / ${layout.label}：猫贴顶时帧原点必须探出工作区上方（实际 ${r.winY} vs wa.y=${workArea.y}）`);
    }
    // edge-below：猫贴死下界时帧尾探出下沿同样合法（那是空的透明留白，不是内容）。
    if (layout.yAlign === 'top') {
      const catY = Math.max(workArea.y, waBottom - CAT_H - BELOW_RESERVE);
      const r = stepY(workArea, Math.round(catY - layout.aboveContent), frameH, frameH, layout);
      assert.strictEqual(r.catY, catY, `${label} / ${layout.label}：猫必须能贴到下界`);
      if (frameH > CAT_H + BELOW_RESERVE + layout.aboveContent) {
        assert(r.winY + frameH > waBottom,
          `${label} / ${layout.label}：edge-below 的帧尾必须允许探出工作区下沿`);
      }
    }
  }
}
assert(vertOverhang > 500, `悬出不变量覆盖太少（${vertOverhang}）`);

// ── 竖直向：开关气泡帧高 delta 必须为 0 ──────────────────────────────────────
// E2 的直接回归防线。实测（probeF/probeI）：屏幕上那次「往上消失再出现」的幅度
// **恰好等于开关气泡的帧高差**，把差压到 0 → 16/16 例零闪现。所以只要帧高在
// 静息 / 弹窗两态相等，缺陷就没有立足之地。
// 这里同时验一遍完整的开→关一轮：猫的屏幕 y 逐拍不动。
let vertCycles = 0;
for (const [workArea, label] of SCREENS) {
  const restingH = effFrameH(workArea);
  for (const popupContentH of [80, 120, 240, 340, 520, 900]) {
    // 弹窗内容高度**不**参与帧高 —— 这正是恒高：popupHeight 只喂 popupEdgeLayout 判上下让位。
    const popupH = effFrameH(workArea);
    assert.strictEqual(popupH, restingH,
      `${label}：弹窗内容高 ${popupContentH} 不许改变帧高（静息 ${restingH} vs 弹窗 ${popupH}）`);
  }
  const waBottom = workArea.y + workArea.height;
  for (const layout of LAYOUTS) {
    const reserve = layout.yAlign === 'bottom' ? layout.belowContent : BELOW_RESERVE;
    const maxCatY = Math.max(workArea.y, waBottom - CAT_H - reserve);
    for (let catY = workArea.y; catY <= maxCatY; catY += 7) {
      let cur = Math.round(catY - catLocalY(restingH, layout));
      // fitPopup 连下发两拍，第三拍验幂等；随后 closePeek → resetPetSize → fitRestingFrame。
      for (const beat of [0, 1, 2, 3, 4]) {
        const r = stepY(workArea, cur, restingH, restingH, layout);
        assert.strictEqual(r.catY, catY,
          `${label} / ${layout.label}：开关气泡第 ${beat} 拍猫从 y=${catY} 漂到了 ${r.catY}`);
        cur = r.winY;
      }
      vertCycles += 1;
    }
  }
}
assert(vertCycles > 4000, `开关气泡竖直覆盖太少（${vertCycles}）`);

// ── 竖直向：跨版本恢复不许跳位 ───────────────────────────────────────────────
// persistPos 存的 y 是**帧原点**，而帧高从 340 变成了 744。旧配置里没有 h，若按 744
// 解读会算成猫下移 404px 再被钳回屏幕底 —— 升级后第一次启动喵就跳位。
// main.js restoreWindowOrigin 的口径是**帧底**：originY = saved.y + savedH - frameHeight，
// 再按新帧高的 insetY 反推猫。照抄它验证。
function restoreCatY(saved, savedH, frameHeight, workArea) {
  const h = Number.isFinite(savedH) && savedH > 0 ? savedH : BASE_FRAME_H;
  const originY = saved.y + h - frameHeight;
  const insetY = frameHeight - CAT_H - BELOW_RESERVE;
  const catY = originY + insetY;
  const maxCatY = Math.max(workArea.y, workArea.y + workArea.height - CAT_H - BELOW_RESERVE);
  const clamped = Math.min(Math.max(catY, workArea.y), maxCatY);
  const originOut = Math.round(clamped - insetY);
  return originOut + insetY;
}
{
  const small = { x: 0, y: 24, width: 1440, height: 876 };
  // 老配置（无 h）必须按 340 解读：猫落在 saved.y + 340 - 120 - 28 = saved.y + 192。
  assert.strictEqual(restoreCatY({ y: 400 }, undefined, FRAME_H_CONST, small), 400 + 192,
    '老配置（无 h）必须按 BASE_H(340) 的帧底解读，猫不许因为帧高涨到 744 就下移 404px');
  // 有 h 时按存的值解读，同样落在「帧底 - 148」。
  assert.strictEqual(restoreCatY({ y: 100 }, FRAME_H_CONST, FRAME_H_CONST, small), 100 + 744 - 148,
    '新配置按存的帧高解读');
  // 核心不变量：帧高怎么变，猫的屏幕 y 都由**帧底**决定 → 同一份存盘、不同新帧高，猫不动。
  for (const savedH of [340, 520, 624, 744, 900]) {
    for (const frameH of [340, 520, 744, 876]) {
      const want = 300 + savedH - 148;   // 帧底 300+savedH，猫顶 = 帧底 - 120 - 28
      if (want < small.y || want > small.y + small.height - CAT_H - BELOW_RESERVE) continue;
      assert.strictEqual(restoreCatY({ y: 300 }, savedH, frameH, small), want,
        `存盘帧高 ${savedH} → 新帧高 ${frameH}：猫的屏幕 y 必须不变（帧底才是不变量）`);
    }
  }
  // 换过分辨率 / 拔过外接屏：整块在屏幕外的存盘位置必须把猫拉回可见区，且猫下方留量完整。
  assert.strictEqual(restoreCatY({ y: 2000 }, 744, 744, small), small.y + small.height - CAT_H - BELOW_RESERVE,
    '存盘位置在屏幕下方之外时，猫必须被拉回到「胶囊仍完整可见」的下界');
  assert.strictEqual(restoreCatY({ y: -1500 }, 744, 744, small), small.y,
    '存盘位置在屏幕上方之外时，猫必须被拉回工作区上缘');
  // 真机两块屏都走一遍（含负原点副屏）。
  for (const [workArea, label] of SCREENS.slice(0, 2)) {
    const lo = workArea.y;
    const hi = workArea.y + workArea.height - CAT_H - BELOW_RESERVE;
    for (const savedY of [-9999, workArea.y - 200, workArea.y + 300, 99999]) {
      const got = restoreCatY({ y: savedY }, 744, effFrameH(workArea), workArea);
      assert(got >= lo && got <= hi, `${label}：恢复后的猫 y=${got} 必须落在 [${lo}, ${hi}]`);
    }
  }
}

// ── 竖直向：小屏削高 ─────────────────────────────────────────────────────────
// applyPetSize 有 `h = Math.min(h, wa.height)`。wa.height < 744 的屏（清单里的
// 1024×744 那块 → 744 恰好等号；更矮的屏会真被削）上帧高变小，但**该屏之内仍恒定**，
// 所以 E2 在那块屏上也不复现。跨屏拖动那一刻帧高会变一次 —— 已知残留，如实钉住它的
// 边界：允许帧高变，但猫的屏幕位置不许因此漂移（帧底口径保证了这一点）。
{
  const tiny = { x: 0, y: 24, width: 1280, height: 600 };   // 比 744 矮，帧高被削到 600
  assert.strictEqual(effFrameH(tiny), 600, '矮屏上帧高必须被 Math.min 削到工作区高度');
  assert.strictEqual(effFrameH({ x: 0, y: 24, width: 1024, height: 744 }), 744,
    'wa.height 恰为 744 时不许被削');
  // 该屏之内恒定：任何弹窗内容高度都算出同一个帧高。
  for (const contentH of [80, 200, 340, 520, 900]) {
    assert.strictEqual(effFrameH(tiny), 600, `矮屏 / 弹窗内容 ${contentH}：帧高在该屏内必须恒定`);
  }
  // 矮屏上可达性同样成立（猫仍能贴上缘与下界）。
  for (const layout of LAYOUTS) {
    const reserve = layout.yAlign === 'bottom' ? layout.belowContent : BELOW_RESERVE;
    if (CAT_H + reserve > tiny.height) continue;
    for (const catY of [tiny.y, tiny.y + tiny.height - CAT_H - reserve]) {
      const r = stepY(tiny, Math.round(catY - catLocalY(effFrameH(tiny), layout)), effFrameH(tiny), effFrameH(tiny), layout);
      assert.strictEqual(r.catY, catY, `矮屏 / ${layout.label}：猫在 y=${catY} 必须落位不动`);
    }
  }
  // 跨屏：从 744 帧的大屏拖到 600 帧的矮屏，猫留在两块屏都可见的位置时不许漂。
  const big = SCREENS[0][0];
  const catY = Math.max(big.y, tiny.y) + 200;
  const savedFrameBottom = catY + CAT_H + BELOW_RESERVE;   // 帧底 == 内容底
  const restored = restoreCatY({ y: savedFrameBottom - 744 }, 744, effFrameH(tiny), tiny);
  assert.strictEqual(restored, catY,
    '跨屏那次帧高变化允许存在，但猫的屏幕位置不许跟着漂（帧底口径）');
}

// ── 模型忠实度 ───────────────────────────────────────────────────────────────
// 上面每个公式都是从下面这些行抄来的。它们一旦改写，这个 suite 的结论就不再代表
// 真实链条 —— 那时应该同步改模型，而不是让一个已经失真的模型继续绿着。
assert(/localX = anchor\.xOffset;/.test(mainJs)
  && /localX = width - anchor\.xOffset - anchor\.width;/.test(mainJs)
  && /localX = width \/ 2 \+ anchor\.xOffset - anchor\.width \/ 2;/.test(mainJs),
  'anchoredPetOrigin 的三条 localX 分支变了，本 suite 的反解模型需要同步');
// 横向钳制：钳猫，不钳窗口。旧的钳窗口那一行必须不在（它是环带的唯一成因）。
assert(/function clampCatOrigin\(/.test(mainJs)
  && /const catX = Math\.min\(Math\.max\(catScreenX, wa\.x\), maxCatX\);/.test(mainJs)
  && /return Math\.round\(catX - inset\);/.test(mainJs),
  'clampCatOrigin 的钳猫算术变了，本 suite 的 step() 需要同步');
assert(/const x = clampCatOrigin\(wa, catScreenX, catW, inset\);/.test(mainJs),
  'applyPetSize 必须走 clampCatOrigin，本 suite 的钳制模型需要同步');
assert(!/x = Math\.min\(Math\.max\(x, wa\.x\), wa\.x \+ wa\.width - width\);/.test(mainJs),
  '钳窗口那一行不能回来：它是屏幕左右各 200px 环带（E3/E4）的唯一成因');
// 竖直钳制：2026-09-18（E2）也改成钳猫了。帧高恒 744 而猫 120，钳窗口会让屏幕上下
// 各出现几百像素的死区（和横向那条 200px 环带同构）。但下界必须连**猫下方的内容**
// 一起保护 —— 那是胶囊 / 会话点，被顶出屏幕就读不到了。
assert(/function clampCatOriginY\(/.test(mainJsCode)
  && /const maxCatY = Math\.max\(wa\.y, wa\.y \+ wa\.height - catH - reserve\);/.test(mainJsCode)
  && /const catY = Math\.min\(Math\.max\(catScreenY, wa\.y\), maxCatY\);/.test(mainJsCode)
  && /return Math\.round\(catY - insetY\);/.test(mainJsCode),
  'clampCatOriginY 的钳猫算术变了，本 suite 的 stepY() 需要同步');
assert(/const y = clampCatOriginY\(wa, catScreenY, catH, belowReserve, insetY\);/.test(mainJsCode),
  'applyPetSize 必须走 clampCatOriginY，本 suite 的竖直钳制模型需要同步');
// belowReserve 分两种布局：yAlign 'bottom' 按帧尾算（帧底 == 内容底），'top'
// （#stage.edge-below）时帧尾是空的透明留白、不是内容，只能保护 RESTING_BELOW_RESERVE。
// 拿同一个式子算 'top' 会把 744 全当成「必须可见」，maxCatY 退化成 wa.y，猫一进
// edge-below 就被甩到工作区上缘（1024×744 那块屏上实测跳 126px）。
assert(/anchor\.yAlign === 'bottom' \? Math\.max\(0, h - insetY - catH\) : RESTING_BELOW_RESERVE/.test(mainJsCode),
  'belowReserve 必须按 yAlign 分流：edge-below 的帧尾是透明留白，不是要保护的内容');
assert(!/y = Math\.min\(Math\.max\(y, wa\.y\), wa\.y \+ wa\.height - h\);/.test(mainJsCode),
  '竖直钳窗口那一行不能回来：帧高恒 744、猫 120，它会让屏幕上下各出现几百像素死区');
// keepCatOnScreen（换分辨率 / 插拔外接屏 / 动 Dock 时的兜底）必须与 applyPetSize
// **同一套口径**。它横向早就钳猫了，竖直却漏了一条钳窗口的 `min(max(b.y, wa.y),
// wa.bottom - b.height)`：猫贴屏幕顶时帧原点合法地在 -569（探针实测），那一行会把窗口
// 硬拉回 242、猫从 30 跳到 841。也就是贴顶的猫只要碰上任一次屏幕拓扑变化就被甩走。
// 找屏幕同样必须用**猫**的坐标：帧原点 -569 落在所有屏幕之外，
// getDisplayNearestPoint 会挑错那块屏，然后按它的工作区钳。
assert(/const y = clampCatOriginY\(wa, catY, PET_BODY_H, RESTING_BELOW_RESERVE, insetY\);/.test(mainJsCode),
  'keepCatOnScreen 的竖直兜底必须走 clampCatOriginY，不能钳窗口');
assert(/getDisplayNearestPoint\(\{ x: Math\.round\(catX\), y: Math\.round\(catY\) \}\)/.test(mainJsCode),
  'keepCatOnScreen 必须按猫的坐标找屏幕：帧原点可能在所有屏幕之外');
assert(!/y = Math\.min\(Math\.max\(b\.y, wa\.y\), wa\.y \+ wa\.height - b\.height\);/.test(mainJsCode),
  'keepCatOnScreen 里竖直钳窗口那一行不能回来：它会把贴屏幕顶的猫甩到中下部');
// 帧高恒定：E2 的成因是开关气泡改帧高，幅度恰等于帧高差。两端必须同源。
assert(/const PET_FRAME_H = 744;/.test(mainJsCode),
  '主进程的 PET_FRAME_H 必须是常量 744');
assert(/const PET_FRAME_H = POPUP_BOTTOM \+ ASK_VIEWPORT_MAX_H \+ 24;/.test(petJsCode),
  '渲染端的 PET_FRAME_H 必须由 POPUP_BOTTOM + ASK_VIEWPORT_MAX_H + 24 推出，与主进程同源');
assert(/return \{ w, h: PET_FRAME_H \};/.test(mainJsCode) && !/customSize\.h/.test(mainJsCode),
  'targetSize 的高度必须恒为 PET_FRAME_H，不许再跟 customSize.h 走（那就是 E2 的成因）');
// xAlign 恒 center：横向对齐维度已退役，本 suite 的 catInset 才能是纯常量。
assert(/const xAlign = 'center';/.test(petJs),
  'anchoredLayoutPayload 的 xAlign 必须恒为 center，本 suite 的 catInset 才成立');
assert(/const xOffset = rect\.left \+ rect\.width \/ 2 - viewportW \/ 2;/.test(petJs)
  && /yOffset = yAlign === 'top' \? rect\.top : viewportH - rect\.bottom/.test(petJs),
  'anchoredLayoutPayload 的 xOffset/yOffset 变了，本 suite 的锚点模型需要同步');
// 竖直的两条 infer 吸附分支已**整体退役**（连带 allowSnap 参数和 RESTING_FRAME_MAX_H）。
// 它们的前提是「主进程钳的是窗口」——「窗口被钳在屏幕顶而猫还困在窗口里」这个状态在
// 竖直钳猫之后不存在了。而且恒高先一步废掉了它们的门（wr.height <= 360 恒 false）。
// 留着就是死门，上一次留下的死门（永真的 inferHorizontalFrameClamp）正是 E3/E4 那条
// 环带没被拦住的直接原因 —— 所以这里钉的是「不许回来」。
assert(!/allowSnap/.test(petJsCode),
  '竖直 infer 吸附的 allowSnap 门必须保持退役：钳猫之后「窗口被钳住而猫还没到边」不存在了');
assert(!/RESTING_FRAME_MAX_H/.test(petJsCode),
  'RESTING_FRAME_MAX_H 必须保持退役：帧高恒 744 之后任何 `wr.height <= 360` 的门都恒 false');
assert(/const anchor = anchoredLayoutPayload\(nextLayout\);/.test(petJsCode)
  && /function anchoredLayoutPayload\(next\) \{/.test(petJsCode),
  'anchoredLayoutPayload 必须保持单参数签名（第二个 allowSnap 参数已随吸附分支一起退役）');
assert(!/inferHorizontalFrameClamp/.test(petJsCode),
  '横向 infer 门必须保持退役：钳猫之后「窗口被钳住而猫还没到边」这个状态不存在了');
assert(!/inferVerticalFrameClamp/.test(petJsCode),
  '竖直 infer 门必须保持退役：与横向同一个论证（竖直钳猫后猫到边就是窗口到边）');
assert(/const POPUP_W = 520;/.test(petJs), '本 suite 的 POPUP_W 必须跟渲染端一致');

// ── 失焦必须放开鼠标穿透（G1）────────────────────────────────────────────────
// 用户实测：「多次切换气泡开关以后，这个喵可能会卡住，点击喵没任何反应。点了其他应用，
// 再点回来，才重新弹出气泡」，且「卡住的那一刻，胶囊还在，喵的动画也正常播放」——
// 渲染进程活着，是鼠标事件在到达它之前就被吞了。
//
// 成因（2026-09-18 独立最小实验实测，不是推理）：透明窗 + setIgnoreMouseEvents(true,
// {forward:true})，光标在窗口内真实抖动 6 次 ——
//   聚焦时 renderer 收到 12 个 mousemove；**失焦时收到 0 个**；复位成 ignore(false) 后
//   失焦也能收到 6 个。
// 而渲染端唯一的解穿透通道就是 window 上的 mousemove 命中测试（HIT_SEL 那段，全仓库
// 只有 3 个 setMouseIgnore 调用点，其中两个都在那个 mousemove 监听里，第三个是模块顶层
// 一次性且方向是**进入**穿透）。所以窗口一失焦，穿透态就永久锁死。
// 关气泡走 closePeek() → blurPet() → 主进程 w.blur() 正是制造这一刻的元凶。
//
// 三道防线缺一条都会让这个坑重新露出来，所以逐条钉住。
assert(/function releaseClickThrough\(/.test(mainJsCode),
  '必须有失焦复位穿透的共用入口：forward:true 只转发 mousemove，而失焦窗口收不到 mousemove');
assert(/releaseClickThrough[\s\S]{0,200}setIgnoreMouseEvents\(false\)/.test(mainJsCode),
  'releaseClickThrough 必须真的把穿透关掉（setIgnoreMouseEvents(false)）');
// (a) 我们自己发起的失焦（blurPet → PET_BLUR）
assert(/IPC\.PET_BLUR[\s\S]{0,400}?w\.blur\(\)[\s\S]{0,200}?releaseClickThrough/.test(mainJsCode),
  'PET_BLUR handler 里 w.blur() 之后必须复位穿透：删掉它就是直接复现 G1'
  + '（w.blur() 同时是 macOS 帧钳制的触发源，不能改成不 blur，只能补复位）');
// (b) 用户点别的应用/切 Space 造成的失焦
assert(/win\.on\('blur',[\s\S]{0,120}?releaseClickThrough/.test(mainJsCode),
  "窗口 'blur' 事件必须复位穿透：失焦来源不止 blurPet()");
// (c) 与来源无关的兜底：心跳对账
assert(/!st\.win\.isFocused\(\)\)\s*releaseClickThrough\(st\)/.test(mainJsCode),
  'emitStats 的心跳里必须有「未聚焦 + 仍在穿透 → 复位」的对账，覆盖任何漏掉的失焦来源'
  + '（锁屏、Mission Control、外接屏热插拔），最长 4s 自愈');
assert(/!st\.win\.isFocused\(\)/.test(mainJsCode),
  '对账守卫必须带 !isFocused()：聚焦时命中测试在跑，那个穿透态是渲染端主动维护的正确值');
// st.mouseIgnoring 长期是**只写**状态位（初始化 + SET_IGNORE_MOUSE 写入，全文件从不读），
// 这正是 G1 潜伏这么久的结构性原因：主进程手里明明有「渲染端想要的穿透态」却不看。
assert(/if \(!st\.mouseIgnoring\) return false;/.test(mainJsCode),
  'st.mouseIgnoring 必须被读：只写状态位是 G1 潜伏至今的结构性原因');
// forward:true 那段注释曾写着「keeps mousemove flowing to the renderer while ignoring,
// so it can re-enable clicks the moment the cursor returns」—— 这句在失焦时不成立，
// 它本身就是 G1 的认知根源。钉住别让它回来。
assert(!/forward:true keeps mousemove flowing/.test(mainJs),
  'SET_IGNORE_MOUSE 上方那句「forward:true 保证 renderer 一直收到 mousemove」是错的：'
  + '失焦窗口收不到 mousemove（实测 0 个），这个错误假设不许回来');

// ── 穿透态去重必须在主进程侧，不许在渲染端（H1 根因 B）────────────────────────
// G1 的修法（releaseClickThrough 单方面复位主进程侧状态位）留下一个独立 bug：渲染端
// 的同名本地变量看不到那三处复位，两侧对不上之后渲染端的早退守卫会把每一次「重新进入
// 穿透」都吞掉。实测（probeSync，真机）：
//   afterRealBlur          渲染 true / 主 false   OS 收到 ignore(false)  ← 主进程单方面复位
//   moveAgainOnTransparent 渲染 true / 主 false   OS **零调用**          ← 渲染端 SKIP 吞掉
//   rlog: [[8032,1,'SKIP'],[8232,1,'SKIP']]
// 窗口于此永久停在「该穿透时不穿透」，4s 心跳每 4 秒重新制造一次。
// （Round 0/2 没复现 —— win.blur() 在窗口已失焦时是空操作。这解释了用户说的「**可能**
// 会卡住」。）
//
// 修法是把去重从渲染端挪到主进程侧。三条不变量互相咬合，缺一条就漏：
assert(!/on === mouseIgnoring/.test(petJsCode),
  '渲染端 setMouseIgnore 不许有早退守卫：它看不到主进程那三处失焦复位，两侧 desync 后会把'
  + '「重新进入穿透」的 IPC 全部吞成 SKIP，窗口永久停在该穿透时不穿透（实测）');
assert(/if \(st\.mouseIgnoring === want\) return;/.test(mainJsCode),
  'SET_IGNORE_MOUSE 必须在主进程侧去重：渲染端守卫拆掉后每个 mousemove 都会来一次，'
  + '这里的 st.mouseIgnoring 才真的等于「最后一次下发给 OS 的值」');
// 这一条最容易在重构里被「顺手改回来」：注释「透明窗启动即穿透」读着很对，但 OS 那侧
// 新窗口本来就不穿透，主进程从不调 setIgnoreMouseEvents(true) —— 启动即穿透是渲染端
// 模块顶层那一次 setMouseIgnore(true) 走 IPC 做的。写成 true 会被上面那条去重吞掉，
// 窗口开局整个 520×744 透明帧都拦住点击。
assert(/mouseIgnoring: false,/.test(mainJsCode),
  'petState 的 mouseIgnoring 初始值必须是 false：它的口径是「最后一次下发给 OS 的值」，'
  + '而新建窗口本来就不穿透；写 true 会让渲染端启动那唯一一次下发被去重吞掉');
assert(!/mouseIgnoring: true/.test(mainJsCode),
  'petState 的 mouseIgnoring 不许初始化成 true（理由同上一条）');

// 渲染端：blur 之后 askHover 卡在 true 会让 isInteracting() 永真（同一条 mousemove 断流链）。
assert(/window\.addEventListener\('blur',[\s\S]{0,600}?askHover = false/.test(petJsCode),
  'blur 监听必须清 askHover：它只靠 mousemove 命中测试和 pointerleave 维护，失焦后两者都停摆');
assert(/window\.addEventListener\('blur',[\s\S]{0,600}?actionPopOpen\) closeActionPop\(\)/.test(petJsCode),
  'blur 监听必须收尾 actionPopOpen：留 true 会让后续 closer 的 resetPetSize 把开着的弹层裁到视口外');
// 两个 closer 的早退守卫：没有它，关着的弹层也会白走一遍 blurPet()，制造多余的失焦。
assert(/function closeActionPop\(\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(!actionPopOpen\) return;/.test(petJs),
  'closeActionPop 必须有早退守卫：maybeCloseEmptyPop / 面板按钮都不检查标志就调过来');
assert(/if \(!quotaPopoverOpen\) return;/.test(petJsCode),
  'closeQuotaPopover 必须有早退守卫（理由同 closeActionPop）');
// resetPetSize 的互斥守卫（仿 closePeek）：别把还开着的另一个弹层缩到视口外。
assert(/if \(!askActive && !peekOpen\) resetPetSize\(\);/.test(petJsCode),
  'closeActionPop 的 resetPetSize 必须让位于还开着的 ask/peek');
assert(/if \(!askActive && !actionPopOpen && !peekOpen\) resetPetSize\(\);/.test(petJsCode),
  'closeQuotaPopover 的 resetPetSize 必须让位于还开着的 ask/actionPop/peek');

// ── closePeek 不许主动失焦（H1）──────────────────────────────────────────────
// blurPet 现在只剩「把焦点还给用户原来在用的编辑器」这一重职责，而 #peek 里没有任何
// 输入框（全仓库只有 #ask 有 textarea），它从来就没有焦点可还。而主动失焦有两个已实测
// 的代价，两条都直接对上用户「只有左键、只有气泡消失后」的线索：
//  1. 透明窗失焦 → visibilityState=hidden → 合成器停止向屏幕提交帧 = 猫消失再出现。
//     实测 A/B 各 4 轮 × 左右键：默认组左键 visChange 2 次/轮 × 3/3 有效轮、右键 0/4。
//     （上游已由 petWin 的 backgroundThrottling:false 堵住 —— 这条是正交的第二道保险。）
//  2. w.blur() → 主进程单方面 releaseClickThrough(st)，渲染端的 mouseIgnoring 不知情 →
//     双向 desync，窗口永久停在「该穿透时不穿透」。
// 曾以为它不能删，因为它是 F4（贴边开关气泡后猫朝屏幕中心漂）的触发源 —— 已被 A/B
// 12 例证伪（两组 frameChanges 全 0），真正修掉 F4 的是 enableLargerThanScreen。
// ⚠️ 这条**只钉 closePeek**。hideAsk() 里的 blurPet() 必须留着：那里有真输入框。
{
  // 用括号计数取函数体，不用正则：函数里现在有一大段解释为什么不调 blurPet 的注释，
  // 而 codeOnly() 按行首判注释、行尾注释仍会被看见 —— 用 [\s\S]*? 去框范围很容易
  // 要么吃到下一个函数、要么被自己的说明文字绊倒。
  const fnBody = (src, name) => {
    const at = src.search(new RegExp('function\\s+' + name + '\\s*\\(\\)\\s*\\{'));
    if (at < 0) return null;
    const open = src.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    return null;
  };
  const closePeekBody = fnBody(petJsCode, 'closePeek');
  assert(closePeekBody, 'closePeek 必须还在');
  assert(!/blurPet/.test(closePeekBody),
    'closePeek 不许调 blurPet：peek 没有输入框（没焦点可还），而主动失焦会让透明窗进 '
    + 'visibilityState=hidden（猫消失再出现，H1）并制造穿透态 desync；F4 早已由 '
    + 'enableLargerThanScreen 承担（A/B 12 例 frameChanges 全 0）');
  // 反向保险：别把这条 pin 读成「blurPet 该整体退役」。
  const hideAskBody = fnBody(petJsCode, 'hideAsk');
  assert(hideAskBody && /blurPet/.test(hideAskBody),
    'hideAsk 必须保留 blurPet：#ask 里有真输入框（#ask-text），不还焦点就会一直霸占它');
}

// 弹窗溢出补偿：--pop-shift 必须是 relative left（不能是 transform —— .peek/.ask/.think
// 的入场动画 keyframes 结尾是 transform:none，会把位移擦掉；也不能是 margin —— 会挤压
// 兄弟节点、把整列布局宽度推出去）。
assert(/function applyPopupShift\(/.test(petJs) && /--pop-shift/.test(petJs),
  '弹窗的按需内缩必须存在：钳猫之后居中的弹窗会探出屏幕 100~110px');
assert(/\.peek, \.ask, \.bubble, \.think \{[^}]*left:\s*var\(--pop-shift/.test(petCss),
  '--pop-shift 必须走 relative left：transform 会被入场动画擦掉，margin 会挤压布局');

console.log(`pet edge cycle checks passed (${checked} cycles, ${reachable} reachability, ${popupChecked} popup`
  + `, ${vertReach} vertical reachability, ${vertCycles} vertical cycles)`);
