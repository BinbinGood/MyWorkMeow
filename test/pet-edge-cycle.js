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

const CAT = 120;        // #cat 是 120×120
const POPUP_W = 520;    // renderer/pet.js 的 POPUP_W
const FRAME_H = 340;    // BASE_H

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

// 落位到不动点，返回收敛后的状态与用掉的轮数。
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
const SCREENS = [
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
const RESTING_WIDTHS = [320, 438, 504, 688, 900];

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
// 补偿走 --pop-shift（renderer/pet.js applyPopupShift，复用 capsuleShift 的
// 「按需最小位移」口径）。这里逐 1px 全扫，确认补偿之后没有任何位置会裁到内容。
const POPUPS = [['peek', 320], ['ask', 340], ['bubble', 340]];
let popupChecked = 0;
for (const [workArea, label] of SCREENS) {
  const waRight = workArea.x + workArea.width;
  for (const [name, popW] of POPUPS) {
    for (let catX = workArea.x; catX <= waRight - CAT; catX += 1) {
      // 弹窗帧恒 520 宽，猫居中 → 原点 = catX - inset。
      const winX = catX - catInset(POPUP_W);
      const shift = geometry.capsuleShift({
        petCenterX: catX + CAT / 2,
        capsuleWidth: popW,
        workArea,
      });
      // align-items: center → 弹窗在帧内居中；再加 relative left 的位移。
      const left = winX + (POPUP_W - popW) / 2 + shift;
      popupChecked++;
      assert(left >= workArea.x - 0.5 && left + popW <= waRight + 0.5,
        `${label} ${name}(${popW}宽) 猫x=${catX}：弹窗落在 ${left}..${left + popW}，`
        + `探出工作区 ${workArea.x}..${waRight}（--pop-shift 补偿失效）`);
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
// 竖直方向仍然钳窗口 —— 高弹窗不能把猫和底部按钮顶出屏幕。这一维没跟着改。
assert(/y = Math\.min\(Math\.max\(y, wa\.y\), wa\.y \+ wa\.height - h\);/.test(mainJs),
  '竖直钳制必须保留：高弹窗会把猫和底部按钮顶出屏幕');
// xAlign 恒 center：横向对齐维度已退役，本 suite 的 catInset 才能是纯常量。
assert(/const xAlign = 'center';/.test(petJs),
  'anchoredLayoutPayload 的 xAlign 必须恒为 center，本 suite 的 catInset 才成立');
assert(/const xOffset = rect\.left \+ rect\.width \/ 2 - viewportW \/ 2;/.test(petJs)
  && /yOffset = yAlign === 'top' \? rect\.top : viewportH - rect\.bottom/.test(petJs),
  'anchoredLayoutPayload 的 xOffset/yOffset 变了，本 suite 的锚点模型需要同步');
// 竖直的 infer 吸附分支保留（横向那两条已删）。
assert(/allowSnap && next\.vertical === 'below' && wr\.y <= wa\.y \+ 3 && oldPet\.y > 18\) screenY = wa\.y;/.test(petJs)
  && /anchoredLayoutPayload\(nextLayout, !options\.popup\)/.test(petJs),
  'anchoredLayoutPayload 的竖直 infer 分支变了（弹窗路径禁用吸附），本 suite 需要同步');
assert(!/inferHorizontalFrameClamp/.test(petJs),
  '横向 infer 门必须保持退役：钳猫之后「窗口被钳住而猫还没到边」这个状态不存在了');
assert(/const POPUP_W = 520;/.test(petJs), '本 suite 的 POPUP_W 必须跟渲染端一致');
// 弹窗溢出补偿：--pop-shift 必须是 relative left（不能是 transform —— .peek/.ask/.think
// 的入场动画 keyframes 结尾是 transform:none，会把位移擦掉；也不能是 margin —— 会挤压
// 兄弟节点、把整列布局宽度推出去）。
assert(/function applyPopupShift\(/.test(petJs) && /--pop-shift/.test(petJs),
  '弹窗的按需内缩必须存在：钳猫之后居中的弹窗会探出屏幕 100~110px');
assert(/\.peek, \.ask, \.bubble, \.think \{[^}]*left:\s*var\(--pop-shift/.test(petCss),
  '--pop-shift 必须走 relative left：transform 会被入场动画擦掉，margin 会挤压布局');

console.log(`pet edge cycle checks passed (${checked} cycles, ${reachable} reachability, ${popupChecked} popup)`);
