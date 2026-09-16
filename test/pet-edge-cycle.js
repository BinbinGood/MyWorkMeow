'use strict';

// 「开弹窗 / 关弹窗不能把猫挪走」的端到端回归。
//
// 为什么单独一个 suite：test/pet-geometry.js 只能验 shared/pet-geometry.js 这一段
// 纯函数，而用户看到的那两个 bug 都不在任何单个函数里 —— 它们出在**链条**上：
//   渲染端 choosePopupLayout / chooseRestingLayout 选方向
//   → anchoredLayoutPayload 反推「猫该落在哪个屏幕像素」
//   → 主进程 anchoredPetOrigin 反解窗口原点
//   → applyPetSize 把窗口钳进工作区
// 每一环单独看都对，合起来猫平移 200px。2026-09-16 我在这条链上连栽三次（详见
// test/popup-style.js 的注释），静态推理两次给出错答案，所以这里改成跑真实序列、
// 断言猫的屏幕像素**逐格不变**。
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

const CAT = 120;        // #cat 是 120×120
const POPUP_W = 520;    // renderer/pet.js 的 POPUP_W
const FRAME_H = 340;    // BASE_H

// 猫在窗口里的横向偏移，完全由 stage 的对齐方式决定（renderer/pet.css 的
// #stage.edge-left/.edge-right → align-items: flex-start/flex-end，默认居中）。
const catInset = (frameW, horizontal) => (
  horizontal === 'left' ? 0
    : horizontal === 'right' ? frameW - CAT
      : (frameW - CAT) / 2
);

// renderer/pet.js anchoredLayoutPayload 的 xOffset 三条分支 —— 注意 viewportW 是
// **当前**帧宽（窗口还没 resize），而 main.js 反解时用的是**目标**帧宽。这个不对称
// 是真实存在的，模型必须照抄，不能图省事两边都用目标帧宽。测量用 measureEdgeRect
// 临时切到目标对齐再恢复，rect.left 就是目标对齐下猫在当前帧宽的窗内偏移（catInset）。
function anchorXOffset(frameNow, horizontal) {
  const left = catInset(frameNow, horizontal);
  if (horizontal === 'left') return left;
  if (horizontal === 'right') return frameNow - (left + CAT);
  return left + CAT / 2 - frameNow / 2;
}

// main.js:189-192 anchoredPetOrigin 的 localX 三条分支
function anchorLocalX(frameTarget, horizontal, xOffset) {
  if (horizontal === 'left') return xOffset;
  if (horizontal === 'right') return frameTarget - xOffset - CAT;
  return frameTarget / 2 + xOffset - CAT / 2;
}

// 一次 setPetSize：从（当前窗口原点、当前帧宽、当前对齐）走到（目标帧宽、目标对齐），
// 返回主进程实际落定的窗口原点与猫的屏幕位置。
function step(workArea, winX, frameNow, from, frameTarget, to) {
  const waRight = workArea.x + workArea.width;
  const oldPetX = catInset(frameNow, from);
  let screenX = winX + oldPetX;

  // renderer/pet.js:581-585 —— 窗口已被钳在工作区缘、而猫还困在窗口的透明留白里，
  // 按「用户其实想把猫贴到那条边」处理，锚点直接落到工作区缘。
  if (to === 'left' && winX <= workArea.x + 3 && oldPetX > 18) screenX = workArea.x;
  if (to === 'right' && winX + frameNow >= waRight - 3
    && frameNow - oldPetX - CAT > 18) screenX = waRight - CAT;

  const xOffset = anchorXOffset(frameNow, to);
  const localX = anchorLocalX(frameTarget, to, xOffset);
  // main.js:198 取整，226 钳进工作区
  const raw = Math.round(screenX - localX);
  const settled = Math.min(Math.max(raw, workArea.x), waRight - frameTarget);
  return { winX: settled, catX: settled + catInset(frameTarget, to) };
}

// 渲染端 restingEdgeLayout()：注意 inferHorizontalFrameClamp 这个门 —— 判据是
// 「当前帧有没有比静息帧宽」。关弹窗时本函数会在窗口**还是 520 宽**的时候先跑一次。
const restingHorizontal = (workArea, winX, frameNow, from, restingW) => geometry.chooseRestingLayout({
  workArea,
  windowRect: { x: winX, y: 400, width: frameNow, height: FRAME_H },
  petRect: { x: catInset(frameNow, from), y: 200, width: CAT, height: CAT },
  threshold: 218,
  inferHorizontalFrameClamp: frameNow <= restingW + 2,
}).horizontal;

