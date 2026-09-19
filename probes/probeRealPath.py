#!/usr/bin/env python3
# 探针 #14：H3 + 贴边侧圆弧被切 —— 把候选修法**真的打进 renderer/pet.js**，走真实用户路径实测。
#
# 与探针 #13 的根本区别（这也是本探针存在的唯一理由）:
#   #13 自己调 win.setBounds() 伪造帧移,证明了「几何上可行」,但**绕开了产品链路**,
#   所以它测不到我 2026-09-18 晚自己提出的那条新风险:
#     「猫在帧内右移 S 与主进程把帧左移 S 是**两个进程、无法原子提交**,
#       中间可能有 1 帧猫跳 S 个像素。这条必须实测,不能推理。」
#   本探针把修法打进渲染端,由 fitPopup → setRequestedPetSize → anchoredLayoutPayload
#   → IPC → 主进程 applyPetSize 的**真实链路**驱动,并用 rAF 逐帧采样猫的屏幕 x
#   来抓那一帧跳动。
#
# ── 修法（即本探针要验的东西） ─────────────────────────────────────────────
# 分解（改进自 #13 的 `S = ceil(阴影)+1+出屏量`,那个公式把 H2 丢掉的 4px 屏幕留白
# 静悄悄地继续丢着）:
#     tight    = max(0, (POPUP_W − W)/2 − SHADOW)   // 帧内上限,给阴影留地
#     ideal    = capsuleShift(**不传** frameWidth)   // 「刚好不出屏 + 4px 留白」
#     popShift = clamp(ideal, ±tight)                // 帧内能挪多少就挪多少
#     catShift = popShift − ideal                    // 差额,由帧移吸收
#
# ★ 关键恒等式:popShift + catShift ≡ ideal。
#   ⇒ 盒子最终的**屏幕**坐标与 SHADOW 取值**无关**,SHADOW 只决定这段总位移里
#     「帧内挪」与「帧移」的分配比例。所以不必逐弹窗实测阴影外扩量
#     (.bubble/.think 至今未测),取 CSS 里最大的 blur 半径 26 当保守上界即可。
#   已用算术核对:SHADOW=26(blur) 与 SHADOW=21(实测) 算出的 .ask 盒子屏幕坐标
#   都是 [1336,1676],逐位相同。
#
# catShift 怎么让帧跟着动(**不需要改主进程一行**):
#   #compact-row 加 position:relative; left:catShift
#     → 猫的 rect.left 从 200 变 200+catShift
#     → anchoredLayoutPayload 的 xOffset 从 0 变 catShift
#     → 主进程 anchoredPetOrigin 反解 localX = 520/2 + catShift − 120/2 = 200+catShift
#     → 窗口原点 = 猫屏幕x − (200+catShift)   ← 帧自动往内挪 catShift
#     → main.js:333 `const inset = anchored ? anchor.screenX - anchored.x : …`
#       把 inset 也反解成 200+catShift → clampCatOrigin 钳的仍是**猫本体**
#     → 猫停在同一个屏幕像素上。
#   ⚠️ #13 的注释说「不能调 applyPetSize,它会按 inset=200 反解把帧移撤掉」——
#     那说的是它自己用的**无锚点**分支 applyPetSize(st, null)。真实链路带活锚点,
#     走的是 `anchor.screenX - anchored.x` 那一支,帧移自持。这条是本探针的核心验点。
#
# 落点必须在 anchoredLayoutPayload **函数体内**、petGeometrySnapshot() 之后、
# measureEdgeRect() 之前:
#   screenX 取自**旧** rect(猫当前真实屏幕位置),rect 取自**新** rect(含偏移)。
#   放到函数外面 → Δ 会被算进 screenX,主进程就会真的把猫推走。
#
# ── 三个靶 ────────────────────────────────────────────────────────────────
# 每个靶都是**同一轮、同一位置、同一个弹窗**的 A/B,只差 window.__PROBE_FIX_OFF 一个开关
# (照抄探针 #10 给 H2 做 A/B 的手法),这样排除「换了位置/换了弹窗」的混淆。
#   P  .peek 贴右缘   预期 修前 左墨迹 0 → 修后 ≈21.5;出屏 0→0;圆弧本来就没被切
#   A  .ask  贴右缘   预期 修前 左墨迹 0 → 修后 ≈21  ;出屏 **20→0** ← 圆弧回来
#   M  .ask  贴左缘   预期 修前 右墨迹 0 → 修后 ≈21  ;出屏 0→0      ← 镜像自洽
#
# ── 三条对照(缺一不可) ────────────────────────────────────────────────────
#   阴性对照:猫的屏幕 x 在 A/B 两侧必须**完全一致**(这是整个修法的立身之本)
#   阴性对照:帧宽必须恒 520(若变了说明位移喂回了 measuredRestingWidth)
#   ★ 新风险:rAF 逐帧采样猫的屏幕 x,整个开窗过程**不许**出现 >2px 的相邻帧跳变
#
# ⚠️ 本探针临时改写 main.js **与 renderer/pet.js 两个文件**,跑之前 worktree 必须干净
#   (跑完自动恢复两份 + node --check 两份)。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
PET = os.path.join(REPO, "renderer", "pet.js")
BAK_MAIN = "/tmp/main.js.probeRealPath.bak"
BAK_PET = "/tmp/pet.js.probeRealPath.bak"

