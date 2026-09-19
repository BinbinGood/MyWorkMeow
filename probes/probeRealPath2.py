#!/usr/bin/env python3
# 探针 #14b：修 #14 抓到的真缺陷 —— catShift 在关窗后没归零。
#
# ── #14 的结果与它抓到的缺陷 ──────────────────────────────────────────────
# #14 证明了修法主体成立（P/A 两靶）:
#   .peek 贴右: popShift -100→-74, catShift +30, 帧 1360→1330, 盒子 [1360,1680]→[1356,1676]
#               近侧墨迹 0→21.5, 远侧 21.5→21.5, 猫恒 1560, 出屏 0→0, 帧宽 520
#   .ask  贴右: popShift  -90→-64, catShift +50, 帧 1360→1310, 盒子 [1360,1700]→[1336,1676]
#               近侧墨迹 0→21,   远侧 21→21,     猫恒 1560, 出屏 **20→0**, 帧宽 520
#   ★ 并且 213 帧 rAF 采样 jumpCount 全 0 —— 我自己提的「两进程非原子提交会露一帧猫跳」
#     这条风险在**开窗**方向被证伪了。
#   ★ 不变性也实测到了:我静态按 SHADOW=24 算得盒子 [1336,1676]，探针实跑 SHADOW=26
#     （popShift 因此是 -64 而不是 -66），盒子**还是** [1336,1676]。阴影常数变了、
#     盒子屏幕坐标逐位不变 ⇒ .bubble/.think 的阴影确实不必再实测。
#
# 但 VERDICT 三靶全红，根子是**同一个**真缺陷（不是探针 bug）:
#   关窗后 #compact-row 的 left **停在 30px/50px/-50px 没归零**。
# 机制（算术已核）:
#   closePeek/hideAsk → resetPetSize() → fitRestingFrame(false)
#   → pet.js:911 `if (!force && |current-width|<=2 && |currentH-targetH|<=2) return;`
#   静息宽 = max(520, 133+24) = 520 = 弹窗宽；静息高 744 = 弹窗高
#   → 宽高都没变 → **早退，根本不调 setRequestedPetSize**
#   → anchoredLayoutPayload 不跑 → 归零的机会不存在。
#   ⚠️ 讽刺的是:正是「横向几何在两个状态下完全相同」这条让修法零成本的性质，
#     把**清理**也一并吞掉了。
#
# 残留为什么是真危害（不是洁癖）:
#   main.js:398  restoreWindowOrigin: const inset = (frameWidth - PET_BODY_W) / 2;  // 恒 200
#   main.js:1570 keepCatOnScreen:     const inset = (b.width - PET_BODY_W) / 2;     // 恒 200
#   这两处写死 200，不看锚点。残留 50px 时它们一旦触发，猫就会横跳 50px。
#   而且 persistPos 只在 popup 模式早退（main.js:534-538）—— 关窗后模式已不是 popup，
#   下一个 'moved' 会把偏了 50px 的帧原点**存盘**，下次启动猫就偏了。
#
# ── 修法补丁（本探针要验的增量）────────────────────────────────────────────
#   给去重加第三项:catShift 不为零时不许早退。
#     if (!force && |Δw|<=2 && |Δh|<=2 && appliedCatShift === 0) return;
#   然后 setRequestedPetSize → anchoredLayoutPayload → 静息布局 → plan 为 null
#   → 归零 → 猫 rect.left 回 200 → xOffset 回 0 → 帧原点回 catX-200（帧往外挪回 50）。
#   ★ 这一步又是一次两进程非原子提交，方向与开窗相反，**必须同样实测有没有露帧**。
#
# ── #14 的探针自身缺陷，本轮一并修 ────────────────────────────────────────
#   (1) 每靶开跑前**没有**断言干净态。结果 A 靶的残留 50px 污染了 M 靶的基线:
#       M 的 before 半猫在屏幕 50（不是 0），ideal 因此是 64 而不是 90，
#       基线自带 21 墨迹 → 「基线不成立」其实是上一靶漏出来的。
#       → 本轮每靶开跑前 assertClean()，不干净就直接标 INVALID，不许出数。
#   (2) M 那唯一 1 次 jump 是探针自己 placeCat 强行 setBounds 造成的
#       （帧 -150→-200 而 rectLeft 仍 200），不是产品路径。
#       → 本轮把 rAF 监控**只**套在「开窗」和「关窗」两段上，placeCat 排除在外。
#
# ── 靶位 ──────────────────────────────────────────────────────────────────
#   P  .peek 贴右缘   开窗 + **关窗**全程监控，关窗后 rest.left 必须为 0
#   A  .ask  贴右缘   同上（这个是圆弧被切的那个）
#   M  .ask  贴左缘   镜像；本轮基线必须干净（猫在屏幕 0）
#   R  静息态复查     全程不开弹窗，确认 catShift 恒 0、帧宽 520、猫不动
#
# ⚠️ 临时改写 main.js + renderer/pet.js，跑前 worktree 必须干净（跑完自动恢复两份）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
PET = os.path.join(REPO, "renderer", "pet.js")
BAK_MAIN = "/tmp/main.js.probeRealPath2.bak"
BAK_PET = "/tmp/pet.js.probeRealPath2.bak"