// 渲染端 popupEdgeLayout()：传的是**目标**帧宽 POPUP_W，不是 snapshot 里的当前帧宽。
const popupHorizontal = (workArea, winX, frameNow, from) => geometry.choosePopupLayout({
  workArea,
  windowRect: { x: winX, y: 400, width: frameNow, height: FRAME_H },
  petRect: { x: catInset(frameNow, from), y: 200, width: CAT, height: CAT },
  popupHeight: 360,
  popupWidth: POPUP_W,
}).horizontal;

// 反复落位到不动点，返回收敛后的状态与用掉的轮数。
//
// 为什么要迭代、而不是直接断言「落位一次就是不动点」：合成的（窗口原点、对齐）里
// 有一小段确实需要两轮。例：静息帧 320、窗口 x=6、当前左对齐 → 猫在屏幕 x=6，离
// 左缘 6px > edgeGap(3)，所以判 center；居中对齐要求窗口原点 -94，被 applyPetSize
// 钳回 0，猫落在 100；下一轮 infer 分支认出「窗口贴缘而猫困在里面」，把猫吸到 0。
// 这是 chooseRestingLayout 的既有设计（横向只认真贴边，见 test/pet-geometry.js 的
// 注释），**不是**本次改动引入的，而且收敛。这里把「必须收敛且轮数有上界」钉住 ——
// 真正不能接受的是来回摆动，那会让猫抽搐。
function settleToFixpoint(workArea, restingW, winX, align, where) {
  let cur = { winX, align };
  for (let round = 1; round <= 6; round++) {
    const h = restingHorizontal(workArea, cur.winX, restingW, cur.align, restingW);
    const next = step(workArea, cur.winX, restingW, cur.align, restingW, h);
    if (next.winX === cur.winX && h === cur.align) {
      return { winX: cur.winX, align: cur.align, catX: next.catX, rounds: round };
    }
    cur = { winX: next.winX, align: h };
  }
  assert.fail(`${where}：落位 6 轮仍未收敛（在两种对齐之间摆动？最后停在窗口 x=${cur.winX} 对齐 ${cur.align}）`);
}

// 完整一轮：落位到不动点 → 开弹窗（fitPopup 会连下发两拍，第三拍验幂等）→ 关弹窗
// （closePeek → resetPetSize → fitRestingFrame，此时窗口还是 520 宽）→ 再落位。
//
// 入参是**窗口原点**而不是猫的位置。这一点是被一次失败逼出来的：我最初按猫的屏幕
// 像素铺点，结果静息帧 688 时「猫离左缘 199px」这个输入本身就不成立 —— 居中对齐下
// 它意味着窗口原点在 -85，窗口早被 applyPetSize 钳过了。窗口位置才是权威量（用户
// 拖的是窗口，猫的位置是推出来的），按它铺点才不会造出不可达的状态去冤枉代码。
//
// 落位**允许**挪猫（拖到边缘附近松手时把猫吸到边上正是要的功能）。不变量是：从落位
// 收敛后的那个位置起，开关一轮弹窗，猫必须一格不动。
function cycle(workArea, restingW, winX0, align0, where) {
  const rest = settleToFixpoint(workArea, restingW, winX0, align0, where);

  let cur = { winX: rest.winX, frame: restingW, h: rest.align };
  const popupBeats = [];
  for (let beat = 0; beat < 3; beat++) {
    const h = popupHorizontal(workArea, cur.winX, cur.frame, cur.h);
    const next = step(workArea, cur.winX, cur.frame, cur.h, POPUP_W, h);
    cur = { winX: next.winX, frame: POPUP_W, h };
    popupBeats.push(next.catX);
  }

  const hClose = restingHorizontal(workArea, cur.winX, POPUP_W, cur.h, restingW);
  const closed = step(workArea, cur.winX, POPUP_W, cur.h, restingW, hClose);
  const hRe = restingHorizontal(workArea, closed.winX, restingW, hClose, restingW);
  const resettled = step(workArea, closed.winX, restingW, hClose, restingW, hRe);

  return {
    resting: rest.catX,
    restingRounds: rest.rounds,
    popupBeats,
    popupWin: cur.winX,
    popupAlign: cur.h,
    closed: closed.catX,
    resettled: resettled.catX,
    restingAlign: rest.align,
  };
}

// 屏幕清单覆盖真实 Mac 的常见与极端情形，含负原点的外接屏（工作区不是从 0 开始，
// 任何把 workArea.x 当 0 的算术都会在这里露出来）。
const SCREENS = [
  [{ x: 0, y: 24, width: 1440, height: 876 }, '1440×900'],
  [{ x: 0, y: 24, width: 1728, height: 1085 }, '1728 MBP14'],
  [{ x: 0, y: 24, width: 1024, height: 744 }, '1024 最窄 Mac'],
  [{ x: 1440, y: 0, width: 1920, height: 1080 }, '外接屏 x=+1440'],
  [{ x: -1920, y: 0, width: 1920, height: 1080 }, '外接屏 x=-1920'],
  [{ x: 0, y: 24, width: 3440, height: 1416 }, '3440 带鱼屏'],
];

