#!/usr/bin/env python3
# 探针 #17：贴边开关弹窗时，猫身上的**装饰**会不会相对猫错位/抖动。
# 用户报的「气泡关闭时喵小范围左右抖动，只在左右贴边时出现」。
#
# ── 为什么 #16 测不到（靶打错了，不是坐标系错）──────────────────────────
# #16 量的是 #cat 的屏幕位置，结论是「一帧没抖」—— 那个结论**是对的**，
# 关窗时 DOM 改动 t=0、主进程 setBounds t=3~4ms，短于一帧(8.2ms)，没画出去过。
# 顺带自证 #15 的 window.screenX 也没骗人（screenXMismatchFrames: 0）。
# 真正的问题是：**抖的不是猫，是挂在猫身上但不在同一个容器里的东西**。
#   pet.html:71/82/83/141 —— #sleep / #prop / #sidekick / #notepad 是
#   #compact-row(:120) 的**兄弟**，直接挂在 #stage 下，position:absolute
#   的包含块是 #stage（pet.css #stage 有 position:relative）。
#   而猫在 #compact-row **里面**。H3 的 applyCatShift 挪的是 #compact-row。
#   → 贴边时猫走 catShift(30/50px)，这四个原地不动 → 错开 catShift。
# 定位方式决定谁会错位：
#   #cat      在 #compact-row 里          → 跟着走
#   #prop     JS 按猫 rect 算(:1980)      → 能跟上，但**只在被重算时**（:572/:2042/:3649）
#   #sleep    CSS left:52% 锚 #stage      → 不看猫，原地不动
#   #sidekick CSS left:50% 锚 #stage      → 同上
#   #notepad  CSS right:44px 锚 #stage    → 同上（也是用户之前问的那个图标）
# .prop 最可疑：身上挂 propSpin/propHunt/propJit 无限循环动画（pet.css:988-992），
# 一个正在转的东西突然横移 30~50px = 「小范围左右抖动」。
#
# ── 判据（量的是**相对偏移**，不是绝对位置）──────────────────────────────
#   对每个装饰 D，定义 rel(D) = D.centerX - cat.centerX（都取帧内坐标）
#   1. 静息 rel(D) 记为基线 rel0
#   2. 弹窗开着时 rel(D) 应仍等于 rel0 —— 不等就是**静态错位 CONFIRMED**，
#      偏移量应恰好等于 -catShift
#   3. 开/关窗全程 rAF 逐帧采 rel(D)，任一帧偏离 rel0 超 0.5px = **抖动 CONFIRMED**，
#      并记录抖了几帧、多大幅度（帧数 × 幅度决定用户能不能看见）
#   ★ 关键差别：不看猫的绝对位置（#16 已证明它不动），只看「装饰 vs 猫」。
#
# ── 靶位 ──────────────────────────────────────────────────────────────────
#   P  .peek 贴右缘（catShift 预期 +30）
#   A  .ask  贴右缘（+50）
#   M  .ask  贴左缘（-50）
#   C  .ask  居中对照（catShift 恒 0 → 预期零错位。用户说「只在贴边时出现」，
#            这一靶必须干净，否则说明另有原因）
# 每靶都把 #prop / #sleep / #sidekick 三个装饰强制点亮再测（不亮就没得量），
# #notepad 单独量（它的可见性由 actionable 驱动，这里只量 CSS 锚点的静态错位）。
#
# ⚠️ 只临时改写 main.js（探针入口 + 不隐藏 dock），**pet.js 零注入**（跑前自证）。
#    跑前 worktree 必须干净，跑完自动恢复。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeDecor.bak"