# ════════════════════════════════════════════════════════════════════════════
# 第一部分：打进 renderer/pet.js 的候选修法（#14 的三块 + 本轮新增的归零链）
# ════════════════════════════════════════════════════════════════════════════

FIX_HELPERS = r"""
// ==== PROBE_REALPATH2 候选修法（临时） ====
// 当前已落地的 catShift。fitRestingFrame 的去重要看它 —— 否则「宽高都没变」时
// 会早退，归零的机会根本不存在（探针 #14 实测到的缺陷）。
let PROBE_appliedCatShift = 0;

// 取当前可见弹窗里最宽的那个 —— 与 applyPopupShift 里的循环同源，必须同口径。
function PROBE_widestPopup() {
  let widest = 0;
  for (const el of [peekEl, askEl, bubble, thinkEl]) {
    if (!el || el.hidden || el.classList.contains('hidden')) continue;
    if (typeof el.getBoundingClientRect !== 'function') continue;
    const w = Number(el.getBoundingClientRect().width);
    if (Number.isFinite(w) && w > widest) widest = w;
  }
  return widest;
}
// SHADOW=26 是 pet.css 里所有弹窗 box-shadow 的最大 blur 半径，当保守上界用。
// 探针 #14 已实测:因为 popShift + catShift ≡ ideal，这个取值**不影响**盒子的屏幕
// 坐标（SHADOW 24 与 26 算出的盒子都是 [1336,1676]），只影响「帧内挪」与「帧移」
// 的分配比例 —— 所以不必逐弹窗实测阴影外扩量。
function PROBE_shiftPlan(petScreenX, petWidth, widest) {
  if (window.__PROBE_FIX_OFF) return null;          // null = 走修前的原逻辑
  if (!(widest > 0) || !window.PetGeometry) return null;
  const petCenterX = Number(petScreenX) + Number(petWidth) / 2;
  if (!Number.isFinite(petCenterX)) return null;
  const ideal = window.PetGeometry.capsuleShift({
    petCenterX, capsuleWidth: widest,
    workArea: browserWorkArea(), petWidth: Number(petWidth),
  });
  const SHADOW = 26;
  const tight = Math.max(0, (POPUP_W - widest) / 2 - SHADOW);
  const popShift = Math.max(-tight, Math.min(tight, ideal));
  return { ideal, tight, widest, popShift, catShift: Math.round(popShift - ideal) };
}
// 用 position:relative + left：不用 transform（会把祖先 scrollWidth 撑大、喂回帧宽），
// 也不用 margin（会挤压兄弟、推出布局宽度，2026-09-16 的教训）。
function PROBE_applyCatShift(px) {
  const cr = document.getElementById('compact-row');
  const v = Number(px) || 0;
  PROBE_appliedCatShift = v;
  if (!cr) return 0;
  cr.style.position = v ? 'relative' : '';
  cr.style.left = v ? (v + 'px') : '';
  return v;
}
// ==== /PROBE_REALPATH2 ====

"""

ANCHOR_FN = "function anchoredLayoutPayload(next) {"

ANCHOR_MEASURE = """  const rect = measureEdgeRect(next);
  const viewportW = Math.max(1, window.innerWidth || 320);"""

