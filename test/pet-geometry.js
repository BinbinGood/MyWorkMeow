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

// ── 横向恒居中 ────────────────────────────────────────────────────────────────
// 2026-09-16 的用户报告：「喵的底部展示栏，如果在靠近边缘的时候，会自动靠边，
// 而不是局中放在喵的下面。」成因是横向和竖直共用同一个 threshold，而调用方传的
// 是竖直方向的实测值（216/218px）—— 于是「离屏幕左/右缘 200 多像素」就算贴边，
// 1440 宽的屏幕上猫几乎永远处于贴边态，胶囊被甩到猫的侧面。
// 结论是横向压根不该贴边（窗口本身也没有吸附），下面三条钉住这一点：贴死左缘、
// 贴死右缘、以及顺手把竖直 threshold 调到极大，都必须还是 center。
for (const [name, windowRect, petRect] of [
  ['贴死左缘', { x: 0, y: 400, width: 320, height: 340 }, { x: 0, y: 200, width: 120, height: 140 }],
  ['贴死右缘', { x: 1120, y: 400, width: 320, height: 340 }, { x: 200, y: 200, width: 120, height: 140 }],
  ['右下角', { x: 1120, y: 560, width: 320, height: 340 }, { x: 200, y: 200, width: 120, height: 140 }],
]) {
  assert.strictEqual(
    geometry.chooseRestingLayout({ workArea, windowRect, petRect, threshold: 218 }).horizontal,
    'center',
    `${name}时胶囊仍要居中在猫正下方，横向不存在贴边态`,
  );
  assert.strictEqual(
    geometry.choosePopupLayout({ workArea, windowRect, petRect, popupHeight: 360 }).horizontal,
    'center',
    `${name}时弹出卡片也只有竖直方向会翻面`,
  );
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