// 静息帧宽是**内容内蕴**的（胶囊 + 会话点，320～900）：320 = 无徽标，438 = 两个额度，
// 504 = 额度徽标全开，688/900 = 极端。这一维必须扫，因为上一个回归正是「拿一个固定
// 像素上限去卡静息帧宽」造成的 —— 504 的合法静息帧被当成弹窗帧，横向贴边被关掉。
const RESTING_WIDTHS = [320, 438, 504, 688, 900];

// 每一轮共用的断言：从落位收敛后的位置起，开关一轮弹窗，猫必须一格不动。
function assertStable(where, r) {
  for (const [beat, catX] of r.popupBeats.entries()) {
    assert.strictEqual(catX, r.resting,
      `${where}：开弹窗第 ${beat + 1} 拍把猫从 ${r.resting} 挪到了 ${catX}（对齐 ${r.popupAlign}）`);
  }
  assert.strictEqual(r.closed, r.resting,
    `${where}：关弹窗把猫从 ${r.resting} 挪到了 ${r.closed}`);
  assert.strictEqual(r.resettled, r.resting,
    `${where}：关弹窗后再落位把猫挪到了 ${r.resettled}`);
}

// ── 回归一：贴边时开弹窗，猫的横向锚点不能变 ─────────────────────────────────
// 用户实测：「喵在靠边的位置，点击以后，弹出来的气泡会自动把喵移动到靠中间的位置，
// 关了气泡以后，又回到边缘了」。
// 成因：choosePopupLayout 横向恒返回 'center'，窗口从 320 涨到 520 时猫的窗内偏移
// 变成 200，applyPetSize 把窗口钳回工作区时正好吃掉这 200px。
// 这里额外断言猫**真的贴在**工作区缘上 —— 光「不动」不够，还得确认横向贴边本身没坏
// （那正是 6e4e998 那次回归：猫停在离边缘一百多像素的地方，稳定地不动）。
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    if (workArea.width - 24 < restingW) continue;
    for (const align of ['center', 'left', 'right']) {
      // 窗口撞死左缘 / 右缘：用户把猫往屏幕边上拖，先撞边的是窗口。
      for (const [name, winX, expectCatX] of [
        ['窗口贴死左缘', workArea.x, workArea.x],
        ['窗口贴死右缘', waRight - restingW, waRight - CAT],
      ]) {
        const where = `${label} 静息帧${restingW} 起始对齐${align} ${name}`;
        const r = cycle(workArea, restingW, winX, align, where);
        assertStable(where, r);
        assert.strictEqual(r.resting, expectCatX,
          `${where}：猫应该贴在工作区缘 ${expectCatX}，实际停在 ${r.resting}（横向贴边坏了）`);
      }
    }
  }
}

// ── 回归二：屏幕中间开弹窗再关掉，猫不能被搬走 ───────────────────────────────
// 这条是上一条的**反面**，而且它比用户报的那个更严重：关弹窗时 restingEdgeLayout
// 会在窗口还是 520 宽的时候先跑一次，infer 分支认的却是静息帧那 ~100px 留白，于是
// 屏幕中间的猫被误判成贴边 —— 实测猫 x=200 被搬到 0、x=1180 被搬到 1320，**而且关掉
// 气泡也回不来**（是永久位移，不像用户报的那个会自己弹回去）。
// 猫落在 x=200 / 201 这两个点是刻意构造的：偏好顺序里 center 必须排在 left 前面，
// 否则猫会在两种对齐之间摆动，恰好在这里露出来。
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    if (workArea.width - 24 < restingW) continue;
    // 反解出「让猫恰好落在这些屏幕像素上」的窗口原点，跳过会让窗口出屏的（不可达）。
    for (const [name, wantCatX] of [
      ['屏幕正中', workArea.x + Math.round((workArea.width - CAT) / 2)],
      ['猫离左缘 199px', workArea.x + 199],
      ['猫离左缘 200px', workArea.x + 200],
      ['猫离左缘 201px', workArea.x + 201],
      ['猫离左缘 260px', workArea.x + 260],
      ['猫右缘离右缘 200px', waRight - CAT - 200],
      ['猫右缘离右缘 199px', waRight - CAT - 199],
    ]) {
      const winX = wantCatX - catInset(restingW, 'center');
      if (winX < workArea.x || winX + restingW > waRight) continue;
      const where = `${label} 静息帧${restingW} ${name}`;
      const r = cycle(workArea, restingW, winX, 'center', where);
      assertStable(where, r);
      // 屏幕中间的猫不该被判成贴边，落位必须原地不动。
      assert.strictEqual(r.resting, wantCatX,
        `${where}：屏幕中间的猫被误判成贴边，从 ${wantCatX} 搬到了 ${r.resting}`);
      assert.strictEqual(r.restingAlign, 'center',
        `${where}：屏幕中间不该判成 ${r.restingAlign}`);
    }
  }
}