# ════════════════════════════════════════════════════════════════════════════
# 第一部分：打进 renderer/pet.js 的候选修法
# ════════════════════════════════════════════════════════════════════════════

FIX_HELPERS = r"""
// ==== PROBE_REALPATH 候选修法（临时） ====
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
// 因为 popShift + catShift ≡ ideal，这个取值不影响盒子的屏幕坐标，只影响
// 「帧内挪」与「帧移」的分配比例 —— 所以不必逐弹窗实测阴影外扩量。
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
  if (!cr) return 0;
  const v = Number(px) || 0;
  cr.style.position = v ? 'relative' : '';
  cr.style.left = v ? (v + 'px') : '';
  return v;
}
// ==== /PROBE_REALPATH ====

"""

ANCHOR_FN = "function anchoredLayoutPayload(next) {"

ANCHOR_MEASURE = """  const rect = measureEdgeRect(next);
  const viewportW = Math.max(1, window.innerWidth || 320);"""

INJECT_MEASURE = """  // ==== PROBE_REALPATH 落点（临时）====
  // 必须在这里：screenX 已由**旧** rect 定住（猫当前真实屏幕位置），而下面的
  // measureEdgeRect 取的是**新** rect（含本次偏移）。放到函数外面，Δ 会被算进
  // screenX，主进程就会真的把猫推走。
  const PROBE_plan = PROBE_shiftPlan(screenX, oldPet.width, PROBE_widestPopup());
  window.__probeLastPlan = PROBE_plan;
  PROBE_applyCatShift(PROBE_plan ? PROBE_plan.catShift : 0);
  // ==== /PROBE_REALPATH ====
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
      // ==== PROBE_REALPATH（临时）====
      const PROBE_p = PROBE_shiftPlan(petScreenX, petWidth, widest);
      if (PROBE_p) {
        shift = PROBE_p.popShift;
      } else
      // ==== /PROBE_REALPATH ====
      shift = window.PetGeometry.capsuleShift({
        petCenterX,
        capsuleWidth: widest,
        workArea: wa,
        petWidth: Number(petWidth),
        frameWidth: POPUP_W,
      });
    }"""

# ════════════════════════════════════════════════════════════════════════════
# 第二部分：打进 main.js 的测量探针
# ════════════════════════════════════════════════════════════════════════════