PROBE = r"""
// ==== PROBE_DECOR (临时) ====
function runProbeDecor() {
  const log = (o) => console.log('PROBE_DECOR ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const TH = 0.5;                // 抖动门槛 px（用户说「小范围」）
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

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

    // ── 产品符号门 + DOM 结构自证（错位的根因就是这个结构）──
    const pre = await js(`(() => { const r = {};
      r.popupShiftPlan = typeof popupShiftPlan === 'function';
      r.applyCatShift = typeof applyCatShift === 'function';
      try { r.appliedCatShift = appliedCatShift; } catch (e) { r.appliedCatShift = 'unreachable'; }
      const cr = document.querySelector('#compact-row');
      const st = document.querySelector('#stage');
      r.stagePosition = getComputedStyle(st).position;
      // 每个装饰的父节点 + 它的 offsetParent（= 真实包含块）
      r.nesting = {};
      for (const id of ['cat', 'prop', 'sleep', 'sidekick', 'notepad']) {
        const n = document.getElementById(id);
        if (!n) { r.nesting[id] = 'missing'; continue; }
        r.nesting[id] = { parent: n.parentElement && n.parentElement.id,
                          inCompactRow: !!(cr && cr.contains(n)),
                          offsetParent: n.offsetParent && (n.offsetParent.id || n.offsetParent.tagName),
                          position: getComputedStyle(n).position };
      }
      return r; })()`);
    log({ ev: 'pre', pre });
    const shipOK = pre && pre.popupShiftPlan && pre.applyCatShift && pre.appliedCatShift === 0;
    if (!shipOK) log({ FATAL: '产品符号门没过', pre });

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
            question: '贴边开关弹窗时,挂在 #stage 上的装饰会不会相对猫错位?这条问题要够长,好让 .ask 撑到 340px 上限。',
            options: [{ id: 'yes', label: '不错位' }, { id: 'no', label: '错位' }],
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
        const items = (lastStats && lastStats.sessions || []).map((x) => x.choice).filter(Boolean);
        if (!items.length) return 'no choice in lastStats';
        answered.clear(); askQueue = items; askIdx = 0; lastAskSig = '';
        showAskPanel(); return 'ok';
      } catch (e) { return 'forceShow threw: ' + String(e.stack || e); }
    })()`);

    // ★ 强制点亮三个装饰。走产品自己的路径（setProp 那一套由 tool act 驱动，
    //   这里直接加 class + 给 #prop 填内容并调 positionProp，与 :2042 同序）。
    const lightUp = () => js(`(() => {
      try {
        const p = document.getElementById('prop');
        const s = document.getElementById('sleep');
        const k = document.getElementById('sidekick');
        if (p) { positionProp(); p.textContent = '🔧'; p.className = 'prop'; void p.offsetWidth;
                 p.className = 'prop on spin'; }
        if (s) s.classList.add('on');
        if (k) { k.classList.remove('on'); void k.offsetWidth; k.classList.add('on'); }
        // 2026-09-20：#notepad 必须强点亮。它的可见性由 actionable 驱动（不是 .on），
        // 上一轮 P 靶就是因为没点亮而 display:none、量不到数（日志里那条
        // 「notepad: display:none」）。镜像换边的正靶就是它，不能再漏。
        const np = document.getElementById('notepad');
        if (np) { np.classList.remove('hidden'); np.style.display = 'flex'; }
        return { prop: p && p.className, sleep: s && s.className, sidekick: k && k.className,
                 notepad: np && (np.className + '|' + getComputedStyle(np).display) };
      } catch (e) { return 'lightUp threw: ' + String(e.stack || e); }
    })()`);
    const lightOff = () => js(`(() => {
      for (const id of ['prop', 'sleep', 'sidekick']) {
        const n = document.getElementById(id); if (n) n.classList.remove('on');
      } return 1; })()`);

    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset),
                      y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      // 2026-09-20：setBounds 只挪窗口，不会触发渲染端的 applyCapsuleShift（尺寸没变
      // → 无 resize 事件），而 --np-dir 正是在那条路上写的。所以这里显式驱动一次，
      // 否则 npDir 恒为 (unset) —— 和上一轮 stageClass 恒空串是同一个坑。
      // 传的是**猫的屏幕 x**（notepadSide 要的是屏幕坐标），与产品路径同一个入参口径。
      await js('(() => { try { applyCapsuleShift(' + Math.round(catScreenX) + ', 120); return 1; }'
             + '          catch (e) { return "threw: " + String(e); } })()');
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

    // ★ 核心量法：rel(D) = D.centerX - cat.centerX（帧内坐标，与帧位置无关）
    const DECOR = ['prop', 'sleep', 'sidekick', 'notepad'];
    const relSnap = () => js(`(() => {
      const cat = document.querySelector('#cat');
      if (!cat) return { err: 'no cat' };
      const c = cat.getBoundingClientRect();
      const catCx = c.left + c.width / 2;
      const out = { catCx: Math.round(catCx * 10) / 10, catL: Math.round(c.left * 10) / 10 };
      for (const id of ${JSON.stringify(DECOR)}) {
        const n = document.getElementById(id);
        if (!n) { out[id] = 'missing'; continue; }
        const cs = getComputedStyle(n);
        const r = n.getBoundingClientRect();
        out[id] = { rel: Math.round((r.left + r.width / 2 - catCx) * 10) / 10,
                    w: Math.round(r.width * 10) / 10,
                    lit: n.classList.contains('on') || !n.classList.contains('hidden'),
                    display: cs.display, vis: cs.visibility,
                    opacity: Math.round(parseFloat(cs.opacity) * 100) / 100 };
      }
      let ap; try { ap = appliedCatShift; } catch (e) { ap = 'unreachable'; }
      out.applied = ap;
      out.crLeft = getComputedStyle(document.querySelector('#compact-row')).left;
      // 2026-09-20 镜像换边：--np-dir 是判据本身，直接读出来，不靠 rel 反推。
      // catScreenCx 用来对账 notepadSide 的入参（猫中心的**屏幕**坐标，不是帧内坐标）。
      out.npDir = getComputedStyle(document.querySelector('#stage')).getPropertyValue('--np-dir').trim() || '(unset)';
      out.catScreenCx = Math.round((window.screenX + catCx) * 10) / 10;
      return out; })()`);

    // rAF 逐帧采 rel(D)（只采装饰相对猫的偏移，与帧位置、与猫的绝对位置都无关）
    const startWatch = () => js(`(() => {
      window.__dTrace = []; window.__dWatch = 1;
      const T0 = performance.timeOrigin;
      const ids = ${JSON.stringify(DECOR)};
      const tick = () => {
        if (!window.__dWatch) return;
        const cat = document.querySelector('#cat');
        if (cat) {
          const c = cat.getBoundingClientRect();
          const catCx = c.left + c.width / 2;
          const row = [T0 + performance.now()];
          for (const id of ids) {
            const n = document.getElementById(id);
            if (!n) { row.push(null); continue; }
            const r = n.getBoundingClientRect();
            // ★ 2026-09-19：除 rel 之外还要记「这一帧它到底可不可见」。
            // 不记的话 display:none 的元素 rect 全零、rel 退化成 -catCx，
            // 会跟着猫走 → 判据把「元素不可见」误报成「错位」（P 靶 notepad 全程
            // display:none 却报 41/67 帧偏离，就是这个假象）。opacity 同理：
            // sidekick/prop 的入场 keyframes 自带 translate，中途帧根本不该入样。
            const cs2 = getComputedStyle(n);
            row.push([Math.round((r.left + r.width / 2 - catCx) * 10) / 10,
                      Math.round(r.width * 10) / 10,
                      Math.round(parseFloat(cs2.opacity) * 100) / 100,
                      cs2.display]);
          }
          window.__dTrace.push(row);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 1; })()`);
    const stopWatch = () => js(`(() => { window.__dWatch = 0; return window.__dTrace || []; })()`);

    // 以 rel0 为基线，统计每个装饰偏离了几帧、多大
    const analyze = (trace, rel0, label) => {
      if (!Array.isArray(trace) || !trace.length) return { label, err: 'no frames' };
      const out = { label, frames: trace.length,
                    spanMs: Math.round(trace[trace.length - 1][0] - trace[0][0]), per: {} };
      DECOR.forEach((id, i) => {
        const b0 = rel0 && rel0[id];
        const base = b0 && typeof b0.rel === 'number' ? b0.rel : null;
        if (base === null) { out.per[id] = 'no baseline'; return; }
        // ★ 基线是在不可见态取的 → 它等于 -catCx（空 rect），拿它当基线只会量出
        // 「猫动了多少」，跟装饰无关。整条作废，而不是报一堆假偏离。
        if (b0.display === 'none' || b0.w === 0 || b0.opacity === 0) {
          out.per[id] = { baseline: base, badFrames: 0, maxDevPx: 0, samples: [],
                          skipped: 'baseline-invisible(' + b0.display + ',w=' + b0.w
                                   + ',op=' + b0.opacity + ')' };
          return;
        }
        let bad = 0, maxDev = 0, samples = [], skipped = 0;
        for (const row of trace) {
          const cell = row[i + 1];
          if (cell === null) continue;
          const v = Array.isArray(cell) ? cell[0] : cell;
          if (Array.isArray(cell)) {
            // 可见性门：这一帧它不可见 → 不入样（空 rect 的 rel 是假值）
            if (cell[3] === 'none' || cell[1] === 0 || cell[2] === 0) { skipped++; continue; }
          }
          const dev = Math.round((v - base) * 10) / 10;
          if (Math.abs(dev) > TH) {
            bad++;
            if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
            if (samples.length < 8) samples.push({ dtMs: Math.round(row[0] - trace[0][0]),
                                                   rel: v, dev });
          }
        }
        out.per[id] = { baseline: base, badFrames: bad, maxDevPx: maxDev, samples,
                        visFrames: trace.length - skipped, invisFrames: skipped };
      });
      return out;
    };

    // ── 正式测量 ──
    log({ ev: 'focus', gotFocus: await grabFocus() });
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(500);

    const RIGHT = wa.x + wa.width - 120;
    const LEFT = wa.x;
    const MID = wa.x + Math.round(wa.width / 2) - 60;
    const RESULTS = {};
    let uid = 0;

    const openAt = async (mode) => {
      const s = seed(mode, 's' + (++uid)); await sleep(350);
      if (mode === 'ask') { const r = await forceShow(); await sleep(700); return r; }
      await clickCat('left'); await sleep(700); return s;
    };

    const runTarget = async (id, mode, sel, catX, desc, predicted) => {
      await reset(); await lightOff(); await sleep(500);
      await placeCat(catX);
      // 点亮装饰 → 取**静息基线** rel0（此时 catShift 必须是 0）
      const lit = await lightUp();
      await sleep(500);
      const rel0 = await relSnap();

      // ── 开窗段 ──
      await startWatch();
      const seeded = await openAt(mode);
      const traceO = await stopWatch();
      const relOpen = await relSnap();                 // 弹窗开着时的静态错位
      const openA = analyze(traceO, rel0, id + '/open');

      // ── 关窗段 ──
      await startWatch();
      await reset();
      await sleep(900);
      const traceC = await stopWatch();
      const closeA = analyze(traceC, rel0, id + '/close');
      const relPost = await relSnap();

      await lightOff();
      RESULTS[id] = { desc, predicted, lit, seeded, rel0, relOpen, relPost, openA, closeA };
      log({ ev: 'target', id, desc, predicted, lit, rel0, relOpen, relPost,
            open: openA, close: closeA });
    };

    await runTarget('P', 'peek', '#peek', RIGHT, '.peek 贴右缘', 30);
    await runTarget('A', 'ask', '#ask', RIGHT, '.ask 贴右缘', 50);
    await runTarget('M', 'ask', '#ask', LEFT, '.ask 贴左缘（镜像）', -50);
    await runTarget('C', 'ask', '#ask', MID, '.ask 居中对照（catShift 应恒 0）', 0);

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const verdict = [];
    if (!shipOK) verdict.push('★ PRE: 产品符号门没过');
    // DOM 结构结论（根因自证）
    if (pre && pre.nesting) {
      const outside = DECOR.filter((d) => pre.nesting[d] && pre.nesting[d].inCompactRow === false);
      verdict.push('结构: 在 #compact-row **外面**的装饰 = ' + JSON.stringify(outside)
        + '（这些不会跟着 catShift 走）；#stage position=' + pre.stagePosition);
    }
    for (const id of ['P', 'A', 'M', 'C']) {
      const r = RESULTS[id];
      if (!r) { verdict.push(id + ': MISSING'); continue; }
      if (!r.rel0 || r.rel0.applied !== 0) {
        verdict.push(id + ': INVALID 基线时 catShift 非零 ' + JSON.stringify(r.rel0 && r.rel0.applied));
        continue;
      }
      if (r.relOpen && r.relOpen.applied !== r.predicted) {
        verdict.push(id + ': ⚠️ catShift 实测 ' + r.relOpen.applied + ' ≠ 预测 ' + r.predicted);
      }
      // 1) 静态错位：弹窗开着时 rel 变了多少（应恰好 = -catShift）
      for (const d of DECOR) {
        const a = r.rel0[d], b = r.relOpen && r.relOpen[d];
        if (!a || !b || typeof a.rel !== 'number' || typeof b.rel !== 'number') continue;
        // ★ 2026-09-19：同 analyze 里的可见性门。两个单点里只要有一端不可见，
        // 它的 rect 就是全零、rel 退化成 -catCx（跟着猫走），比出来的「错位」纯是假象
        // —— A 靶 notepad 的 -260 → 196.5（「偏 456px」）就是这么来的：-260 = -catCx。
        const invis = (x) => x.display === 'none' || x.w === 0 || x.opacity === 0;
        if (invis(a) || invis(b)) {
          verdict.push('· ' + id + ' #' + d + ' 静态比较跳过（有一端不可见：rel0 '
            + a.display + '/w' + a.w + '/op' + a.opacity + ' → open '
            + b.display + '/w' + b.w + '/op' + b.opacity + '）');
          continue;
        }
        const dev = Math.round((b.rel - a.rel) * 10) / 10;
        if (Math.abs(dev) > TH) {
          verdict.push('★★ ' + id + ' 静态错位 CONFIRMED #' + d + '：rel ' + a.rel + ' → '
            + b.rel + '（偏 ' + dev + 'px，catShift=' + r.relOpen.applied + '）');
        }
      }
      // 2) 动态抖动：开/关窗全程有几帧偏离基线
      for (const [seg, A] of [['开窗', r.openA], ['关窗', r.closeA]]) {
        if (!A || A.err) { verdict.push(id + '/' + seg + ': 无数据 ' + (A && A.err)); continue; }
        for (const d of DECOR) {
          const p = A.per[d];
          if (!p || typeof p === 'string') continue;
          if (p.badFrames > 0) {
            verdict.push('★★ ' + id + '/' + seg + ' 抖动 CONFIRMED #' + d + '：'
              + p.badFrames + '/' + A.frames + ' 帧偏离，最大 ' + p.maxDevPx + 'px');
          }
        }
      }
      // 3) 关窗后是否复位
      for (const d of DECOR) {
        const a = r.rel0[d], b = r.relPost && r.relPost[d];
        if (!a || !b || typeof a.rel !== 'number' || typeof b.rel !== 'number') continue;
        // 同上的可见性门：不可见那端的 rel 是 -catCx 假值，比不出复位与否。
        const invisP = (x) => x.display === 'none' || x.w === 0 || x.opacity === 0;
        if (invisP(a) || invisP(b)) {
          verdict.push('· ' + id + ' #' + d + ' 复位比较跳过（有一端不可见）');
          continue;
        }
        const dev = Math.round((b.rel - a.rel) * 10) / 10;
        if (Math.abs(dev) > TH) verdict.push('⚠️ ' + id + ' 关窗后 #' + d
          + ' 没复位：rel ' + a.rel + ' → ' + b.rel);
      }
    }
    const digest = (r) => r && { applied: r.relOpen && r.relOpen.applied,
      rel0: Object.fromEntries(DECOR.map((d) => [d, r.rel0[d] && r.rel0[d].rel])),
      relOpen: Object.fromEntries(DECOR.map((d) => [d, r.relOpen && r.relOpen[d] && r.relOpen[d].rel])),
      openBad: Object.fromEntries(DECOR.map((d) => [d, r.openA.per[d] && r.openA.per[d].badFrames])),
      closeBad: Object.fromEntries(DECOR.map((d) => [d, r.closeA.per[d] && r.closeA.per[d].badFrames])),
      closeMax: Object.fromEntries(DECOR.map((d) => [d, r.closeA.per[d] && r.closeA.per[d].maxDevPx])) };
    log({ ev: 'SUMMARY', S: { P: digest(RESULTS.P), A: digest(RESULTS.A),
                              M: digest(RESULTS.M), C: digest(RESULTS.C), VERDICT: verdict } });
    for (const id of ['P', 'A', 'M', 'C']) {
      const r = RESULTS[id]; if (!r) continue;
      log({ ev: 'detail', id, openPer: r.openA.per, closePer: r.closeA.per });
    }
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_DECOR ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_DECOR')) runProbeDecor();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_DECOR')) app.dock.hide(); } catch {}"


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
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过，这一轮测的就不是产品行为了")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_DECOR": "1", "HOME": "/tmp/wm-probe-home",
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
            if "PROBE_DECOR" in line:
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
