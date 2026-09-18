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

// 2026-09-18（E2）：帧高恒定（744）之后这个形状是**常态**而不是特例 —— 帧顶恒在猫上方
// 约 600px、常常压在工作区上缘甚至悬出屏幕外，而猫本体离上缘还很远。判据只看猫本体，
// 所以必须是 'above'。旧代码在这里靠 inferVerticalFrameClamp 才不误判成贴顶拖动，那个门
// 已随竖直钳猫（main.js clampCatOriginY）整体退役：猫顶到上缘就是窗口能上到的极限，
// 「窗口被拦住而猫没到边」这个状态不存在了。下面顺带钉住：老调用方就算把它传进来，
// 也不能重新激活任何竖直分支。
assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 460, y: 24, width: 520, height: 760 },
    petRect: { x: 200, y: 480, width: 120, height: 120 },
    threshold: 218,
  }),
  { vertical: 'above', horizontal: 'center' },
  'a tall constant-height frame whose top sits at the work-area edge must not masquerade as a top-edge drag: only the cat body decides',
);
assert.deepStrictEqual(
  geometry.chooseRestingLayout({
    workArea,
    windowRect: { x: 460, y: -100, width: 520, height: 744 },
    petRect: { x: 200, y: 600, width: 120, height: 120 },
    threshold: 218,
    inferVerticalFrameClamp: true,
  }),
  { vertical: 'above', horizontal: 'center' },
  '退役入参 inferVerticalFrameClamp 不能重新激活竖直贴顶：帧原点悬出屏幕上方是钳猫之后的合法常态',
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

  // ── 位移必须封顶：胶囊要跟着猫出屏 ────────────────────────────────────────
  // 用户实测（F1）：「拖动喵到边缘，继续往边缘拖的时候（还没松鼠标），喵会移出屏幕，
  // 但是底部胶囊没有跟随，一直保持在屏幕里面」。
  // 成因：溢出量无上限，猫每往外一像素，位移就跟着涨一像素，胶囊被一路推回屏幕里。
  // 上限 = (胶囊宽-猫宽)/2 + margin，即「猫贴死缘时那个位移」。
  const CAP520 = (520 - 120) / 2 + 4; // 204
  assert.strictEqual(shift(60, 520), CAP520, '猫贴死左缘时位移恰好等于上限');
  for (const out of [1, 10, 60, 200, 500, 2000]) {
    assert.strictEqual(shift(60 - out, 520), CAP520,
      `猫向左出屏 ${out}px：位移必须停在上限 ${CAP520}，否则胶囊会脱开猫留在屏幕里`);
    assert.strictEqual(shift(1380 + out, 520), -CAP520,
      `猫向右出屏 ${out}px：位移必须停在上限 -${CAP520}`);
  }
  // 饱和的直接后果：胶囊的缘恒在猫的同侧缘往内 margin 处，猫再往外走胶囊 1:1 跟着走。
  for (const out of [1, 50, 300]) {
    const catX = workArea.x - out;              // 猫的左上角
    const s = shift(catX + 60, 520);
    const capsuleLeft = catX + 60 - 260 + s;
    assert.strictEqual(capsuleLeft, catX + 4,
      `猫出屏 ${out}px：胶囊左缘必须跟到猫左缘+margin（${catX + 4}），实际 ${capsuleLeft}`);
  }

  // ── 自愈：出屏坐标与钳定坐标算出的位移必须相等 ──────────────────────────
  // 用户实测（F1 后半段）：「松开鼠标，喵会到屏幕，处在边缘，但是底部的胶囊却没保持
  // 居中，还保持刚才喵移出屏幕的时候的相对位置。只有点一下喵，气泡刷新后，才恢复正常」。
  // 主进程 clampCatOrigin 把猫钳回边缘时**不通知渲染端**，而窗口移动不触发渲染端的
  // resize，所以渲染端手里永远是拖动留下的出屏坐标 —— 事后重算等不到。
  // 这一条断言的正是「不需要重算」：两种输入所需位移都已饱和到同一个上限，那个
  // 「过期」值本来就是正确值。它一旦不成立，就必须补一条主进程回报通道。
  for (const capsuleWidth of [160, 275, 340, 480, 520, 620]) {
    for (const out of [1, 7, 120, 900]) {
      for (const [name, dragged, settled] of [
        ['左', workArea.x - out, workArea.x],
        ['右', workArea.x + workArea.width - 120 + out, workArea.x + workArea.width - 120],
      ]) {
        assert.strictEqual(
          shift(dragged + 60, capsuleWidth),
          shift(settled + 60, capsuleWidth),
          `胶囊${capsuleWidth} 向${name}出屏 ${out}px：出屏位移与钳定后的位移必须相等`
          + '（否则松手后胶囊会卡在过期位移上，非得点一下猫刷新才回正）',
        );
      }
    }
  }

  // ── frameWidth：第二层封顶（帧内余量）────────────────────────────────────
  // 2026-09-18（H2）。用户实测：「喵在屏幕边缘的时候，气泡弹窗的消息不完整。不是靠近
  // 屏幕边缘不完整，而是另一边。」成因是上面那套封顶只保证「不出**屏幕**」，而真正在
  // 裁内容的是 renderer/pet.css:3-7 的 html,body{overflow:hidden} —— 它裁的是**窗口帧**。
  // #stage 的 align-items:center 先把弹窗居中在帧里（每侧余量 (帧宽-弹窗宽)/2），
  // --pop-shift 再往一侧加位移，超过余量的部分就被帧裁掉 —— 裁的是位移**去向**那一侧，
  // 也就是**远离屏幕边缘**那一侧，精确对上用户的描述。
  const framed = (petCenterX, capsuleWidth, frameWidth) =>
    geometry.capsuleShift({ petCenterX, capsuleWidth, workArea, frameWidth });

  // 默认不压：不传 frameWidth 时行为必须和上面所有 fixture 完全一致（按调用点选择加入，
  // --chip-shift 那一路的帧宽是变的 restingFrameWidth()，暂不传）。
  // ⚠️ 这两条必须**真的省略**这个参数，而不是显式传 Infinity —— 变异测试（M5）证明：
  // 把默认值从 Infinity 改成 520，显式传 Infinity 的断言全绿，只有省略参数的能抓到。
  // 默认值一旦变成有限数，--chip-shift 那一路会被连带压顶，改掉「贴边留 4px」的观感。
  assert.strictEqual(geometry.capsuleShift({ petCenterX: 60, capsuleWidth: 520, workArea }), 204,
    '省略 frameWidth 时必须完全不压（默认值必须是 Infinity，不能是任何有限帧宽）');
  assert.strictEqual(geometry.capsuleShift({ petCenterX: 60, capsuleWidth: 620, workArea }), 254,
    '省略 frameWidth 且弹窗宽过 520：仍然不压，否则默认值偷偷在压顶');
  assert.strictEqual(framed(60, 520, Infinity), 204, '显式 Infinity 必须完全不压');
  assert.strictEqual(framed(60, 520, NaN), 204, '脏 frameWidth 必须退化成不压，而不是压成 0');

  // 真机主靶：帧 520、猫贴死左缘。
  //   peek 320：帧内余量 (520-320)/2 = 100 < 原上限 104 → 位移被压到 100
  //   ask 340： 帧内余量 (520-340)/2 =  90 < 原上限 114 → 位移被压到  90
  // 修前 probeEdge 靶 A 实测 popShift=104、peek L=204 R=524、clipRight=4，与「压之前是
  // 104」逐位吻合；压到 100 之后 R=520，正好贴住帧缘不被裁。
  assert.strictEqual(framed(60, 320, 520), 100, 'peek 在 520 帧里最多只能移动帧内余量 100');
  assert.strictEqual(framed(60, 340, 520), 90, 'ask/bubble 在 520 帧里最多只能移动帧内余量 90');
  assert.strictEqual(framed(1380, 340, 520), -90, '右缘对称');

  // 压过之后必须**恰好**贴住帧缘：多一像素就被裁，少一像素就白丢可见宽度。
  for (const w of [160, 320, 340, 496, 519]) {
    const s = framed(60, w, 520);
    const inFrame = (520 - w) / 2 + s;
    assert(inFrame >= 0 && inFrame + w <= 520,
      `弹窗${w} 贴左缘：帧内落在 ${inFrame}..${inFrame + w}，探出 0..520 会被 overflow:hidden 裁掉`);
  }

  // 压顶不能破坏自愈（上面那条「出屏位移 == 钳定位移」）：两种输入都饱和到**同一个**
  // 更小的上限，依然相等。它一旦不成立就必须补主进程回报通道。
  for (const w of [160, 340, 520]) {
    for (const out of [1, 120, 900]) {
      assert.strictEqual(framed(workArea.x - out + 60, w, 520), framed(workArea.x + 60, w, 520),
        `弹窗${w} 向左出屏 ${out}px：加了帧内封顶之后，自愈（出屏位移==钳定位移）必须仍然成立`);
    }
  }

  // 帧比弹窗还窄 → 余量为负。必须夹回 0（不许位移，只能对称溢出），
  // 否则 clamp(v, -cap, cap) 的上下界反相，位移会被甩到**错误方向**。
  // ⚠️ 这一条是变异测试（M4）发现的覆盖缺口：实现里写了 max(0,…) 但没有 fixture 钉住。
  assert.strictEqual(framed(60, 340, 320), 0, '帧比弹窗窄：余量为负必须夹回 0，不许反向位移');
  assert.strictEqual(framed(1380, 340, 200), 0, '帧远窄于弹窗：同样只能对称溢出');
  // 而且必须是 +0 不是 -0。cap 能恰好等于 0 是这一版新出现的（原先 cap ≥ margin = 4），
  // 此时 clamp(负溢出, -0, 0) 产出 -0；String(-0) === '0' 所以 CSS 侧无害，但会让调用方
  // 的 Object.is/strictEqual 比较莫名其妙。strictEqual 分不出 ±0，所以显式用 Object.is。
  assert(Object.is(framed(1380, 340, 200), 0), '位移 0 必须是 +0，不能把 -0 漏给调用方');
}

