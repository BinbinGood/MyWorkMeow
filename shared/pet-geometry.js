'use strict';

// Pure geometry shared by the renderer and regression tests. Keeping the
// decisions here makes the edge cases (top/left/corners) testable without an
// Electron desktop.
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PetGeometry = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  // 猫本体（#cat）的宽度。renderer/pet.css 把它写死成 120×120 且不带任何 transform，
  // 所以它是常量而不是测量值；main.js 的 PET_BODY_W 是同一个数。
  const PET_BODY_W = 120;

  function normalizeRect(rect) {
    const x = Number(rect && rect.x) || 0;
    const y = Number(rect && rect.y) || 0;
    const width = Math.max(0, Number(rect && rect.width) || 0);
    const height = Math.max(0, Number(rect && rect.height) || 0);
    return { x, y, width, height, right: x + width, bottom: y + height };
  }

  // threshold 只服务竖直方向，语义是「猫本体上方还够不够放气泡」。调用方传的是
  // 实测值（约 216px），量纲对得上。
  //
  // 横向**没有贴边态**（2026-09-17 起）。之前有，而且是三个 bug 的来源：
  // 那时主进程 applyPetSize 钳的是**透明窗口**，窗口 520 宽而猫只有 120 宽，
  // 左右各 200px 留白，所以猫想待在离屏幕缘 200px 以内时窗口原点会被钳掉，猫被
  // 推走 —— 屏幕左右各一条 200px 的「环带」。横向贴边（把整列 align-items 甩到
  // 窗口缘、让猫的窗内偏移变成 0）正是为绕开那个钳制发明的变通，不是功能。
  // 现在钳的对象换成了猫本体（main.js clampCatOrigin），窗口原点允许悬出屏幕，
  // 猫在工作区内的**每一个**像素都直接可达，于是：
  //   · 「真贴边」由钳猫自然做到，不需要任何对齐切换；
  //   · 环带消失（E3/E4）；
  //   · 拖动中与落位后的窗内偏移恒定，没有 class 翻转、没有中间帧（E1）。
  // 所以这里横向恒返回 'center'，edgeGap / inferHorizontalFrameClamp 两个入参已退役
  // （留着只为不炸老调用方，值被忽略）。竖直的 threshold / inferVerticalFrameClamp
  // **仍然在用** —— 贴顶时气泡要往下让位，那是真实需求。
  //
  // 胶囊比猫宽，居中在猫正下方时可能探出工作区。那件事交给下面的 capsuleShift
  // （按需最小位移：默认严格居中，只在会出屏时往内挪刚好够用的距离），与贴边无关。
  //
  // 不收 current：方向每次都由当前几何重新判定。"below" 只是贴顶时的临时让位，
  // 不能作为粘性历史状态。
  function chooseRestingLayout({
    workArea,
    windowRect,
    petRect,
    threshold = 168,
    inferVerticalFrameClamp = true,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const pet = {
      x: wr.x + pr.x,
      y: wr.y + pr.y,
      width: pr.width,
      height: pr.height,
    };
    pet.right = pet.x + pet.width;
    pet.bottom = pet.y + pet.height;

    // "below" is exclusively a top-edge accommodation. Do not keep it as a
    // sticky historical state after the pet has returned to the desktop: all
    // bubbles/status chips belong above the pet everywhere else.
    let vertical = 'above';

    // The second half of the test catches the old failure mode: the transparent
    // window has already been clamped to the work-area edge, while the visible
    // pet is still stranded well inside that window.
    if (pet.y - wa.y <= threshold
      || (inferVerticalFrameClamp && wr.y <= wa.y + 3 && pr.y > 18)) vertical = 'below';

    return { vertical, horizontal: 'center' };
  }

  // 胶囊（底部展示栏）需要的水平位移，单位 px，正数向右。
  //
  // 用户定的口径是「按需最小位移」：默认严格居中在猫正下方，一动不动；只有居中
  // 会让胶囊探出工作区时，才往内挪**刚好不出屏**的那点距离。窄胶囊在任何位置都
  // 返回 0；宽胶囊只在贴边时才有非零位移，且位移量随胶囊宽度增长而非随位置跳变。
  //
  // 两侧同时挤不下（胶囊比整个工作区还宽）时返回居中偏移，宁可两边对称溢出，
  // 也不要单侧甩出去 —— 那种情况下无论怎么挪都会被裁，对称至少还能读中间。
  //
  // 2026-09-17：位移必须**封顶**。溢出量本身是无上限的 —— 猫被拖出屏幕时它随距离
  // 线性增长，于是胶囊被一路推回屏幕里、和猫脱开（用户原话：「拖动喵到边缘继续往
  // 边缘拖，喵会移出屏幕，但是底部胶囊没有跟随，一直保持在屏幕里面」）。
  //
  // 上限取「猫贴死工作区缘时所需的那个位移」，即 (胶囊宽-猫宽)/2 + margin。含 margin
  // 是有意的：猫合法地贴边时胶囊仍应留出那 4px 屏幕留白（现行观感，别动）。饱和之后
  // 胶囊的缘恒在猫的同侧缘往内 margin 处，猫再往外走胶囊就 1:1 跟着走。
  //
  // 封顶顺带修掉了松手后那个「位移卡住」的后半段：主进程 clampCatOrigin 把猫钳回
  // 边缘时不会通知渲染端，渲染端手里还是拖动留下的**出屏**坐标。但猫刚出屏时所需
  // 位移 > 上限（被削到上限），而猫贴死边缘时所需位移**恰好等于**上限 —— 两者相等，
  // 那个「过期」位移本来就是正确值，不需要额外的主进程回报通道。
  // 反过来说：上限一旦不含 margin，贴边时的位移会被削（204→200）而出屏时也是 200，
  // 虽然仍然相等、自愈仍成立，但会白丢那 4px 留白。所以 margin 必须算进上限。
  function capsuleShift({ petCenterX, capsuleWidth, workArea, margin = 4, petWidth = PET_BODY_W }) {
    const wa = normalizeRect(workArea);
    const width = Math.max(0, Number(capsuleWidth) || 0);
    const center = Number(petCenterX);
    if (!width || !Number.isFinite(center)) return 0;
    const pad = Math.max(0, Number(margin) || 0);
    const half = width / 2;
    const minLeft = wa.x + pad;
    const maxRight = wa.right - pad;

    // 比可用宽度还宽：挪不出结果，对称溢出。
    if (width >= maxRight - minLeft) return 0;

    // 胶囊比猫窄时上限只剩 margin：它横向整个落在猫的跨度里，猫在屏内它就在屏内，
    // 猫出屏它就该一起出屏，更大的位移只会让它脱离猫。
    const body = Math.max(0, Number(petWidth) || 0);
    const cap = Math.max(0, (width - body) / 2) + pad;
    const capped = (v) => clamp(v, -cap, cap);

    const overflowLeft = minLeft - (center - half);
    if (overflowLeft > 0) return capped(Math.round(overflowLeft));
    const overflowRight = (center + half) - maxRight;
    if (overflowRight > 0) return capped(-Math.round(overflowRight));
    return 0;
  }


  function choosePopupLayout({
    workArea,
    windowRect,
    petRect,
    popupHeight = 140,
  }) {
    const wa = normalizeRect(workArea);
    const wr = normalizeRect(windowRect);
    const pr = normalizeRect(petRect);
    const petTop = wr.y + pr.y;
    const above = Math.max(0, petTop - wa.y);
    const need = Math.max(80, Number(popupHeight) || 0);

    // 单一规则：只有桌宠本体上方放不下完整卡片时才向下翻；除此之外
    // 一律向上。不要把下方剩余空间、历史方向或当前透明窗口高度掺进来。
    const vertical = above < need ? 'below' : 'above';
    // 横向恒居中：钳的是猫本体，窗口原点允许悬出屏幕，所以无论帧宽涨到多少，
    // 猫都停在原地，不需要挑对齐方式。之前那个 popupHorizontal（解「哪种对齐能让
    // 窗口装进工作区而不挪动猫」）只在钳窗口的前提下才有意义，已随之退役。
    return { vertical, horizontal: 'center' };
  }

  function chooseDragVerticalLayout({
    current,
    workArea,
    targetWindowY,
    petScreenY,
    abovePetOffset,
    boundarySlack = 2,
  }) {
    const wa = normalizeRect(workArea);
    const vertical = current === 'below' ? 'below' : 'above';
    const edgeY = wa.y + Math.max(0, Number(boundarySlack) || 0);
    if (vertical === 'above') {
      return Number(targetWindowY) <= edgeY ? 'below' : 'above';
    }
    const normalWindowY = Number(petScreenY) - Math.max(0, Number(abovePetOffset) || 0);
    return normalWindowY >= edgeY ? 'above' : 'below';
  }

  const ARCS = {
    // A real 180-degree fan. The previous 156-degree arcs compressed eight
    // 46px controls until they overlapped into a heart-shaped cluster.
    above: { start: 180, end: 360 },
    below: { start: 0, end: 180 },
    right: { start: -90, end: 90 },
    left: { start: 90, end: 270 },
  };

  function arcPoints(direction, count, center, radius) {
    const arc = ARCS[direction];
    const points = [];
    for (let i = 0; i < count; i++) {
      const ratio = count === 1 ? 0.5 : i / (count - 1);
      const angle = (arc.start + (arc.end - arc.start) * ratio) * Math.PI / 180;
      points.push({
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      });
    }
    return points;
  }

  function radialLayout({ count, center, safeRect, preferred = [], radius = 106, itemRadius = 23, avoidRect = null, gap = 8 }) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return { direction: 'above', radius, points: [] };
    const safe = normalizeRect(safeRect);
    const avoid = normalizeRect(avoidRect);
    const avoidGap = Math.max(0, Number(gap) || 0);
    const directions = [...new Set([...preferred, 'above', 'below', 'right', 'left'])]
      .filter((direction) => ARCS[direction]);
    const radii = [...new Set([radius, 100, 94, 88, 80, 72].map((r) => Math.max(48, Number(r) || 0)))];
    let best = null;

    for (const direction of directions) {
      for (const candidateRadius of radii) {
        const adjustedCenter = { x: center.x, y: center.y };
        // Anchor the fan outside the pet body. The old layout rotated around
        // the cat's centre, so its end buttons could be clamped back onto the
        // cat at a screen corner.
        if (avoid.width > 0 && avoid.height > 0) {
          if (direction === 'above') adjustedCenter.y = Math.min(adjustedCenter.y, avoid.y - itemRadius - avoidGap);
          if (direction === 'below') adjustedCenter.y = Math.max(adjustedCenter.y, avoid.bottom + itemRadius + avoidGap);
          if (direction === 'left') adjustedCenter.x = Math.min(adjustedCenter.x, avoid.x - itemRadius - avoidGap);
          if (direction === 'right') adjustedCenter.x = Math.max(adjustedCenter.x, avoid.right + itemRadius + avoidGap);
        }
        // At a left/right edge a full semicircle needs its two end buttons to
        // fit vertically. Move only the fan's centre line, never the pet or
        // the fan's inward-facing x anchor.
        if (direction === 'left' || direction === 'right') {
          adjustedCenter.y = clamp(
            adjustedCenter.y,
            safe.y + itemRadius + candidateRadius,
            safe.bottom - itemRadius - candidateRadius,
          );
        }
        const raw = arcPoints(direction, n, adjustedCenter, candidateRadius);
        let overflow = 0;
        for (const point of raw) {
          overflow += Math.max(0, safe.x + itemRadius - point.x);
          overflow += Math.max(0, point.x - (safe.right - itemRadius));
          overflow += Math.max(0, safe.y + itemRadius - point.y);
          overflow += Math.max(0, point.y - (safe.bottom - itemRadius));
          if (avoid.width > 0 && avoid.height > 0
            && point.x >= avoid.x - itemRadius - avoidGap
            && point.x <= avoid.right + itemRadius + avoidGap
            && point.y >= avoid.y - itemRadius - avoidGap
            && point.y <= avoid.bottom + itemRadius + avoidGap) {
            overflow += 100000;
          }
        }
        const candidate = { direction, radius: candidateRadius, center: adjustedCenter, raw, overflow };
        if (!best || candidate.overflow < best.overflow) best = candidate;
        if (overflow === 0) {
          return { direction, radius: candidateRadius, center: adjustedCenter, points: raw };
        }
      }
    }

    const points = (best ? best.raw : []).map((point) => ({
      x: clamp(point.x, safe.x + itemRadius, safe.right - itemRadius),
      y: clamp(point.y, safe.y + itemRadius, safe.bottom - itemRadius),
    }));
    return {
      direction: best ? best.direction : directions[0],
      radius: best ? best.radius : radius,
      center: best ? best.center : center,
      points,
    };
  }

  // Compact L-shaped cluster of buttons in one diagonal quadrant around the
  // pet. Picks the quadrant with the most available room so the buttons sit
  // close to the pet without covering it or spilling off-screen.
  function cornerMenuLayout({ center, petRect, safeRect, itemRadius = 26, gap = 8, preferred = [] }) {
    const safe = normalizeRect(safeRect);
    const pet = normalizeRect(petRect);
    const cx = pet.x + pet.width / 2;
    const cy = pet.y + pet.height / 2;
    const halfW = pet.width / 2;
    const halfH = pet.height / 2;
    const offset = itemRadius * 0.85; // shift the two arm buttons toward the corner

    // Distance from each pet edge to the safe-rect boundary — the room
    // available for a button cluster on that side.
    const roomTop = Math.max(0, pet.y - safe.y);
    const roomBottom = Math.max(0, safe.bottom - pet.bottom);
    const roomLeft = Math.max(0, pet.x - safe.x);
    const roomRight = Math.max(0, safe.right - pet.right);

    const quadrants = [
      { dir: 'top-right',    sx:  1, sy: -1, score: roomTop * roomRight },
      { dir: 'top-left',     sx: -1, sy: -1, score: roomTop * roomLeft },
      { dir: 'bottom-right', sx:  1, sy:  1, score: roomBottom * roomRight },
      { dir: 'bottom-left',  sx: -1, sy:  1, score: roomBottom * roomLeft },
    ];

    // Honour an explicit preference (from edge layout) by boosting its score.
    const prefIndex = new Map(preferred.map((d, i) => [d, preferred.length - i]));
    const edgeBoost = (q) => {
      const vertKey = q.sy < 0 ? 'above' : 'below';
      const horzKey = q.sx > 0 ? 'right' : 'left';
      return (prefIndex.get(vertKey) || 0) * 1e6 + (prefIndex.get(horzKey) || 0) * 1e6;
    };
    quadrants.forEach((q) => { q.score += edgeBoost(q); });
    quadrants.sort((a, b) => b.score - a.score);
    const chosen = quadrants[0];

    const outerX = cx + chosen.sx * (halfW + itemRadius + gap);
    const outerY = cy + chosen.sy * (halfH + itemRadius + gap);

    // Three buttons form an L: top-arm, corner, side-arm.
    const raw = [
      { x: cx + chosen.sx * offset, y: outerY },
      { x: outerX, y: outerY },
      { x: outerX, y: cy + chosen.sy * offset },
    ];

    const points = raw.map((p) => ({
      x: clamp(p.x, safe.x + itemRadius, safe.right - itemRadius),
      y: clamp(p.y, safe.y + itemRadius, safe.bottom - itemRadius),
    }));

    return { direction: chosen.dir, points };
  }

  return { chooseRestingLayout, choosePopupLayout, chooseDragVerticalLayout, capsuleShift, radialLayout, cornerMenuLayout };
});