INJECT_MEASURE = """  // ==== PROBE_REALPATH2 落点（临时）====
  // 必须在这里：screenX 已由**旧** rect 定住（猫当前真实屏幕位置），而下面的
  // measureEdgeRect 取的是**新** rect（含本次偏移）。放到函数外面，Δ 会被算进
  // screenX，主进程就会真的把猫推走。
  const PROBE_plan = PROBE_shiftPlan(screenX, oldPet.width, PROBE_widestPopup());
  window.__probeLastPlan = PROBE_plan;
  PROBE_applyCatShift(PROBE_plan ? PROBE_plan.catShift : 0);
  // ==== /PROBE_REALPATH2 ====
""" + ANCHOR_MEASURE

ANCHOR_SHIFT = """    if (widest > 0) {
      shift = window.PetGeometry.capsuleShift({
        petCenterX,
        capsuleWidth: widest,
        workArea: wa,
        petWidth: Number(petWidth),
        frameWidth: POPUP_W,
      });
    }"""

INJECT_SHIFT = """    if (widest > 0) {
      // ==== PROBE_REALPATH2（临时）====
      const PROBE_p = PROBE_shiftPlan(petScreenX, petWidth, widest);
      if (PROBE_p) {
        shift = PROBE_p.popShift;
      } else
      // ==== /PROBE_REALPATH2 ====
      shift = window.PetGeometry.capsuleShift({
        petCenterX,
        capsuleWidth: widest,
        workArea: wa,
        petWidth: Number(petWidth),
        frameWidth: POPUP_W,
      });
    }"""

# ★ 本轮的增量：去重加第三项。#14 实测的缺陷就死在这一行。
ANCHOR_DEDUP = "    if (!force && Math.abs(current - width) <= 2 && Math.abs(currentH - targetH) <= 2) return;"
INJECT_DEDUP = """    // ==== PROBE_REALPATH2（临时）====
    // 第三项 PROBE_appliedCatShift：弹窗态给猫加过帧内偏移时，宽高即使都没变也
    // **不许**早退 —— 否则关窗后偏移永远归不了零（探针 #14 实测:残留 30/50/-50px）。
    // 残留的真危害:main.js:398/1570 两处 inset 写死 (width-120)/2=200、不看锚点，
    // 一旦触发猫就横跳；且 persistPos 只在 popup 模式早退，关窗后会把偏了的原点存盘。
    if (!force && Math.abs(current - width) <= 2 && Math.abs(currentH - targetH) <= 2
        && PROBE_appliedCatShift === 0) return;
    // ==== /PROBE_REALPATH2 ===="""

# ════════════════════════════════════════════════════════════════════════════
# 第二部分：打进 main.js 的测量探针
# ════════════════════════════════════════════════════════════════════════════