// capsuleShiftFromEdge 已删（2026-09-17）：它解的是「贴边时整列被 align-items 拉到窗口
// 缘、胶囊的 flex 中心偏到猫的一侧」这个问题，而横向贴边整套已退役 —— flex 中心恒在猫
// 正下方，capsuleShift 就够了。断言它不再存在，防止连同横向贴边一起被复活。
assert.strictEqual(typeof geometry.capsuleShiftFromEdge, 'undefined',
  'capsuleShiftFromEdge 必须保持退役：横向贴边没了，flex 中心恒在猫正下方');
assert.strictEqual(typeof geometry.popupHorizontal, 'undefined',
  'popupHorizontal 必须保持退役：钳猫之后帧宽不影响猫的位置，没有对齐可挑');

// ── 拖动途中的上/下让位 ──────────────────────────────────────────────────────
// 2026-09-18（E2）：签名从「帧 y + 猫在帧内的偏移」（targetWindowY / abovePetOffset）
// 换成**猫的屏幕 y**。旧的拿「帧顶撞到工作区上缘」当「猫上方没空间了」的代理，而帧高
// 恒定（744）之后猫上方恒有约 600px 透明留白、且合法悬出屏幕上方 → 那个代理恒真，
// 一拖动就永远判 below。现在和 chooseRestingLayout 是**同一条规则**：只看猫本体离上缘。
assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    workArea, petScreenY: workArea.y + 100, topRoom: 180,
  }),
  'below',
  'dragging the cat body into the top boundary must switch before pointerup',
);

assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    workArea, petScreenY: workArea.y + 400, topRoom: 180,
  }),
  'above',
  'dragging back into the desktop restores the normal above layout during the gesture',
);

// 帧原点悬出屏幕上方（钳猫之后的合法常态）不许影响判定：猫离上缘 400px 就是 above，
// 帧顶在 wa.y - 520 也一样。这一条钉的正是旧代理量恒真的那个坑。
assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    workArea, petScreenY: workArea.y + 400, topRoom: 180,
    targetWindowY: workArea.y - 520, abovePetOffset: 597,
  }),
  'above',
  '退役入参（targetWindowY / abovePetOffset）不能把「帧顶悬出屏幕」重新当成贴顶',
);

// 无粘性：拖动途中的方向每次都由当前几何重算，'below' 不是可继承的历史状态。
assert.strictEqual(
  geometry.chooseDragVerticalLayout({
    current: 'below', workArea, petScreenY: workArea.y + 400, topRoom: 180,
  }),
  'above',
  'the below layout must not be sticky: it is a top-edge accommodation, not a mode',
);

// 边界恰好落在 topRoom + boundarySlack 上：含等号算 below（拖到线上就让位，
// 别让猫卡在「气泡刚好差 1px 放不下」的位置反复翻转）。
for (const [delta, want] of [[180 + 2, 'below'], [180 + 3, 'above']]) {
  assert.strictEqual(
    geometry.chooseDragVerticalLayout({
      workArea, petScreenY: workArea.y + delta, topRoom: 180, boundarySlack: 2,
    }),
    want,
    `离上缘 ${delta}px（topRoom 180 + slack 2）必须判 ${want}`,
  );
}

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
