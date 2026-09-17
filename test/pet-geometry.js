'use strict';

const assert = require('assert');
const geometry = require('../shared/pet-geometry');

const workArea = { x: 0, y: 24, width: 1440, height: 876 };

// Old saved positions put the transparent window at the top while the visible
// pet remained around its bottom. That must be interpreted as a top-edge drag.
assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 24, width: 320, height: 340 },
    petRect: { x: 100, y: 160, width: 120, height: 140 },
  }),
  { vertical: 'below', horizontal: 'center' },
  'top-clamped legacy positions must move the visible pet to the window top',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 900, y: 24, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
    popupHeight: 360,
  }).vertical,
  'below',
  'a popup opened at the top edge must grow below the pet',
);

assert.strictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 280, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
  }).vertical,
  'above',
  'leaving the top zone must restore bubbles and status above the pet',
);

assert.strictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 900, y: 190, width: 320, height: 340 },
    petRect: { x: 100, y: 0, width: 120, height: 140 },
    threshold: 216,
  }).vertical,
  'below',
  'pointerup must not restore the above layout before its real inset fits',
);

assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 460, y: 24, width: 520, height: 760 },
    petRect: { x: 200, y: 480, width: 120, height: 120 },
    threshold: 218,
    inferVerticalFrameClamp: false,
  }),
  { vertical: 'above', horizontal: 'center' },
  'a tall popup clamped to the screen top must not masquerade as a pet edge drag',
);

// ── 横向：没有贴边态了 ────────────────────────────────────────────────────────
// 2026-09-17：横向贴边整套退役。它从来不是功能，是变通 —— 那时主进程 applyPetSize
// 钳的是**透明窗口**，窗口 520 宽而猫只有 120 宽、左右各 200px 留白，猫想待在离屏幕
// 缘 200px 以内时窗口原点会被钳掉、猫被推走（屏幕左右各一条 200px 的「环带」，即用户
// 报的 E3/E4）。把整列 align-items 甩到窗口缘、让猫的窗内偏移变成 0，正是为了让反解
// 出的原点刚好落在工作区缘上、绕开那次钳制。
// 现在钳的对象是猫本体（main.js clampCatOrigin），窗口原点允许悬出屏幕，工作区内每
// 个像素都直接可达：真贴边自然成立，也不再有对齐翻转造成的中间帧（E1）。
// 所以横向恒 'center'，且**任何**几何输入都不能把它改掉 —— 这一组就是钉这件事。
for (const [name, windowRect, petRect] of [
  ['猫本体贴死左缘', { x: 0, y: 400, width: 320, height: 340 }, { x: 0, y: 200, width: 120, height: 140 }],
  ['窗口贴右缘、猫困在留白里', { x: 1120, y: 400, width: 320, height: 340 }, { x: 200, y: 200, width: 120, height: 140 }],
  ['离左缘 200px', { x: 100, y: 400, width: 320, height: 340 }, { x: 100, y: 200, width: 120, height: 140 }],
  ['离右缘 200px', { x: 1020, y: 400, width: 320, height: 340 }, { x: 100, y: 200, width: 120, height: 140 }],
  ['窗口悬出屏幕左侧（钳猫之后的合法状态）', { x: -200, y: 400, width: 520, height: 340 }, { x: 200, y: 200, width: 120, height: 140 }],
]) {
  assert.strictEqual(
    geometry.chooseRestingLayout({ workArea, windowRect, petRect, threshold: 218 }).horizontal,
    'center',
    `${name}：横向恒居中，不允许任何贴边态回来`,
  );
}
// 退役的两个入参就算被老调用方传进来，也不能重新激活横向分支。
assert.strictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 0, y: 400, width: 320, height: 340 },
    petRect: { x: 100, y: 200, width: 120, height: 140 },
    threshold: 218,
    edgeGap: 3,
    inferHorizontalFrameClamp: true,
  }).horizontal,
  'center',
  '退役入参（edgeGap / inferHorizontalFrameClamp）不能重新激活横向贴边',
);

// ── 弹窗横向：也没有对齐可挑了 ────────────────────────────────────────────────
// 旧的 popupHorizontal 解的是「哪种对齐能让 520 的窗口装进工作区、同时不必挪动猫」——
// 那个问题只在**钳窗口**的前提下才存在。钳猫之后窗口原点允许悬出屏幕，帧宽从 320 涨到
// 520 时猫一动不动，于是横向恒 'center'，popupWidth 入参退役。
{
  const petWidth = 120;
  // 逐 3px 全扫：任何猫位置、任何弹窗宽度下横向都必须是 center，一次都不许摆动
  // （对齐摆动就是 E1 那种中间帧的来源）。
  for (let petScreenX = 0; petScreenX <= workArea.width - petWidth; petScreenX += 3) {
    for (const popupWidth of [320, 520, 1600]) {
      assert.strictEqual(
        geometry.choosePopupLayout({
          workArea,
          windowRect: { x: petScreenX, y: 400, width: petWidth, height: 340 },
          petRect: { x: 0, y: 200, width: petWidth, height: 120 },
          popupHeight: 360,
          popupWidth,
        }).horizontal,
        'center',
        `猫在屏幕 x=${petScreenX}、弹窗宽 ${popupWidth}：弹窗横向恒居中`,
      );
    }
  }

  // 没有宽度信息（早期调用、旧测试）时同样居中。
  assert.strictEqual(
    geometry.choosePopupLayout({
      workArea,
      windowRect: { x: 0, y: 400, width: 320, height: 340 },
      petRect: { x: 0, y: 200, width: 120, height: 120 },
      popupHeight: 360,
    }).horizontal,
    'center',
    '拿不到 popupWidth 时横向保持居中',
  );
}

