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
  // 横向**不用** threshold —— 这是 2026-09-16 那次回归的根：横向曾与竖直共用它，
  // 于是「距屏幕左/右缘 200 多像素」就算贴边，回中还要 2× ≈ 436px 的双侧余量，
  // 1440 宽的屏幕上猫待在右下角时永远处于贴边态，胶囊被甩到猫侧面。
  // 现在横向问的是**真贴边了吗**：猫本体离工作区左/右缘 ≤ edgeGap（默认 3px），
  // 或者透明窗口已被 applyPetSize 钳在工作区缘、而猫还困在窗口里面（inset > 18px）。
  // 后者是必须的：窗口 320 宽而猫只有 120 宽，左右各约 100px 透明留白，用户把猫
  // 拖到屏幕边时先撞边的是窗口，可见的猫还在里面 100px 处。
  //
  // 胶囊比猫宽，所以「猫贴死边」和「胶囊完整可读且严格居中」不可能同时成立。
  // 这里只管猫的贴边；胶囊的取舍交给下面的 capsuleShift（默认居中，只在会出屏时
  // 往内挪刚好够用的那点距离），两件事解耦。旧代码用同一个 align-items 同时干这
  // 两件事，才有了「贴边就整列甩过去」的观感。
  //
  // 不收 current：方向每次都由当前几何重新判定。"below" 只是贴顶时的临时让位，
  // 不能作为粘性历史状态；横向同理，留着这个参数只会让调用方以为历史方向有投票权。
  function chooseRestingLayout({
    workArea,
    windowRect,
    petRect,
    threshold = 168,
    edgeGap = 3,
    inferVerticalFrameClamp = true,
    inferHorizontalFrameClamp = true,
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
    const gap = Math.max(0, Number(edgeGap) || 0);

    // "below" is exclusively a top-edge accommodation. Do not keep it as a
    // sticky historical state after the pet has returned to the desktop: all
    // bubbles/status chips belong above the pet everywhere else.
    let vertical = 'above';

    // The second half of the test catches the old failure mode: the transparent
    // window has already been clamped to the work-area edge, while the visible
    // pet is still stranded well inside that window.
    if (pet.y - wa.y <= threshold
      || (inferVerticalFrameClamp && wr.y <= wa.y + 3 && pr.y > 18)) vertical = 'below';

    // 横向：只有真贴边才算贴边。没有「回中要 2× 余量」的滞回 —— 判据两侧对称，
    // 离开边缘的那一帧自然回到 center，不需要额外的宽容带。
    let horizontal = 'center';
    if (pet.x - wa.x <= gap
      || (inferHorizontalFrameClamp && wr.x <= wa.x + 3 && pr.x > 18)) horizontal = 'left';
    else if (wa.right - pet.right <= gap
      || (inferHorizontalFrameClamp && wr.right >= wa.right - 3 && wr.width - pr.right > 18)) horizontal = 'right';

    return { vertical, horizontal };
  }

  // 胶囊（底部展示栏）需要的水平位移，单位 px，正数向右。
  //
  // 用户定的口径是「按需最小位移」：默认严格居中在猫正下方，一动不动；只有居中
  // 会让胶囊探出工作区时，才往内挪**刚好不出屏**的那点距离。窄胶囊在任何位置都
  // 返回 0；宽胶囊只在贴边时才有非零位移，且位移量随胶囊宽度增长而非随位置跳变。
  //
  // 两侧同时挤不下（胶囊比整个工作区还宽）时返回居中偏移，宁可两边对称溢出，
  // 也不要单侧甩出去 —— 那种情况下无论怎么挪都会被裁，对称至少还能读中间。
  function capsuleShift({ petCenterX, capsuleWidth, workArea, margin = 4 }) {
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

    const overflowLeft = minLeft - (center - half);
    if (overflowLeft > 0) return Math.round(overflowLeft);
    const overflowRight = (center + half) - maxRight;
    if (overflowRight > 0) return -Math.round(overflowRight);
    return 0;
  }

  // 弹窗路径的横向对齐：挑一个能让猫**停在当前这个屏幕像素上**的对齐方式。
  //
  // 问的不是「猫贴边了吗」（那是 chooseRestingLayout 的问题），而是「窗口要涨到
  // popupWidth 这么宽，哪种对齐能让它既装进工作区、又不必挪动猫」。原因：猫的屏幕
  // 位置 = 窗口原点 + 窗内偏移，而窗内偏移完全由对齐方式决定（left→0，center→
  // (帧宽-猫宽)/2，right→帧宽-猫宽）。主进程 applyPetSize 会把**窗口**钳进工作区，
  // 所以只有当「猫位置 − 窗内偏移」这个窗口原点本来就在工作区内时，猫才不会被挪。
  // 把这个条件解成窗内偏移的可行区间 [lo, hi]，再按偏好挑第一个落在区间里的。
  //
  // 偏好顺序 center → left → right 不是随手排的：center 必须在最前，否则屏幕中间
  // 的猫会在 center/left 之间摆动（实测猫x=200/201 处来回跳）。
  //
  // 不借道 chooseRestingLayout。2026-09-16 之前那版借了（只为拿 horizontal），
  // 于是「猫是否贴边」和「弹窗放得下吗」两个不同的问题共用一个答案，实测两种改法
  // 都会漏：直接沿用静息方向时屏幕中间的猫净漂 ±200px。
  function popupHorizontal({ workArea, popupWidth, petScreenX, petWidth }) {
    const wa = normalizeRect(workArea);
    const width = Number(popupWidth) || 0;
    const petW = Number(petWidth) || 0;
    const petX = Number(petScreenX);
    // 拿不到弹窗宽度（早期调用/测试）时不做判断，保持居中。
    if (!(width > 0) || !Number.isFinite(petX)) return 'center';
    const lo = petX - (wa.right - width);
    const hi = petX - wa.x;
    // 弹窗比工作区还宽：怎么放都会被钳，对称溢出。
    if (lo > hi) return 'center';
    const offsets = {
      center: (width - petW) / 2,
      left: 0,
      right: width - petW,
    };
    for (const key of ['center', 'left', 'right']) {
      if (offsets[key] >= lo && offsets[key] <= hi) return key;
    }
    return 'center';
  }

  function choosePopupLayout({
    workArea,
    windowRect,
    petRect,
    popupHeight = 140,
    popupWidth = 0,
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
    const horizontal = popupHorizontal({
      workArea,
      popupWidth,
      petScreenX: wr.x + pr.x,
      petWidth: pr.width,
    });
    return { vertical, horizontal };
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
