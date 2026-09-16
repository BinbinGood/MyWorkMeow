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

// ── 横向贴边 ──────────────────────────────────────────────────────────────────
// 2026-09-16 的回归：横向曾与竖直共用同一个 threshold，而调用方传的是竖直方向的
// 实测值（216/218px）—— 于是「离屏幕左/右缘 200 多像素」就算贴边，回中还要 2×
// ≈ 436px 的双侧余量，1440 宽的屏幕上猫待在右下角时永远处于贴边态。
// 我第一版的修法是把横向整个删掉（恒 center），结果猫左右也不能贴边了：本体只有
// 120 宽而窗口 320 宽，center 锚点下窗内偏移约 100px，主进程 applyPetSize 把窗口
// 钳进工作区时正好把这 100px 吃掉，松手就弹回中间。
// 所以横向判定必须回来，但问的是**真贴边了吗**（edgeGap，默认 3px），不是「离边
// 缘两百来像素」。下面三条按「贴死 / 差一点 / 明显没贴」把边界钉住。
for (const [name, windowRect, petRect, expected] of [
  // 猫本体就在工作区左缘上
  ['贴死左缘', { x: 0, y: 400, width: 320, height: 340 }, { x: 0, y: 200, width: 120, height: 140 }, 'left'],
  // 窗口右缘吃满工作区，猫困在窗口里 100px（透明留白）—— inferHorizontalFrameClamp 的场景
  ['贴死右缘', { x: 1120, y: 400, width: 320, height: 340 }, { x: 200, y: 200, width: 120, height: 140 }, 'right'],
  // 这条才是真正堵住原 bug 的：离左缘 200px，旧代码（threshold 218）会判成 left
  ['离左缘 200px', { x: 100, y: 400, width: 320, height: 340 }, { x: 100, y: 200, width: 120, height: 140 }, 'center'],
  // 对称的右侧：猫右边缘离工作区右缘 200px
  ['离右缘 200px', { x: 1020, y: 400, width: 320, height: 340 }, { x: 100, y: 200, width: 120, height: 140 }, 'center'],
]) {
  assert.strictEqual(
    geometry.chooseRestingLayout({ workArea, windowRect, petRect, threshold: 218 }).horizontal,
    expected,
    `${name}：横向只认真贴边，不能借用竖直方向的阈值`,
  );
  // 弹出卡片是 520 定宽窗口，横向靠 applyPetSize 兜底，不参与贴边。
  assert.strictEqual(
    geometry.choosePopupLayout({ workArea, windowRect, petRect, popupHeight: 360 }).horizontal,
    'center',
    `${name}：弹出卡片只有竖直方向会翻面`,
  );
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