// 帧宽同样不能影响横向。2026-09-16 的回归死在这里：胶囊的 --chip-shift（transform）
// 撑大了 #compact-row.scrollWidth，measuredRestingWidth 把它当内容宽量了进去，帧宽从
// 320 被顶到 381 —— 一脚跨过当时 360 的横向判定上限，猫被 applyPetSize 钳到离边缘
// 130px。用户实测：「出现调用工具的尺寸/思考中，图标自动往中间移动了一点，不靠边了」。
// 横向退役之后这类「帧宽跨过某个阈值 → 猫被搬走」的耦合从原理上就没有了。这一组把它钉死。
for (const frame of [320, 338, 360, 361, 381, 504, 520, 688, 900]) {
  for (const [name, windowRect, petRect] of [
    ['窗口贴左缘、猫内缩', { x: 0, y: 400, width: frame, height: 340 }, { x: 100, y: 200, width: 120, height: 120 }],
    ['窗口贴右缘、猫内缩', { x: 1440 - frame, y: 400, width: frame, height: 340 }, { x: Math.max(0, frame - 220), y: 200, width: 120, height: 120 }],
    ['屏幕中间', { x: 500, y: 400, width: frame, height: 340 }, { x: 100, y: 200, width: 120, height: 120 }],
  ]) {
    assert.strictEqual(
      geometry.chooseRestingLayout({ workArea, windowRect, petRect, threshold: 218 }).horizontal,
      'center',
      `帧宽 ${frame}、${name}：帧宽不许影响横向`,
    );
  }
}

// ── 胶囊按需最小位移 ──────────────────────────────────────────────────────────
// 胶囊比猫宽，「猫贴死边」和「胶囊完整可读且严格居中」不可能同时成立。用户定的
// 口径是默认严格居中、只在会探出工作区时往内挪刚好够用的那点距离。
{
  const shift = (petCenterX, capsuleWidth) =>
    geometry.capsuleShift({ petCenterX, capsuleWidth, workArea });

  // 窄胶囊（比猫两侧余量还窄）在任何位置都不动。
  assert.strictEqual(shift(60, 100), 0, '屏幕最左侧、装得下的胶囊不该有位移');
  assert.strictEqual(shift(1380, 100), 0, '屏幕最右侧、装得下的胶囊不该有位移');
  assert.strictEqual(shift(720, 520), 0, '屏幕中央的宽胶囊本来就居中，不该有位移');

  // 猫贴死左缘（本体 120 宽 → 中心 60），胶囊 520 宽：
  // 居中的左边缘 = 60 - 260 = -200，目标左边缘 = 0 + 4（margin）→ 需要右移 204。
  assert.strictEqual(shift(60, 520), 204, '贴左缘时胶囊只右移刚好不出屏的距离');
  // 对称：猫贴死右缘（中心 1440-60 = 1380）→ 左移 204。
  assert.strictEqual(shift(1380, 520), -204, '贴右缘时胶囊只左移刚好不出屏的距离');

  // 位移随宽度增长而非随位置跳变：同一个位置、更宽的胶囊要挪得更多。
  assert(shift(60, 620) > shift(60, 520), '更宽的胶囊在同一位置需要更大的位移');

  // 比整个工作区还宽：怎么挪都会被裁，宁可两侧对称溢出（中间那段还能读）。
  assert.strictEqual(shift(60, 1600), 0, '宽过工作区的胶囊对称溢出，不往单侧甩');

  // 脏输入不能变成 NaN 位移（会让 translateX 整条规则失效）。
  assert.strictEqual(geometry.capsuleShift({ petCenterX: NaN, capsuleWidth: 520, workArea }), 0,
    '无效中心点必须落回 0');
  assert.strictEqual(geometry.capsuleShift({ petCenterX: 60, capsuleWidth: 0, workArea }), 0,
    '没有胶囊时没有位移');
}

// capsuleShiftFromEdge 已删（2026-09-17）：它解的是「贴边时整列被 align-items 拉到窗口
// 缘、胶囊的 flex 中心偏到猫的一侧」这个问题，而横向贴边整套已退役 —— flex 中心恒在猫
// 正下方，capsuleShift 就够了。断言它不再存在，防止连同横向贴边一起被复活。
assert.strictEqual(typeof geometry.capsuleShiftFromEdge, 'undefined',
  'capsuleShiftFromEdge 必须保持退役：横向贴边没了，flex 中心恒在猫正下方');