// ── 全扫：任何窗口位置、任何静息帧宽、任何屏幕都不许在开关弹窗时动猫 ─────────
// 逐点期望值容易写错（我这次就把 1240 写成了 center，实际是 right —— center 的可行
// 区间是猫 x ∈ [wa.x+200, wa.x+width-320]）。所以除了上面钉边界，这里逐 3px 全扫，
// 只断言不变量本身：落位是不动点、开关弹窗不动猫、520 的弹窗帧完整落在工作区内。
let checked = 0;
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const restingW of RESTING_WIDTHS) {
    if (workArea.width - 24 < restingW) continue;
    for (const align of ['center', 'left', 'right']) {
      for (let winX = workArea.x; winX <= waRight - restingW; winX += 3) {
        const where = `${label} 静息帧${restingW} 对齐${align} 窗口x=${winX}`;
        const r = cycle(workArea, restingW, winX, align, where);
        checked++;
        assertStable(where, r);
        // 猫不动是必要条件但不充分：还得保证弹窗帧本身没被顶出屏，否则卡片会被裁。
        assert(r.popupWin >= workArea.x - 0.5 && r.popupWin + POPUP_W <= waRight + 0.5,
          `${where}：弹窗帧（原点 ${r.popupWin}，宽 ${POPUP_W}）探出了工作区`);
      }
    }
  }
}
assert(checked > 10000, `全扫覆盖太少（只有 ${checked} 个位置），屏幕/帧宽清单是不是被删空了`);

// ── 模型忠实度 ───────────────────────────────────────────────────────────────
// 上面每个公式都是从下面这些行抄来的。它们一旦改写，这个 suite 的结论就不再代表
// 真实链条 —— 那时应该同步改模型，而不是让一个已经失真的模型继续绿着。
assert(/localX = anchor\.xOffset;/.test(mainJs)
  && /localX = width - anchor\.xOffset - anchor\.width;/.test(mainJs)
  && /localX = width \/ 2 \+ anchor\.xOffset - anchor\.width \/ 2;/.test(mainJs),
  'anchoredPetOrigin 的三条 localX 分支变了，本 suite 的反解模型需要同步');
assert(/x = Math\.min\(Math\.max\(x, wa\.x\), wa\.x \+ wa\.width - width\);/.test(mainJs),
  'applyPetSize 的横向钳制变了，本 suite 的钳制模型需要同步');
assert(/xAlign === 'left'\s*\?\s*rect\.left/.test(petJs)
  && /xAlign === 'right'\s*\?\s*viewportW - rect\.right/.test(petJs)
  && /rect\.left \+ rect\.width \/ 2 - viewportW \/ 2/.test(petJs)
  && /yOffset = yAlign === 'top' \? rect\.top : viewportH - rect\.bottom/.test(petJs),
  'anchoredLayoutPayload 的 xOffset/yOffset 三条分支变了，本 suite 的锚点模型需要同步');
assert(/allowSnap && next\.horizontal === 'left' && wr\.x <= wa\.x \+ 3 && oldPet\.x > 18\) screenX = wa\.x;/.test(petJs)
  && /anchoredLayoutPayload\(nextLayout, !options\.popup\)/.test(petJs),
  'anchoredLayoutPayload 的左缘 infer 分支变了（弹窗路径禁用吸附），本 suite 需要同步');
assert(/wr\.x \+ wr\.width >= waRight - 3 && wr\.width - oldPet\.x - oldPet\.width > 18/.test(petJs),
  'anchoredLayoutPayload 的右缘 infer 分支变了，本 suite 需要同步');
assert(/inferHorizontalFrameClamp:\s*snapshot\.windowRect\.width <= restingFrameWidth\(\) \+ 2/.test(petJs),
  'restingEdgeLayout 的横向门变了，本 suite 模型里的 frameNow <= restingW + 2 需要同步');
assert(/const POPUP_W = 520;/.test(petJs), '本 suite 的 POPUP_W 必须跟渲染端一致');

console.log(`pet edge cycle checks passed (${checked} positions)`);
