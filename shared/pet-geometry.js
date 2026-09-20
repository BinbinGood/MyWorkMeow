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

  // #notepad 的几何，与 renderer/pet.css 的 .notepad 一一对应，改一处必须改两处。
  // ICON_W/SHOULDER_GAP 复现初始提交（86f012f，帧宽 320）里 right:44 的相对位置：
  // 猫占 100..220、图标落 238..276，即肩外 18px。
  // ICON_BOX_W 是 rotate(-8deg) 后的外接盒：38·cos8° + 38·sin8° = 42.92，
  // probeDecor.py 实测 w:42.9 —— 判越界必须用它，用 38 会每侧漏算 2.5px。
  const NOTEPAD_ICON_W = 38;
  const NOTEPAD_SHOULDER_GAP = 18;
  const NOTEPAD_ICON_BOX_W = 42.92;

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
  // （留着只为不炸老调用方，值被忽略）。竖直的 threshold **仍然在用** —— 贴顶时气泡
  // 要往下让位，那是真实需求。
  //
  // 2026-09-17（E2）：inferVerticalFrameClamp 也退役了，同一个论证。它的语义是
  // 「透明窗口已经被钳在工作区上缘、而猫还困在窗口里」，而竖直方向的钳制此刻也换成
  // 了钳猫（main.js clampCatOriginY）：猫顶到工作区上缘就是窗口能上到的极限，
  // 「窗口被拦住而猫没到边」这个状态不再存在，无从推断也无需推断。入参留着只为不炸
  // 老调用方，值被忽略。**不要**把它改成某个恒 false 的表达式留在调用方 —— 上一次
  // 留下的死门（永真的 inferHorizontalFrameClamp）正是 E3/E4 没被拦住的直接原因。
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

    // 判据只有一条，而且只看**猫本体**：猫上方剩下的屏幕空间够不够放气泡。
    if (pet.y - wa.y <= threshold) vertical = 'below';

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
  //
  // 2026-09-18（H2）：上面那个上限只保证「不出**屏幕**」，从不管「不出**窗口帧**」——
  // 而真正在裁内容的是 renderer/pet.css:3-7 的 html,body{overflow:hidden}，它裁的是帧。
  // 传了 frameWidth 就再压一层「帧内每侧余量 (帧宽-被摆物宽)/2」：
  //   peek 320 在 520 帧里：余量 100 < 原上限 104 → 原来最多被帧裁 4px
  //   ask/bubble 340：      余量  90 < 原上限 114 → 原来最多被帧裁 24px
  // 被裁掉的恰好是位移**去向**那一侧，也就是**远离屏幕边缘**那一侧 —— 精确对上用户的
  // 「不是靠近屏幕边缘不完整，而是另一边」。
  //
  // 两个数都**真机实测过**，不是纯算术（probes/probeEdge.py 靶 A + probeAsk.py A/B）：
  //   peek 320 修前 catX=0    → popShift=104px  L=204 R=524  clipRight=4
  //   ask  340 修前 catX=0    → popShift=114px  L=204 R=544  clipRight=24   修后 90px / L=180 R=520 / 0
  //   ask  340 修前 catX=1560 → popShift=-114px L=-24 R=316  clipLeft =24   修后 -90px / L=0 R=340 / 0
  // A/B 的做法：在渲染端把 capsuleShift 包一层、剥掉 frameWidth 入参（等价修前），
  // 同一轮、同一位置、同一个弹窗，只差这一个参数。
  //
  // 默认 Infinity = 不压，所以这是**按调用点选择加入**的。⚠️ 2026-09-18（H3）之后
  // **产品代码里已经没有调用点传它了** —— 详见下面那段。留着这一层是因为
  // test/pet-geometry.js 全扫了它的算术，而且宽胶囊那笔欠账（见下）将来可能要用。
  //
  // 两层封顶叠加不破坏上面那条「不需要主进程回报通道」的自愈性质：出屏与贴边两种输入
  // 都饱和到**同一个**更小的上限，两者依然相等。
  //
  // ── 2026-09-18（H3）：H2 在这里传 POPUP_W 的那个调用点**已经撤了** ──────────
  // H2 当时在这段注释里写了两条结论，**都被用户的眼睛推翻了**，原文留在这里免得再犯：
  //   「代价是贴边时的 4px 屏幕留白在弹窗那一路必然丢掉…帧宽 520 + 弹窗宽 340 +
  //     猫可贴死屏幕缘，三者数学上不能同时满足」
  //   「这 20px 实测是出屏，不是帧裁…弹窗在自己那个 520 帧里内容完整，只是探到屏幕外，
  //     是任何窗口程序贴屏幕缘时的常规表现。所以不动 POPUP_W」
  // 错在哪：两条都默认了「帧原点只能是 猫x - 200」。**帧可以动**。用户随后报了
  //   「我看，这次确实没有气泡在边缘的裁切了，但是气泡周围本来是有阴影的吧？
  //     如果喵靠在右边，左边缘的阴影也没了」
  //   「贴边那一侧的圆弧都没了」
  // ——「出屏」和「被裁」在眼睛看来一模一样，圆弧就长在那 20px 里；而位移一顶到
  // (520-弹窗宽)/2，盒子就贴死帧墙，box-shadow 画在盒子**外面**，被 overflow:hidden
  // 整块吃掉。H2 钳错了矩形：钳的是盒子，该钳的是「盒子 + 阴影」。
  //
  // 现在的修法在 renderer/pet.js popupShiftPlan：**不传 frameWidth**，拿到完整的 ideal，
  // 再拆成 popShift（帧内，上限含阴影）+ catShift（溢出，给猫加帧内偏移，由主进程的
  // 帧移反向吸收）。实测（probes/probeRealPath2.py，四靶全绿）：近侧阴影 0→21/21.5px、
  // 远侧不减、.ask 出屏 20→0、猫屏幕 x 恒定、帧宽恒 520、开窗 200 帧 + 关窗 278 帧
  // 零跳变。**POPUP_W 一个字节没动** —— 它压根不是瓶颈。
  //
  // ⚠️ --chip-shift 那一路本来也不传，理由不同：胶囊的帧宽是 restingFrameWidth() 的
  // max(POPUP_W, 内容宽+24)（520..900），不是常量。宽胶囊理论上有同款帧裁隐患，
  // 单独记账 —— 那得先量过真机再动。
  // ⚠️ 签名必须留在**一行**：test/popup-style.js 用 /function capsuleShift\([\s\S]*?\n  \}/
  // 截函数体，多行签名里那个 `\n  })` 会把非贪婪匹配提前截断，函数体 pin 就空转变绿。
  function capsuleShift({ petCenterX, capsuleWidth, workArea, margin = 4, petWidth = PET_BODY_W, frameWidth = Infinity }) {
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
    let cap = Math.max(0, (width - body) / 2) + pad;
    // 帧内余量（见上方注释）。帧比被摆物还窄时余量为 0 → 不许位移，只能对称溢出。
    const frame = Number(frameWidth);
    if (Number.isFinite(frame)) cap = Math.min(cap, Math.max(0, (frame - width) / 2));
    // `|| 0` 是为了归一 -0：cap 现在可以恰好等于 0（帧不比弹窗宽），此时
    // clamp(负溢出, -0, 0) 会产出 -0。产品侧 String(-0) === '0' 所以无害，但漏出去会让
    // 调用方任何 Object.is / assert.strictEqual 比较莫名其妙（本行就是测试抓出来的）。
    const capped = (v) => clamp(v, -cap, cap) || 0;

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

  // 拖动途中的上/下让位判定。和 chooseRestingLayout 现在是**同一条规则**：只看猫本体
  // 顶端离工作区上缘还有多远，够不够放气泡（topRoom）。
  //
  // 2026-09-17（E2）之前这里收的是**帧** y（targetWindowY）和「猫在帧内的偏移」
  // （abovePetOffset），拿「帧顶撞到工作区上缘」当「猫上方没空间了」的代理。那个代理
  // 在帧高恒定（744）之后彻底失效：猫上方恒有 ~600px 透明留白且**合法**悬出屏幕上方，
  // `targetWindowY <= wa.y` 会恒真 —— 一拖动就永远判 below。
  // 顺带也解掉了旧实现里 above/below 两条分支不对称的麻烦：那时 below 布局下猫的帧内
  // 偏移不同，必须先探一次 above 布局才能拿到可比的数；现在判据是猫的**屏幕**坐标，
  // 而猫的屏幕坐标在布局翻转前后由锚点保持不变，两个方向天然同一个式子。
  function chooseDragVerticalLayout({
    workArea,
    petScreenY,
    topRoom = 168,
    boundarySlack = 2,
  }) {
    const wa = normalizeRect(workArea);
    const slack = Math.max(0, Number(boundarySlack) || 0);
    const room = Math.max(0, Number(topRoom) || 0);
    return (Number(petScreenY) - wa.y) <= room + slack ? 'below' : 'above';
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

  // 日记本图标（#notepad）挂猫的哪一侧肩膀：+1 = 右肩（默认），-1 = 左肩。
  //
  // 为什么需要换边，而不是像胶囊那样「往内挪一点」：图标挂在猫**肩外**，而钳猫
  // （main.js clampCatOrigin）让猫贴死屏幕缘时猫自己的那一侧缘**就是**屏幕缘 ——
  // 猫占 [1320,1440] 时右肩外的一切必然出屏，没有任何位移量能救。实测两种摆法：
  //   贴死左缘（猫 [0,120]）  挂右肩 [138.0,180.9] ✓   挂左肩 [-60.9,-18.0] 出屏左 61px
  //   贴死右缘（猫 [1320,1440]）挂右肩 [1458.0,1500.9] 出屏右 61px   挂左肩 [1259.1,1302.0] ✓
  // 即：换边是唯一能全在屏内的摆法，不是审美选择。
  //
  // ⚠️ 用图标的**外接盒** 42.9px 而不是 38px 判越界：图标带 transform:rotate(-8deg)，
  // 38·cos8° + 38·sin8° = 42.92（probeDecor.py 实测 w:42.9），按 38 算会漏 2.5px/侧。
  //
  // 为什么不复活 #stage.edge-left/.edge-right：那套是**整列**翻转（align-items 甩到
  // 窗口缘），为绕开旧的钳窗口死区而生，已于 2026-09-17 退役且被
  // test/popup-style.js 两条断言禁止回归（理由见本文件顶部那段长注释）。这里只换
  // **一个装饰**挂哪边，猫本体一动不动、不涉及帧移，和那套机制无关，也不吃 H3
  // 「帧内补偿必抖」的账（没有补偿，没有主进程反向帧移，单个属性值变化而已）。
  //
  // 滞回（hysteresis）是必需的，不是保险：dir 只**读**猫的位置、不反过来移动猫，
  // 所以静止时不会自激；但拖动途中指针在阈值上抖 ±1px，会让图标反复跳 2*97=194px。
  // 带内保持上一次的选择 → 越界才翻、回到带内不翻回。prev 缺省 +1（首次按默认右肩）。
  function notepadSide({ petCenterX, workArea, margin = 4, petWidth = PET_BODY_W,
    iconWidth = NOTEPAD_ICON_W, gap = NOTEPAD_SHOULDER_GAP,
    iconBoxWidth = NOTEPAD_ICON_BOX_W, hysteresis = 24, prev = 1 }) {
    const wa = normalizeRect(workArea);
    const center = Number(petCenterX);
    const last = Number(prev) < 0 ? -1 : 1;
    if (!Number.isFinite(center)) return last;
    const pad = Math.max(0, Number(margin) || 0);
    const body = Math.max(0, Number(petWidth) || 0);
    // 图标中心相对猫中心的距离，两侧对称（CSS 那边用的是同一个数）。
    const rel = body / 2 + Math.max(0, Number(gap) || 0) + Math.max(0, Number(iconWidth) || 0) / 2;
    const halfBox = Math.max(0, Number(iconBoxWidth) || 0) / 2;
    const slack = Math.max(0, Number(hysteresis) || 0);

    // 两侧都放不下（工作区窄到离谱）→ 保持上一次，别抖。
    if (rel + halfBox > (wa.width - 2 * pad) / 2) return last;

    const rightFits = (center + rel + halfBox) <= (wa.right - pad);
    const leftFits = (center - rel - halfBox) >= (wa.x + pad);
    // 只有一侧放得下：无条件用那侧，滞回不适用（越界比抖更糟）。
    if (rightFits && !leftFits) return 1;
    if (leftFits && !rightFits) return -1;
    if (!rightFits && !leftFits) return last;
    // 两侧都放得下 → 回默认右肩，但要越过滞回带才算「真的回来了」。
    if (last === -1 && (center + rel + halfBox) > (wa.right - pad - slack)) return -1;
    return 1;
  }

  return { chooseRestingLayout, choosePopupLayout, chooseDragVerticalLayout, capsuleShift, notepadSide, radialLayout, cornerMenuLayout };
});