PROBE = r"""
// ==== PROBE_REALPATH (临时) ====
function runProbeRealPath() {
  const log = (o) => console.log('PROBE_REALPATH ' + JSON.stringify(o));
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

    // 自查:修法三块是否真的打进了渲染端。没打进就整组作废(区别于「修法无效」)。
    const fixPresent = await js(`(() => ({
      helpers: typeof PROBE_shiftPlan === 'function'
               && typeof PROBE_applyCatShift === 'function',
      planSeen: 'pending',
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

    // seed:照抄探针 #11/#13(每轮换新 sessionId —— 重灌同一个 id 的 choice 不再弹)
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

    // 探针 #11 的绕过办法:refreshAsk 的真门至今没找到,forceShow 直接手搭队列。
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

    // 摆猫。此刻没有弹窗 → catShift 恒 0 → 无锚点的 applyPetSize(inset=200) 与修法一致。
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

    // 盒子矩形 + 猫矩形 + compact-row 的 computed 一起取 —— 猫的位置是阴性对照,必须同帧读
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
               crPos: crs.position, crLeft: crs.left,
               crScrollW: cr.scrollWidth,
               plan: window.__probeLastPlan || null,
               fixOff: !!window.__PROBE_FIX_OFF,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // ════════════════════════════════════════════════════════════════════
    // ★ 新风险的量具:rAF 逐帧采样猫的**屏幕** x。
    // 帧移(主进程 setBounds)与猫在帧内偏移(渲染端 style)是两个进程,无法原子提交。
    // 若中间露出一帧,这里必然抓到一次 >2px 的相邻帧跳变。
    // 注意采的是 window.screenX + rect.left —— 只有这个和是「屏幕上那只猫」,
    // 单看 rect.left 或单看 screenX 都会各自跳一下而互相抵消,量不到真相。
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

    // ════════════════════════════════════════════════════════════════════
    // 像素量法 —— 逐字照抄探针 #11/#12/#13 的 inkScan(历轮都 alphaTrustworthy:true)
    // ⚠️ rect 量不到 box-shadow,只有像素能。sf=2 时 bitmap 是**物理像素**。
    // ════════════════════════════════════════════════════════════════════
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
      const alphaAt = (x) => {
        if (x < 0 || x >= W) return -1;
        return bmp[y * bytesPerRow + x * 4 + 3];
      };
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

    // 帧内坐标 → 屏幕坐标。出屏量 / 猫位置 / 帧裁都在这一层判。
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
        crScrollW: box.crScrollW, plan: box.plan, fixOff: box.fixOff,
        waRight: waR,
      };
    };

    // ── 正式测量 ──
    const got = await grabFocus();
    log({ ev: 'focus', gotFocus: got });

    // README 记着的坑:第一轮状态可能反相,先预热一轮。
    await setFix(true);
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(300);
    log({ ev: 'warmup', done: true });

    const RIGHT = wa.x + wa.width - 120;   // 猫贴右缘
    const LEFT = wa.x;                     // 猫贴左缘
    const RESULTS = {};
    let uid = 0;

    // 打开弹窗,走**真实链路**。peek 走真点击;ask 走 forceShow(#ask 的真门未找到)。
    const openAt = async (mode, catX) => {
      await reset(); await sleep(250);
      const s = seed(mode, 's' + (++uid)); await sleep(350);
      await placeCat(catX);
      if (mode === 'ask') { const r = await forceShow(); await sleep(700); return r; }
      await clickCat('left'); await sleep(700); return s;
    };

    // 一个靶 = 同一位置、同一弹窗、修前/修后 A/B。修后那一半带 rAF 跳帧监控。
    const runTarget = async (id, mode, sel, catX, desc) => {
      // ── A 半:修前 ──
      await setFix(true);
      const seedA = await openAt(mode, catX);
      const boxA = await boxOf(sel);
      const fbA = win.getBounds();
      const inkA = await inkScan(boxA, id + '/before');
      const scrA = screenOf(boxA, fbA);

      // ── B 半:修后。先装 rAF 监控,再开窗,让整个开窗过程都在监控里。 ──
      await reset(); await sleep(250);
      await setFix(false);
      await startWatch();
      const seedB = await openAt(mode, catX);
      const boxB = await boxOf(sel);
      const fbB = win.getBounds();
      const inkB = await inkScan(boxB, id + '/after');
      const scrB = screenOf(boxB, fbB);
      const watch = await stopWatch();

      // 收尾:关窗 + 复位,确认静息态 catShift 归零(否则会污染下一靶)
      await reset(); await sleep(400);
      const restCr = await js(`(() => { const cr = document.querySelector('#compact-row');
        const cs = getComputedStyle(cr);
        return { pos: cs.position, left: cs.left, innerW: window.innerWidth,
                 frameW: window.innerWidth }; })()`);

      RESULTS[id] = { desc, seedA, seedB, boxA, boxB, inkA, inkB, scrA, scrB, watch, restCr };
      log({ ev: 'target', id, desc,
            before: { box: boxA, ink: inkA, screen: scrA },
            after: { box: boxB, ink: inkB, screen: scrB },
            watch, restingCompactRow: restCr });
    };

    await runTarget('P', 'peek', '#peek', RIGHT, '.peek 贴右缘');
    await runTarget('A', 'ask', '#ask', RIGHT, '.ask 贴右缘（圆弧被切的那个）');
    await runTarget('M', 'ask', '#ask', LEFT, '.ask 贴左缘（镜像）');

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const ib = (ink) => (!ink || ink.err) ? String(ink && ink.err || 'n/a')
      : { L: ink.leftInk_css, R: ink.rightInk_css, alphaOK: ink.alphaTrustworthy };
    const sb = (s) => (!s || s.err) ? String(s && s.err || 'n/a')
      : { box: [s.boxScreenL, s.boxScreenR], cat: [s.catScreenL, s.catScreenR],
          off: [s.boxOffScreenLeft, s.boxOffScreenRight],
          clip: [s.clipLeft, s.clipRight], frameX: s.frameX, frameW: s.frameW,
          popShift: s.popShift, crLeft: s.crLeft, crScrollW: s.crScrollW,
          plan: s.plan };

    const verdict = [];
    for (const id of ['P', 'A', 'M']) {
      const r = RESULTS[id];
      if (!r) { verdict.push(id + ': MISSING'); continue; }
      const a = r.inkA, b = r.inkB, sa = r.scrA, sb2 = r.scrB;
      if (!a || a.err || !b || b.err) { verdict.push(id + ': INVALID 没量到墨迹'); continue; }
      if (!a.alphaTrustworthy || !b.alphaTrustworthy) { verdict.push(id + ': INVALID alpha 不可信'); continue; }
      if (!sb2.plan) { verdict.push(id + ': INVALID 修法没跑到(plan 为空),不许下结论'); continue; }
      // 近侧 = 猫贴哪边,那一侧就是「阴影本该没了」的一侧
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
      if (Math.abs(sb2.frameW - 520) > 2) bad.push('★帧宽变了 ' + sb2.frameW + '(位移喂回了帧宽?)');
      if (r.watch && r.watch.jumpCount > 0) bad.push('★★猫有跳帧 ' + r.watch.jumpCount + ' 次:'
        + JSON.stringify(r.watch.jumps.slice(0, 3)));
      if (r.restCr && r.restCr.left && r.restCr.left !== 'auto' && r.restCr.left !== '0px')
        bad.push('静息态 catShift 没归零:' + r.restCr.left);
      verdict.push(bad.length
        ? id + ': FAILED —— ' + bad.join(' / ')
        : id + ': CONFIRMED 近侧阴影 ' + nearA + '→' + nearB + '、远侧 ' + farB
          + '、出屏 ' + offA + '→' + offB + '、猫没动、帧宽 ' + sb2.frameW
          + '、零跳帧(' + (r.watch ? r.watch.frames : 0) + ' 帧)');
    }

    log({ SUMMARY: {
      P: RESULTS.P && { before: { ink: ib(RESULTS.P.inkA), s: sb(RESULTS.P.scrA) },
                        after: { ink: ib(RESULTS.P.inkB), s: sb(RESULTS.P.scrB) },
                        watch: RESULTS.P.watch, rest: RESULTS.P.restCr },
      A: RESULTS.A && { before: { ink: ib(RESULTS.A.inkA), s: sb(RESULTS.A.scrA) },
                        after: { ink: ib(RESULTS.A.inkB), s: sb(RESULTS.A.scrB) },
                        watch: RESULTS.A.watch, rest: RESULTS.A.restCr },
      M: RESULTS.M && { before: { ink: ib(RESULTS.M.inkA), s: sb(RESULTS.M.scrA) },
                        after: { ink: ib(RESULTS.M.inkB), s: sb(RESULTS.M.scrB) },
                        watch: RESULTS.M.watch, rest: RESULTS.M.restCr },
      VERDICT: verdict,
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_REALPATH ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_REALPATH')) runProbeRealPath();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_REALPATH')) app.dock.hide(); } catch {}"


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
                              (ANCHOR_SHIFT, "pet.js", psrc)):
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
                .replace(ANCHOR_SHIFT, INJECT_SHIFT))
        for f in (MAIN, PET):
            chk = subprocess.run(["node", "--check", f], capture_output=True, text=True)
            if chk.returncode != 0:
                print("ABORT: patch 后语法错误 %s:\n%s" % (f, chk.stderr))
                return 1
        print("patched main.js + renderer/pet.js, node --check 双双通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_REALPATH": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=260)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 260s")
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
            if "PROBE_REALPATH" in line:
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