PROBE = r"""
// ==== PROBE_REALPATH2 (临时) ====
function runProbeRealPath2() {
  const log = (o) => console.log('PROBE_REALPATH2 ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // 探针 #10 踩过:4s 心跳(main.js setInterval(emitStats, 4000))会把假快照冲掉。
    try { clearInterval(statsTimer); statsTimer = null; log({ ev: 'killStatsTimer', ok: true }); }
    catch (e) { log({ ev: 'killStatsTimer', err: String(e) }); }

    await js(`(() => { window.__probeErrs = window.__probeErrs || [];
      if (!window.__probeHooked) { window.__probeHooked = 1;
        window.addEventListener('error', (e) => window.__probeErrs.push(
          String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
        window.addEventListener('unhandledrejection', (e) => window.__probeErrs.push(
          'reject: ' + String(e.reason && e.reason.stack || e.reason)));
      } return { hooked: 1 }; })()`);
    const errs = () => js('(window.__probeErrs || []).slice(-8)');

    const fixPresent = await js(`(() => ({
      helpers: typeof PROBE_shiftPlan === 'function'
               && typeof PROBE_applyCatShift === 'function',
    }))()`);
    log({ ev: 'fixPresent', fixPresent });

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    const setFix = (off) => js(`(() => { window.__PROBE_FIX_OFF = ${off ? 1 : 0};
      return { off: !!window.__PROBE_FIX_OFF }; })()`);

    const seed = (mode, uid) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return String(e); }
      const now = Date.now();
      const mk = (id, state, extra) => Object.assign({
        sessionId: id, agent: 'claude', project: 'WorkMeow', state,
        headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12,
      }, extra || {});
      if (mode === 'ask') {
        snap.sessions = [mk('ask-' + uid, 'waiting', {
          choice: {
            question: '走真实链路:帧内挪 + 帧移两个进程非原子提交,中间会不会有一帧猫跳?这条问题要够长,好让 .ask 撑到 340px 上限。',
            options: [
              { id: 'yes', label: '没有跳帧' },
              { id: 'no', label: '有跳帧' },
            ],
          },
        })];
        snap.workingCount = 0; snap.thinkingCount = 0; snap.waitingCount = 1; snap.needsinputCount = 1;
      } else {
        snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

    const forceShow = () => js(`(() => {
      try {
        const items = (lastStats && lastStats.sessions || [])
          .map((x) => x.choice).filter(Boolean);
        if (!items.length) return 'no choice in lastStats';
        answered.clear();
        askQueue = items; askIdx = 0; lastAskSig = '';
        showAskPanel();
        return 'ok';
      } catch (e) { return 'forceShow threw: ' + String(e.stack || e); }
    })()`);

    // 摆猫。**必须在 catShift 已归零时调用** —— 它按 inset=(width-120)/2 强行 setBounds，
    // 若此刻猫在帧内有偏移，就会造出一次探针自制的假跳变（#14 的 M 靶 1 次 jump 就是这个）。
    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset),
                      y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      return win.getBounds();
    };

    const cbox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`);
    const clickCat = async (button) => { const b = await cbox();
      if (!b || b.cx == null) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); return true; };
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){}
      try{hideAsk()}catch(e){} return 1; })()`);

    // 干净态快照:catShift / 帧宽 / 猫的屏幕 x。每靶开跑前必须先过这一关。
    const cleanState = async () => {
      const r = await js(`(() => { const cr = document.querySelector('#compact-row');
        const cs = getComputedStyle(cr);
        const c = document.querySelector('#cat').getBoundingClientRect();
        return { pos: cs.position, left: cs.left, rectLeft: Math.round(c.left * 10) / 10,
                 innerW: window.innerWidth,
                 applied: (typeof PROBE_appliedCatShift === 'number')
                            ? PROBE_appliedCatShift : 'n/a',
                 popShift: getComputedStyle(document.querySelector('#stage'))
                             .getPropertyValue('--pop-shift').trim() }; })()`);
      const fb = win.getBounds();
      const zero = r && (r.left === 'auto' || r.left === '0px') && r.applied === 0;
      return Object.assign({}, r, { frameX: fb.x, frameW: fb.width,
                                    catScreenL: r && r.rectLeft != null ? Math.round(r.rectLeft + fb.x) : null,
                                    zero: !!zero });
    };

    const boxOf = (sel) => js(`(() => { const n = document.querySelector('${sel}');
      if (!n) return 'missing';
      if (n.hidden || n.classList.contains('hidden')) return 'hidden';
      const r = n.getBoundingClientRect();
      const c = document.querySelector('#cat').getBoundingClientRect();
      const cr = document.querySelector('#compact-row');
      const crs = getComputedStyle(cr);
      return { L: Math.round(r.left * 10) / 10, R: Math.round(r.right * 10) / 10,
               T: Math.round(r.top * 10) / 10, B: Math.round(r.bottom * 10) / 10,
               w: Math.round(r.width * 10) / 10, innerW: window.innerWidth,
               catL: Math.round(c.left * 10) / 10, catR: Math.round(c.right * 10) / 10,
               crPos: crs.position, crLeft: crs.left, crScrollW: cr.scrollWidth,
               plan: window.__probeLastPlan || null,
               fixOff: !!window.__PROBE_FIX_OFF,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // ════════════════════════════════════════════════════════════════════
    // rAF 逐帧采样猫的**屏幕** x。采的是 window.screenX + rect.left ——
    // 只有这个和是「屏幕上那只猫」;单看任一项都会各自跳一下而互相抵消。
    // 本轮只套在「开窗」「关窗」两段上，placeCat 排除在外（#14 的假跳变教训）。
    // ════════════════════════════════════════════════════════════════════
    const startWatch = () => js(`(() => {
      window.__catTrace = []; window.__catWatch = 1;
      const tick = () => {
        if (!window.__catWatch) return;
        const c = document.querySelector('#cat');
        if (c) {
          const r = c.getBoundingClientRect();
          window.__catTrace.push([
            Math.round(performance.now()),
            Math.round((window.screenX + r.left) * 10) / 10,
            window.innerWidth, Math.round(window.screenX),
            Math.round(r.left * 10) / 10,
          ]);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 1;
    })()`);
    const stopWatch = () => js(`(() => {
      window.__catWatch = 0;
      const t = window.__catTrace || [];
      const jumps = [];
      for (let i = 1; i < t.length; i++) {
        const d = t[i][1] - t[i - 1][1];
        if (Math.abs(d) > 2) jumps.push({
          atMs: t[i][0], from: t[i - 1][1], to: t[i][1],
          delta: Math.round(d * 10) / 10,
          innerW: t[i][2], screenX: t[i][3], rectLeft: t[i][4],
        });
      }
      const xs = t.map((r) => r[1]);
      return { frames: t.length, jumpCount: jumps.length, jumps: jumps.slice(0, 12),
               minX: xs.length ? Math.min.apply(null, xs) : null,
               maxX: xs.length ? Math.max.apply(null, xs) : null,
               first: t[0] || null, last: t[t.length - 1] || null };
    })()`);

    // 像素量法 —— 逐字照抄探针 #11/#12/#13/#14 的 inkScan（历轮 alphaTrustworthy 全 true）
    const inkScan = async (box, label) => {
      if (typeof box !== 'object' || box === null) return { label, err: 'no box: ' + box };
      let img;
      try { img = await wc.capturePage(); } catch (e) { return { label, err: 'capture: ' + String(e) }; }
      const size = img.getSize();
      const bmp = img.getBitmap();
      const sf = Math.round((size.width / (await js('window.innerWidth'))) * 100) / 100;
      const W = size.width, H = size.height;
      const bytesPerRow = W * 4;
      const y = Math.round(((box.T + box.B) / 2) * sf);
      if (y < 0 || y >= H) return { label, err: 'scanline out of bitmap: y=' + y + ' H=' + H };
      const alphaAt = (x) => { if (x < 0 || x >= W) return -1; return bmp[y * bytesPerRow + x * 4 + 3]; };
      const TH = 3;
      const boxL = Math.round(box.L * sf), boxR = Math.round(box.R * sf);
      let leftInk = 0;
      for (let x = boxL - 1; x >= 0; x--) { if (alphaAt(x) > TH) leftInk++; else break; }
      let rightInk = 0;
      for (let x = boxR; x < W; x++) { if (alphaAt(x) > TH) rightInk++; else break; }
      const farCandL = Math.max(0, boxL - 120);
      const farCandR = Math.min(W - 1, boxR + 120);
      const farX = (boxL - farCandL) >= (farCandR - boxR) ? farCandL : farCandR;
      const farA = alphaAt(farX);
      return {
        label, sf, bitmap: { W, H }, scanY: y,
        boxL_css: box.L, boxR_css: box.R, innerW_css: box.innerW,
        insideLeftAlpha: alphaAt(boxL + 2), insideRightAlpha: alphaAt(boxR - 3),
        farX, farAlpha: farA, alphaTrustworthy: farA <= TH,
        leftInk_px: leftInk, rightInk_px: rightInk,
        leftInk_css: Math.round((leftInk / sf) * 10) / 10,
        rightInk_css: Math.round((rightInk / sf) * 10) / 10,
      };
    };

    const screenOf = (box, fb) => {
      if (typeof box !== 'object' || box === null) return { err: 'no box' };
      const waR = wa.x + wa.width;
      return {
        frameX: fb.x, frameW: fb.width,
        boxScreenL: Math.round(box.L + fb.x), boxScreenR: Math.round(box.R + fb.x),
        catScreenL: Math.round(box.catL + fb.x), catScreenR: Math.round(box.catR + fb.x),
        boxOffScreenRight: Math.max(0, Math.round(box.R + fb.x - waR)),
        boxOffScreenLeft: Math.max(0, Math.round(wa.x - (box.L + fb.x))),
        clipLeft: Math.max(0, Math.round(-box.L)),
        clipRight: Math.max(0, Math.round(box.R - box.innerW)),
        popShift: box.popShift, crPos: box.crPos, crLeft: box.crLeft,
        crScrollW: box.crScrollW, plan: box.plan, fixOff: box.fixOff, waRight: waR,
      };
    };

    // ── 正式测量 ──
    log({ ev: 'focus', gotFocus: await grabFocus() });

    await setFix(true);
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(500);
    log({ ev: 'warmup', done: true, clean: await cleanState() });

    const RIGHT = wa.x + wa.width - 120;
    const LEFT = wa.x;
    const RESULTS = {};
    let uid = 0;

    const openAt = async (mode) => {
      const s = seed(mode, 's' + (++uid)); await sleep(350);
      if (mode === 'ask') { const r = await forceShow(); await sleep(700); return r; }
      await clickCat('left'); await sleep(700); return s;
    };

    const runTarget = async (id, mode, sel, catX, desc) => {
      // ── 前置:必须从干净态出发（#14 的 M 靶就是被上一靶残留污染的）──
      await reset(); await sleep(600);
      const pre = await cleanState();
      await placeCat(catX);                      // 只在 catShift=0 时摆猫
      const pre2 = await cleanState();

      // ── A 半:修前 ──
      await setFix(true);
      const seedA = await openAt(mode);
      const boxA = await boxOf(sel);
      const fbA = win.getBounds();
      const inkA = await inkScan(boxA, id + '/before');
      const scrA = screenOf(boxA, fbA);
      await reset(); await sleep(600);

      // ── B 半:修后。开窗全程 rAF 监控 ──
      await setFix(false);
      await startWatch();
      const seedB = await openAt(mode);
      const boxB = await boxOf(sel);
      const fbB = win.getBounds();
      const inkB = await inkScan(boxB, id + '/after');
      const scrB = screenOf(boxB, fbB);
      const watchOpen = await stopWatch();
      const midCat = scrB.catScreenL;

      // ── C 半:★ 关窗。本轮的核心增量 —— 归零链 + 反方向的非原子提交 ──
      await startWatch();
      await reset();
      await sleep(900);                          // 留足 rAF + IPC + setBounds 的时间
      const watchClose = await stopWatch();
      const post = await cleanState();

      RESULTS[id] = { desc, pre, pre2, seedA, seedB, boxA, boxB, inkA, inkB,
                      scrA, scrB, watchOpen, watchClose, post, midCat };
      log({ ev: 'target', id, desc, pre, pre2,
            before: { box: boxA, ink: inkA, screen: scrA },
            after: { box: boxB, ink: inkB, screen: scrB },
            watchOpen, watchClose, post });
    };

    await runTarget('P', 'peek', '#peek', RIGHT, '.peek 贴右缘');
    await runTarget('A', 'ask', '#ask', RIGHT, '.ask 贴右缘（圆弧被切的那个）');
    await runTarget('M', 'ask', '#ask', LEFT, '.ask 贴左缘（镜像）');

    // ── 靶 R:静息态复查（全程不开弹窗）──
    {
      await reset(); await sleep(600);
      await placeCat(RIGHT);
      await setFix(false);
      await startWatch();
      // 静息路径走两遍:resetPetSize 与 settleEdgeLayout
      await js('(() => { try { resetPetSize(); } catch (e) { return String(e); } return 1; })()');
      await sleep(500);
      await js('(() => { try { settleEdgeLayout(); } catch (e) { return String(e); } return 1; })()');
      await sleep(500);
      const w = await stopWatch();
      RESULTS.R = { clean: await cleanState(), watch: w };
      log({ ev: 'target', id: 'R', desc: '静息态复查（不开弹窗）',
            clean: RESULTS.R.clean, watch: w });
    }

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const ib = (ink) => (!ink || ink.err) ? String(ink && ink.err || 'n/a')
      : { L: ink.leftInk_css, R: ink.rightInk_css, alphaOK: ink.alphaTrustworthy };
    const sb = (s) => (!s || s.err) ? String(s && s.err || 'n/a')
      : { box: [s.boxScreenL, s.boxScreenR], cat: [s.catScreenL, s.catScreenR],
          off: [s.boxOffScreenLeft, s.boxOffScreenRight], clip: [s.clipLeft, s.clipRight],
          frameX: s.frameX, frameW: s.frameW, popShift: s.popShift,
          crLeft: s.crLeft, crScrollW: s.crScrollW, plan: s.plan };

    const verdict = [];
    for (const id of ['P', 'A', 'M']) {
      const r = RESULTS[id];
      if (!r) { verdict.push(id + ': MISSING'); continue; }
      // ★ 前置门:不干净就不许出数（#14 的教训）
      if (!r.pre2 || !r.pre2.zero) {
        verdict.push(id + ': INVALID 开跑前 catShift 非零:' + JSON.stringify(r.pre2));
        continue;
      }
      const a = r.inkA, b = r.inkB, sa = r.scrA, sb2 = r.scrB;
      if (!a || a.err || !b || b.err) { verdict.push(id + ': INVALID 没量到墨迹'); continue; }
      if (!a.alphaTrustworthy || !b.alphaTrustworthy) { verdict.push(id + ': INVALID alpha 不可信'); continue; }
      if (!sb2.plan) { verdict.push(id + ': INVALID 修法没跑到(plan 为空)'); continue; }
      const nearIsLeft = id !== 'M';
      const nearA = nearIsLeft ? a.leftInk_css : a.rightInk_css;
      const nearB = nearIsLeft ? b.leftInk_css : b.rightInk_css;
      const farB = nearIsLeft ? b.rightInk_css : b.leftInk_css;
      const catMoved = Math.abs(sb2.catScreenL - sa.catScreenL);
      const offA = sa.boxOffScreenLeft + sa.boxOffScreenRight;
      const offB = sb2.boxOffScreenLeft + sb2.boxOffScreenRight;
      const bad = [];
      if (nearA >= 2) bad.push('基线不成立:修前近侧墨迹 ' + nearA + ' 不是 0');
      if (nearB < 8) bad.push('近侧阴影没回来(' + nearA + '→' + nearB + ')');
      if (farB < 8) bad.push('远侧阴影反而丢了(' + farB + ')');
      if (catMoved > 2) bad.push('★猫动了 ' + catMoved + 'px(' + sa.catScreenL + '→' + sb2.catScreenL + ')');
      if (offB > offA) bad.push('出屏变多了 ' + offA + '→' + offB);
      if (sb2.clipLeft > 1 || sb2.clipRight > 1) bad.push('仍被帧裁 ' + [sb2.clipLeft, sb2.clipRight]);
      if (Math.abs(sb2.frameW - 520) > 2) bad.push('★帧宽变了 ' + sb2.frameW);
      if (r.watchOpen && r.watchOpen.jumpCount > 0) bad.push('★★开窗有跳帧 '
        + r.watchOpen.jumpCount + ' 次:' + JSON.stringify(r.watchOpen.jumps.slice(0, 3)));
      // ★ 本轮增量的两条判据
      if (!r.post || !r.post.zero) bad.push('★关窗后 catShift 没归零:' + JSON.stringify(
        r.post && { left: r.post.left, applied: r.post.applied }));
      if (r.post && r.post.catScreenL != null && Math.abs(r.post.catScreenL - sa.catScreenL) > 2)
        bad.push('★关窗后猫偏了:' + sa.catScreenL + '→' + r.post.catScreenL);
      if (r.watchClose && r.watchClose.jumpCount > 0) bad.push('★★关窗有跳帧 '
        + r.watchClose.jumpCount + ' 次:' + JSON.stringify(r.watchClose.jumps.slice(0, 3)));
      verdict.push(bad.length
        ? id + ': FAILED —— ' + bad.join(' / ')
        : id + ': CONFIRMED 近侧 ' + nearA + '→' + nearB + '、远侧 ' + farB
          + '、出屏 ' + offA + '→' + offB + '、猫恒 ' + sa.catScreenL
          + '、帧宽 ' + sb2.frameW + '、开窗零跳帧(' + r.watchOpen.frames
          + ' 帧)、关窗零跳帧(' + r.watchClose.frames + ' 帧)且归零');
    }
    {
      const r = RESULTS.R;
      const bad = [];
      if (!r) bad.push('MISSING');
      else {
        if (!r.clean || !r.clean.zero) bad.push('静息态 catShift 非零:' + JSON.stringify(r.clean));
        if (r.clean && Math.abs(r.clean.frameW - 520) > 2) bad.push('帧宽 ' + r.clean.frameW);
        if (r.watch && r.watch.jumpCount > 0) bad.push('★静息路径把猫弄动了 '
          + JSON.stringify(r.watch.jumps.slice(0, 3)));
      }
      verdict.push(bad.length ? 'R: FAILED —— ' + bad.join(' / ')
        : 'R: CONFIRMED 静息态 catShift 恒 0、帧宽 ' + RESULTS.R.clean.frameW
          + '、猫不动(' + RESULTS.R.watch.frames + ' 帧零跳变)');
    }

    log({ SUMMARY: {
      P: RESULTS.P && { pre: RESULTS.P.pre2, before: { ink: ib(RESULTS.P.inkA), s: sb(RESULTS.P.scrA) },
                        after: { ink: ib(RESULTS.P.inkB), s: sb(RESULTS.P.scrB) },
                        watchOpen: RESULTS.P.watchOpen, watchClose: RESULTS.P.watchClose, post: RESULTS.P.post },
      A: RESULTS.A && { pre: RESULTS.A.pre2, before: { ink: ib(RESULTS.A.inkA), s: sb(RESULTS.A.scrA) },
                        after: { ink: ib(RESULTS.A.inkB), s: sb(RESULTS.A.scrB) },
                        watchOpen: RESULTS.A.watchOpen, watchClose: RESULTS.A.watchClose, post: RESULTS.A.post },
      M: RESULTS.M && { pre: RESULTS.M.pre2, before: { ink: ib(RESULTS.M.inkA), s: sb(RESULTS.M.scrA) },
                        after: { ink: ib(RESULTS.M.inkB), s: sb(RESULTS.M.scrB) },
                        watchOpen: RESULTS.M.watchOpen, watchClose: RESULTS.M.watchClose, post: RESULTS.M.post },
      R: RESULTS.R,
      VERDICT: verdict,
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_REALPATH2 ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_REALPATH2')) runProbeRealPath2();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_REALPATH2')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js + renderer/pet.js。先提交或 stash：")
        print(dirty)
        return 1

    msrc = open(MAIN, encoding="utf-8").read()
    psrc = open(PET, encoding="utf-8").read()
    for needle, where, src in ((TRIGGER, "main.js", msrc), (DOCK, "main.js", msrc),
                              (ANCHOR_FN, "pet.js", psrc),
                              (ANCHOR_MEASURE, "pet.js", psrc),
                              (ANCHOR_SHIFT, "pet.js", psrc),
                              (ANCHOR_DEDUP, "pet.js", psrc)):
        n = src.count(needle)
        if n != 1:
            print("ABORT: %s 里的锚点命中 %d 次（要求恰好 1 次）:\n%s" % (where, n, needle))
            return 1

    shutil.copy(MAIN, BAK_MAIN)
    shutil.copy(PET, BAK_PET)
    try:
        open(MAIN, "w", encoding="utf-8").write(
            msrc.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE)
        open(PET, "w", encoding="utf-8").write(
            psrc.replace(ANCHOR_FN, FIX_HELPERS + ANCHOR_FN)
                .replace(ANCHOR_MEASURE, INJECT_MEASURE)
                .replace(ANCHOR_SHIFT, INJECT_SHIFT)
                .replace(ANCHOR_DEDUP, INJECT_DEDUP))
        for f in (MAIN, PET):
            chk = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            if chk.returncode != 0:
                print("ABORT: patch 后语法错误 %s:\n%s" % (f, chk.stderr))
                return 1
        print("patched main.js + renderer/pet.js, node --check 双双通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_REALPATH2": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 300s")
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
            out = ""
        finally:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass

        for line in (out or "").splitlines():
            if "PROBE_REALPATH2" in line:
                print(line)
    finally:
        shutil.copy(BAK_MAIN, MAIN)
        shutil.copy(BAK_PET, PET)
        rc = 0
        for f in (MAIN, PET):
            rc |= subprocess.run(["node", "--check", f], capture_output=True, text=True).returncode
        print("restored main.js + renderer/pet.js, node --check rc=%d" % rc)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
