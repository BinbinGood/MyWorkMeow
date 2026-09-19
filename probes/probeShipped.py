#!/usr/bin/env python3
# 探针 #15：验**已落地的产品代码**（commit 2346b9a），不再注入任何候选修法。
#
# ── 为什么还要再跑一轮 ────────────────────────────────────────────────────
# #14b 的四靶全绿，但那是**注入版**：修法以 PROBE_shiftPlan / PROBE_applyCatShift /
# PROBE_appliedCatShift 的形式塞进 pet.js，三个落点都是 str.replace 打进去的。
# 产品代码落地时结构变了（popupShiftPlan / widestVisiblePopup / applyPopupShift /
# applyCatShift 四个函数 + 两个模块级声明 + fitRestingFrame 去重第三项），而且
# 落地过程里我自己还写错过一次不变式的符号（写成 popShift + catShift ≡ ideal，
# 实际是**减**，被 test/pet-edge-cycle.js 抓到）。注入版绿 ≠ 落地版绿。
#
# ── 和 #14b 的判据差别（重要，不是退化）──────────────────────────────────
# #14b 靠 window.__PROBE_FIX_OFF 在同一进程里切「修前/修后」，比的是**差值**。
# 产品代码里没有那个开关（也不该有），所以本轮改成**绝对判据**，并且比 #14b 更严：
#   1. 近侧墨迹 ≥8px          —— 贴边那一侧的阴影**在**（H3 的正题）
#   2. 远侧墨迹 ≥8px          —— 另一侧没被换走
#   3. ★ 盒子+阴影整体在帧内  —— [L-26, R+26] ⊂ [0, 520]。这条是 H3 的判定性回归：
#                                H2 恰恰是让 L 贴死 0，阴影和圆弧被 overflow:hidden 吃掉
#   4. 出屏 == 0、帧裁 == 0
#   5. ★ 猫的屏幕 x 在「静息 → 弹窗 → 关窗」三态**恒等**
#                                （比 #14b 的「修前 vs 修后」更强：那只比了两个弹窗态）
#   6. ★ 不变式 popShift - catShift ≡ ideal 在真机上现算现验
#                                （popShift 读 --pop-shift，catShift 读产品的
#                                 appliedCatShift，ideal 现场调 PetGeometry.capsuleShift）
#   7. 帧宽恒 520；开窗 / 关窗两段 rAF 零跳帧；关窗后 catShift 归零
# 「修前近侧墨迹是 0」那条基线不再复现（没有注入开关了），它由 #14b 存档:
#   P 0→21.5 / A 0→21 / M 0→21，.ask 出屏 20→0。
#
# ── 靶位（同 #14b）────────────────────────────────────────────────────────
#   P  .peek 贴右缘        A  .ask 贴右缘（圆弧被切的那个）
#   M  .ask  贴左缘（镜像） R  静息态复查（全程不开弹窗）
#
# ⚠️ 只临时改写 main.js（加探针入口 + 不隐藏 dock），**pet.js 一个字节不动**。
#    跑前 worktree 必须干净，跑完自动恢复。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeShipped.bak"

# ════════════════════════════════════════════════════════════════════════════
# 打进 main.js 的测量探针（渲染端零注入）
# ════════════════════════════════════════════════════════════════════════════