assert.strictEqual(typeof geometry.popupHorizontal, 'undefined',
  'popupHorizontal 必须保持退役：钳猫之后帧宽不影响猫的位置，没有对齐可挑');

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'above', workArea, targetWindowY: 24, petScreenY: 204, abovePetOffset: 180,
  }),
  'below',
  'dragging the transparent frame into the top boundary must switch before pointerup',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'below', workArea, targetWindowY: 80, petScreenY: 80, abovePetOffset: 180,
  }),
  'below',
  'the top layout stays below while a normal above frame would still be off-screen',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'below', workArea, targetWindowY: 220, petScreenY: 220, abovePetOffset: 180,
  }),
  'above',
  'dragging back into the desktop restores the normal above layout during the gesture',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 900, y: 560, width: 320, height: 340 },
    petRect: { x: 100, y: 180, width: 120, height: 140 },
    current: { vertical: 'above', horizontal: 'center' },
    popupHeight: 360,
  }).vertical,
  'above',
  'a popup opened at the bottom edge must stay above the pet',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 700, y: 24, width: 520, height: 624 },
    petRect: { x: 200, y: 309, width: 120, height: 120 },
    current: { vertical: 'above', horizontal: 'center' },
    popupHeight: 310,
  }).vertical,
  'below',
  'one pixel less than the fixed panel height must flip the panel below',
);

assert.strictEqual(
  geometry.choosePopupLayout({
    workArea,
    windowRect: { x: 700, y: 24, width: 520, height: 624 },
    petRect: { x: 200, y: 310, width: 120, height: 120 },
    current: { vertical: 'below', horizontal: 'center' },
    popupHeight: 310,
  }).vertical,
  'above',
  'at exactly one panel height from the top, the panel must return above',
);

function assertMenuInside(label, options) {
  const result = geometry.radialLayout(options);
  assert.strictEqual(result.points.length, options.count, `${label}: every item must receive a position`);
  const safe = options.safeRect;
  for (const point of result.points) {
    assert(point.x >= safe.x + 23 && point.x <= safe.x + safe.width - 23, `${label}: x must be visible`);
    assert(point.y >= safe.y + 23 && point.y <= safe.y + safe.height - 23, `${label}: y must be visible`);
  }
}

function assertSemicircle(label, direction, options) {
  const result = geometry.radialLayout({ ...options, preferred: [direction] });
  assert.strictEqual(result.direction, direction, `${label}: fan must face inward`);
  const first = result.points[0];
  const last = result.points[result.points.length - 1];
  const span = Math.hypot(last.x - first.x, last.y - first.y);
  assert(Math.abs(span - result.radius * 2) < 0.01, `${label}: endpoints must span a full diameter`);
  for (let i = 1; i < result.points.length; i++) {
    const prev = result.points[i - 1];
    const point = result.points[i];
    assert(Math.hypot(point.x - prev.x, point.y - prev.y) >= 46,
      `${label}: neighbouring 46px controls must not overlap`);
  }
}

assertMenuInside('top-left menu', {
  count: 8,
  center: { x: 62, y: 72 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  preferred: ['right', 'below'],
});

assertSemicircle('left-edge menu', 'right', {
  count: 8,
  center: { x: 62, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
});

assertSemicircle('right-edge menu', 'left', {
  count: 8,
  center: { x: 258, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
});

assertMenuInside('bottom-right menu', {
  count: 8,
  center: { x: 258, y: 268 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  preferred: ['above', 'left'],
});

function assertMenuAvoidsPet(label, options) {
  const result = geometry.radialLayout(options);
  const pet = options.avoidRect;
  const radius = options.itemRadius || 23;
  const gap = options.gap || 0;
  for (const point of result.points) {
    assert(
      point.x <= pet.x - radius - gap
        || point.x >= pet.x + pet.width + radius + gap
        || point.y <= pet.y - radius - gap
        || point.y >= pet.y + pet.height + radius + gap,
      `${label}: action buttons must not cover the pet`,
    );
  }
}

assertMenuAvoidsPet('left-edge action dock', {
  count: 3,
  center: { x: 60, y: 280 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  avoidRect: { x: 0, y: 220, width: 120, height: 120 },
  preferred: ['right', 'above'],
  itemRadius: 26,
  gap: 10,
});

assertMenuAvoidsPet('right-edge action dock', {
  count: 3,
  center: { x: 260, y: 280 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  avoidRect: { x: 200, y: 220, width: 120, height: 120 },
  preferred: ['left', 'above'],
  itemRadius: 26,
  gap: 10,
});

assertMenuAvoidsPet('top-edge action dock', {
  count: 3,
  center: { x: 160, y: 60 },
  safeRect: { x: 0, y: 0, width: 320, height: 340 },
  avoidRect: { x: 100, y: 0, width: 120, height: 120 },
  preferred: ['below', 'right'],
  itemRadius: 26,
  gap: 10,
});

console.log('pet edge geometry checks passed');