PROBE = r"""
// ==== PROBE_SHIPPED (临时) ====
function runProbeShipped() {
  const log = (o) => console.log('PROBE_SHIPPED ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const SHADOW = 26;            // 与 renderer/pet.js 的 POPUP_SHADOW_SPREAD 同值
  const POPW = 520;             // 与 renderer/pet.js 的 POPUP_W 同值
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

    // ★ 存在性门:查的是**产品**符号，不是探针注入的。pet.js 是普通 script，
    //   顶层 function 进全局对象、顶层 let 进全局声明式环境，两者都能按裸名引用。
    const fixPresent = await js(`(() => { const r = {};
      r.popupShiftPlan = typeof popupShiftPlan === 'function';
      r.applyCatShift = typeof applyCatShift === 'function';
      r.widestVisiblePopup = typeof widestVisiblePopup === 'function';
      try { r.POPUP_SHADOW_SPREAD = POPUP_SHADOW_SPREAD; } catch (e) { r.POPUP_SHADOW_SPREAD = 'unreachable'; }
      try { r.appliedCatShift = appliedCatShift; } catch (e) { r.appliedCatShift = 'unreachable'; }
      return r; })()`);
    log({ ev: 'fixPresent', fixPresent });
    const shipOK = fixPresent && fixPresent.popupShiftPlan && fixPresent.applyCatShift
      && fixPresent.widestVisiblePopup && fixPresent.POPUP_SHADOW_SPREAD === SHADOW
      && fixPresent.appliedCatShift === 0;
    if (!shipOK) { log({ FATAL: '产品符号不齐或 SHADOW 常数不一致，判据会失效', fixPresent }); }

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

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
    // ★ applied 读的是**产品**的 appliedCatShift（顶层 let，裸名可达）。
    const cleanState = async () => {
      const r = await js(`(() => { const cr = document.querySelector('#compact-row');
        const cs = getComputedStyle(cr);
        const c = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = 'unreachable'; }
        return { pos: cs.position, left: cs.left, rectLeft: Math.round(c.left * 10) / 10,
                 innerW: window.innerWidth, applied: ap,
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
      let ap; try { ap = appliedCatShift; } catch (e) { ap = 'unreachable'; }
      return { L: Math.round(r.left * 10) / 10, R: Math.round(r.right * 10) / 10,
               T: Math.round(r.top * 10) / 10, B: Math.round(r.bottom * 10) / 10,
               w: Math.round(r.width * 10) / 10, innerW: window.innerWidth,
               catL: Math.round(c.left * 10) / 10, catR: Math.round(c.right * 10) / 10,
               crPos: crs.position, crLeft: crs.left, crScrollW: cr.scrollWidth,
               applied: ap,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // ════════════════════════════════════════════════════════════════════
    // rAF 逐帧采样猫的**屏幕** x。采的是 window.screenX + rect.left ——
    // 只有这个和是「屏幕上那只猫」;单看任一项都会各自跳一下而互相抵消。
    // 只套在「开窗」「关窗」两段上，placeCat 排除在外（#14 的假跳变教训）。
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

    // 像素量法 —— 逐字照抄探针 #11..#14b 的 inkScan（历轮 alphaTrustworthy 全 true）
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
        // ★ 帧内「盒子 + 阴影」的两端。H3 的判定性判据就看这两个数在不在 [0,520]。
        shadowInFrameL: Math.round((box.L - SHADOW) * 10) / 10,
        shadowInFrameR: Math.round((box.R + SHADOW) * 10) / 10,
        popShift: box.popShift, applied: box.applied,
        crPos: box.crPos, crLeft: box.crLeft, crScrollW: box.crScrollW, waRight: waR,
      };
    };

    // ── 正式测量 ──
    log({ ev: 'focus', gotFocus: await grabFocus() });

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

      // ── 开窗:全程 rAF 监控 ──
      await startWatch();
      const seeded = await openAt(mode);
      const box = await boxOf(sel);
      const fb = win.getBounds();
      const ink = await inkScan(box, id + '/shipped');
      const scr = screenOf(box, fb);
      const watchOpen = await stopWatch();

      // ── ★ 不变式现算现验:ideal 用**猫的真实屏幕位置**现场算 ──
      const inv = await js(`(() => {
        try {
          const g = window.PetGeometry;
          if (!g) return { err: 'no PetGeometry' };
          const ideal = g.capsuleShift({
            petCenterX: ${scr.catScreenL} + 60,
            capsuleWidth: ${typeof box === 'object' && box ? box.w : 0},
            workArea: { x: ${wa.x}, y: ${wa.y}, width: ${wa.width}, height: ${wa.height} },
            petWidth: 120,
          });
          const popShift = parseFloat(getComputedStyle(document.querySelector('#stage'))
                             .getPropertyValue('--pop-shift')) || 0;
          let cs; try { cs = appliedCatShift; } catch (e) { cs = null; }
          return { ideal, popShift, catShift: cs,
                   residual: (cs == null) ? null : Math.round((popShift - cs - ideal) * 10) / 10 };
        } catch (e) { return { err: String(e) }; }
      })()`);

      // ── ★ 关窗:归零链 + 反方向的非原子提交 ──
      await startWatch();
      await reset();
      await sleep(900);                          // 留足 rAF + IPC + setBounds 的时间
      const watchClose = await stopWatch();
      const post = await cleanState();

      RESULTS[id] = { desc, pre, pre2, seeded, box, ink, scr, inv,
                      watchOpen, watchClose, post };
      log({ ev: 'target', id, desc, pre, pre2, box, ink, screen: scr, inv,
            watchOpen, watchClose, post });
    };

    await runTarget('P', 'peek', '#peek', RIGHT, '.peek 贴右缘');
    await runTarget('A', 'ask', '#ask', RIGHT, '.ask 贴右缘（圆弧被切的那个）');
    await runTarget('M', 'ask', '#ask', LEFT, '.ask 贴左缘（镜像）');

    // ── 靶 R:静息态复查（全程不开弹窗）──
    {
      await reset(); await sleep(600);
      await placeCat(RIGHT);
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
          shadowInFrame: [s.shadowInFrameL, s.shadowInFrameR],
          frameX: s.frameX, frameW: s.frameW, popShift: s.popShift, applied: s.applied,
          crLeft: s.crLeft, crScrollW: s.crScrollW };

    const verdict = [];
    if (!shipOK) verdict.push('★ PRE: 产品符号门没过:' + JSON.stringify(fixPresent));
    for (const id of ['P', 'A', 'M']) {
      const r = RESULTS[id];
      if (!r) { verdict.push(id + ': MISSING'); continue; }
      // ★ 前置门:不干净就不许出数（#14 的教训）
      if (!r.pre2 || !r.pre2.zero) {
        verdict.push(id + ': INVALID 开跑前 catShift 非零:' + JSON.stringify(r.pre2));
        continue;
      }
      const k = r.ink, s = r.scr;
      if (!k || k.err) { verdict.push(id + ': INVALID 没量到墨迹:' + (k && k.err)); continue; }
      if (!k.alphaTrustworthy) { verdict.push(id + ': INVALID alpha 不可信'); continue; }
      if (!s || s.err) { verdict.push(id + ': INVALID 没量到屏幕坐标'); continue; }
      const nearIsLeft = id !== 'M';
      const near = nearIsLeft ? k.leftInk_css : k.rightInk_css;
      const far = nearIsLeft ? k.rightInk_css : k.leftInk_css;
      const restCat = r.pre2.catScreenL;
      const off = s.boxOffScreenLeft + s.boxOffScreenRight;
      const bad = [];
      // 1/2 阴影两侧都在
      if (near < 8) bad.push('★近侧(贴边那侧)阴影不在:' + near + 'px');
      if (far < 8) bad.push('远侧阴影不在:' + far + 'px');
      // 3 ★ H3 的判定性判据:盒子+阴影整体在帧内
      if (s.shadowInFrameL < -0.5 || s.shadowInFrameR > POPW + 0.5)
        bad.push('★★盒子+阴影出帧:[' + s.shadowInFrameL + ',' + s.shadowInFrameR + '] ⊄ [0,' + POPW + ']');
      // 4 不出屏、不帧裁
      if (off !== 0) bad.push('出屏 ' + off + 'px');
      if (s.clipLeft > 1 || s.clipRight > 1) bad.push('仍被帧裁 ' + [s.clipLeft, s.clipRight]);
      // 5 ★ 猫三态恒等
      if (Math.abs(s.catScreenL - restCat) > 2)
        bad.push('★猫开窗时动了:静息 ' + restCat + ' → 弹窗 ' + s.catScreenL);
      if (r.post && r.post.catScreenL != null && Math.abs(r.post.catScreenL - restCat) > 2)
        bad.push('★猫关窗后偏了:静息 ' + restCat + ' → 关窗后 ' + r.post.catScreenL);
      // 6 ★ 不变式
      if (!r.inv || r.inv.err) bad.push('不变式没算成:' + JSON.stringify(r.inv));
      else if (r.inv.residual == null || Math.abs(r.inv.residual) > 0.5)
        bad.push('★★不变式破了 popShift(' + r.inv.popShift + ') - catShift('
          + r.inv.catShift + ') - ideal(' + r.inv.ideal + ') = ' + r.inv.residual);
      // 7 帧宽 / 跳帧 / 归零
      if (Math.abs(s.frameW - POPW) > 2) bad.push('★帧宽变了 ' + s.frameW);
      if (r.watchOpen && r.watchOpen.jumpCount > 0) bad.push('★★开窗有跳帧 '
        + r.watchOpen.jumpCount + ' 次:' + JSON.stringify(r.watchOpen.jumps.slice(0, 3)));
      if (r.watchClose && r.watchClose.jumpCount > 0) bad.push('★★关窗有跳帧 '
        + r.watchClose.jumpCount + ' 次:' + JSON.stringify(r.watchClose.jumps.slice(0, 3)));
      if (!r.post || !r.post.zero) bad.push('★关窗后 catShift 没归零:' + JSON.stringify(
        r.post && { left: r.post.left, applied: r.post.applied }));
      verdict.push(bad.length
        ? id + ': FAILED —— ' + bad.join(' / ')
        : id + ': CONFIRMED 近侧阴影 ' + near + 'px、远侧 ' + far
          + 'px、盒子+阴影帧内[' + s.shadowInFrameL + ',' + s.shadowInFrameR
          + ']、出屏 0、帧裁 0、猫三态恒 ' + restCat
          + '、不变式残差 ' + r.inv.residual
          + '（popShift ' + r.inv.popShift + ' - catShift ' + r.inv.catShift
          + ' = ideal ' + r.inv.ideal + '）、帧宽 ' + s.frameW
          + '、开窗零跳帧(' + r.watchOpen.frames + ' 帧)、关窗零跳帧('
          + r.watchClose.frames + ' 帧)且归零');
    }
    {
      const r = RESULTS.R;
      const bad = [];
      if (!r) bad.push('MISSING');
      else {
        if (!r.clean || !r.clean.zero) bad.push('静息态 catShift 非零:' + JSON.stringify(r.clean));
        if (r.clean && Math.abs(r.clean.frameW - POPW) > 2) bad.push('帧宽 ' + r.clean.frameW);
        if (r.watch && r.watch.jumpCount > 0) bad.push('★静息路径把猫弄动了 '
          + JSON.stringify(r.watch.jumps.slice(0, 3)));
      }
      verdict.push(bad.length ? 'R: FAILED —— ' + bad.join(' / ')
        : 'R: CONFIRMED 静息态 catShift 恒 0、帧宽 ' + RESULTS.R.clean.frameW
          + '、猫不动(' + RESULTS.R.watch.frames + ' 帧零跳变)');
    }

    log({ SUMMARY: {
      P: RESULTS.P && { pre: RESULTS.P.pre2, ink: ib(RESULTS.P.ink), s: sb(RESULTS.P.scr),
                        inv: RESULTS.P.inv, watchOpen: RESULTS.P.watchOpen,
                        watchClose: RESULTS.P.watchClose, post: RESULTS.P.post },
      A: RESULTS.A && { pre: RESULTS.A.pre2, ink: ib(RESULTS.A.ink), s: sb(RESULTS.A.scr),
                        inv: RESULTS.A.inv, watchOpen: RESULTS.A.watchOpen,
                        watchClose: RESULTS.A.watchClose, post: RESULTS.A.post },
      M: RESULTS.M && { pre: RESULTS.M.pre2, ink: ib(RESULTS.M.ink), s: sb(RESULTS.M.scr),
                        inv: RESULTS.M.inv, watchOpen: RESULTS.M.watchOpen,
                        watchClose: RESULTS.M.watchClose, post: RESULTS.M.post },
      R: RESULTS.R,
      VERDICT: verdict,
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_SHIPPED ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_SHIPPED')) runProbeShipped();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_SHIPPED')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js。先提交或 stash：")
        print(dirty)
        return 1

    msrc = open(MAIN, encoding="utf-8").read()
    for needle in (TRIGGER, DOCK):
        n = msrc.count(needle)
        if n != 1:
            print("ABORT: main.js 里的锚点命中 %d 次（要求恰好 1 次）:\n%s" % (n, needle))
            return 1

    shutil.copy(MAIN, BAK_MAIN)
    try:
        open(MAIN, "w", encoding="utf-8").write(
            msrc.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误 main.js:\n%s" % chk.stderr)
            return 1
        # ★ 渲染端零注入的自证:pet.js 必须和 HEAD 逐字节相同
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过，这一轮就不是「验落地版」了")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_SHIPPED": "1", "HOME": "/tmp/wm-probe-home",
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
            if "PROBE_SHIPPED" in line:
                print(line)
    finally:
        shutil.copy(BAK_MAIN, MAIN)
        rc = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True).returncode
        print("restored main.js, node --check rc=%d" % rc)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
