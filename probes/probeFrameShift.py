#!/usr/bin/env python3
# 探针 #13：H3 第四条路 —— 「帧往内挪 + 猫在帧内反向补偿」
#
# 用户 2026-09-18 否掉了我摆的三选一代价表,原话:
#   「我想要的是,一侧贴边,另一侧的阴影还存在。这个不能做到么?」
# 并且同时报了第二个症状:
#   「贴边那一测,如果出现有选项的弹窗,贴边那一侧的圆弧都没了」
#
# 我上一轮的框架是错的 —— 我把「必须付代价」当成前提,因为我默认帧原点恒 = 猫 − 200。
# 可帧里的地明明够用(猫贴右缘、.ask):
#     弹窗 340 + 两侧阴影 21×2 = 382,帧 520 → **富余 138px**
#     偏偏该给阴影的左侧是 0,用不上的右侧甩了 200px 到屏幕外。
# ⇒ 帧不是不够宽,是**位置偏了**。两个症状(近侧阴影没了 / 远侧圆弧出屏)同一个根。
#
# ★ 本探针要验的修法形状(三个量一起动,互相抵消):
#     帧原点   往内挪 S = ceil(阴影外扩) + 1 + 当前出屏量
#     猫       在帧内往外补 +S        → 猫在**屏幕上**一px不动
#     --pop-shift 补 +(S − 出屏量)     → 盒子只往内挪「出屏量」,把出屏归零
#   代价:帧尾(**透明**)多悬出屏幕 S。主进程本来就允许(main.js:263「钳猫之后窗口原点
#   **合法地**可以是负数或超出屏幕右缘」)。不缩字、不改帧宽、正文出屏反而减少。
#
# 猫的补偿落在 #compact-row 上 —— 它正好圈住「会话点 + 猫 + 胶囊」这一列
# (pet.html:120-138),而弹窗是 #stage 的另一批子节点,天然不跟着走。
# 已核实 #compact-row 的 CSS(pet.css:53-60)无 position / transform / animation,
# 且全表 grep 无任何 keyframes 碰它 → 不会像 --pop-shift 那样被 `transform:none` 擦掉。
# 用 position:relative + left(不用 margin —— pet.css:44「margin 会挤压兄弟节点、
# 把整列的布局宽度推出去」,2026-09-16 的教训)。
#
# ★★ 设计要点:必须有阴性对照 —— 否则「假修好」量不出来
#   如果只量「移完 leftInk 回到 21.5」,分不清两种情况:
#     (a) 帧移了、猫靠补偿留在原地(真修好)
#     (b) 我把整只猫也往内推了 S(阴影自然回来,但猫不再贴边 —— **假修好**,
#         等于偷偷改了用户看到的猫位置)
#   → 每个靶都记 catScreenX_before / after。**两者必须逐位相等**,否则整靶作废。
#   这条判读写死在探针里(见 VERDICT),免得看数时脑补。
#
# 靶位(猫贴右缘,阴影外扩量用探针 #11 的实测值:.peek 21.5 / .ask 21):
#   P0 .peek 贴右缘 / 原样      → 基线,预期 L=0    R=21.5  boxScreenR=1680
#   P1 .peek 帧移 S=23          → 预期 L≈21.5 R≈21.5 猫不动 boxScreen 仍[1360,1680]
#   A0 .ask  贴右缘 / 原样      → 基线,预期 L=0    R=21    boxScreenR=**1700**(出屏20)
#   A1 .ask  帧移 S=42          → 预期 L≈21  R≈21   猫不动 boxScreenR=**1680**(圆弧回来)
#
# S 的算术(逐靶自洽,探针里现算,不写死):
#   S = ceil(shadow) + 1 + offScreen ;  frameX' = frameX − S
#   目标 boxScreenL' = boxScreenL − offScreen
#   popShift' = (boxScreenL' − frameX') − (POPUP_W − boxW)/2
#   .peek: shadow21.5→23, off 0  → S=23, frameX' 1337, 帧内L 23, 居中100 → shift −77
#   .ask : shadow21  →22, off 20 → S=42, frameX' 1318, 帧内L 22, 居中 90 → shift −68
#   两者都在现有封顶 (520−W)/2 = 100/90 之内 ⇒ **capsuleShift 的封顶不用改**。
#
# 判读表:
#   catScreenX 变了            → INVALID,是假修好,整靶作废
#   L 回到 ~阴影量 且 R 仍在    → CONFIRMED,这条路成立
#   A1 的 boxScreenR ≤ 1680     → 圆弧症状同时归零(第二个症状)
#   帧宽变了                    → INVALID(补偿位移不该喂回 measuredRestingWidth)
#
# ⚠️ 本探针会临时改写 main.js,跑之前 worktree 必须干净(跑完自动恢复 + node --check)。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeFrameShift.bak"

PROBE = r"""
// ==== PROBE_FRAMESHIFT (临时) ====
function runProbeFrameShift() {
  const log = (o) => console.log('PROBE_FRAMESHIFT ' + JSON.stringify(o));
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
    const errs = () => js('(window.__probeErrs || []).slice(-6)');

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    // seed:照抄探针 #11(每轮换新 sessionId —— 重灌同一个 id 的 choice 不再弹)
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
            question: '帧往内挪 + 猫在帧内反向补偿,能不能一侧贴边、另一侧阴影还在?这条问题要够长,好让 .ask 撑到 340px 上限。',
            options: [
              { id: 'yes', label: '帧移 + 猫补偿' },
              { id: 'no', label: '贴边时弹窗变窄' },
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

    // 探针 #10 踩过:reset() 不重算 --pop-shift,改完猫位置必须显式重算,否则量到陈值。
    const recalc = async () => {
      const fx = win.getBounds().x;
      return js(`(() => { try { applyPopupShift(${fx} + (window.innerWidth - 120) / 2, 120); return 1; }
                          catch (e) { return String(e); } })()`);
    };

    // 盒子矩形 + 猫矩形一起取 —— 猫的位置是本探针的**阴性对照**,必须同帧读
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
               shadow: getComputedStyle(n).boxShadow,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // ★ 修法本体:三个量一起动
    //   帧 x −= S(往内挪)  /  #compact-row left = +S(猫在帧内往外补)  /  --pop-shift 给定
    // 注意:**不能**调 applyPetSize —— 它会按 inset=(width-120)/2=200 从猫锚点反解原点,
    // 把帧移原样撤掉。产品代码里对应的是给 applyPetSize 传一个变量 inset。
    const applyFrameShift = async (S, popShift) => {
      const b = win.getBounds();
      win.setBounds({ x: b.x - S, y: b.y, width: b.width, height: b.height });
      const r = await js(`(() => {
        const cr = document.querySelector('#compact-row');
        if (!cr) return 'missing compact-row';
        cr.style.position = 'relative';
        cr.style.left = '${S}px';
        document.querySelector('#stage').style.setProperty('--pop-shift', '${popShift}px');
        const cs = getComputedStyle(cr);
        return { crPos: cs.position, crLeft: cs.left,
                 shift: getComputedStyle(document.querySelector('#stage'))
                          .getPropertyValue('--pop-shift').trim() };
      })()`);
      await sleep(300);
      return { applied: r, frame: win.getBounds() };
    };
    const clearFrameShift = () => js(`(() => {
      const cr = document.querySelector('#compact-row');
      if (cr) { cr.style.position = ''; cr.style.left = ''; }
      return 1; })()`);

    // ════════════════════════════════════════════════════════════════════
    // 像素量法 —— 逐字照抄探针 #11/#12 的 inkScan(两轮都 alphaTrustworthy:true)
    // ⚠️ rect 量不到 box-shadow,只有像素能。sf=2 时 bitmap 是**物理像素**。
    // ════════════════════════════════════════════════════════════════════
    const inkScan = async (box, label) => {
      if (typeof box !== 'object' || box === null) return { label, err: 'no box: ' + box };
      let img;
      try { img = await wc.capturePage(); } catch (e) { return { label, err: 'capture: ' + String(e) }; }
      const size = img.getSize();
      const bmp = img.getBitmap();          // BGRA,4 字节/像素
      const sf = Math.round((size.width / (await js('window.innerWidth'))) * 100) / 100;
      const W = size.width, H = size.height;
      const bytesPerRow = W * 4;
      const y = Math.round(((box.T + box.B) / 2) * sf);
      if (y < 0 || y >= H) return { label, err: 'scanline out of bitmap: y=' + y + ' H=' + H };
      const alphaAt = (x) => {
        if (x < 0 || x >= W) return -1;     // -1 = 出了 bitmap,区别于 0 = 透明
        return bmp[y * bytesPerRow + x * 4 + 3];
      };
      const TH = 3;
      const boxL = Math.round(box.L * sf), boxR = Math.round(box.R * sf);
      let leftInk = 0;
      for (let x = boxL - 1; x >= 0; x--) { if (alphaAt(x) > TH) leftInk++; else break; }
      let rightInk = 0;
      for (let x = boxR; x < W; x++) { if (alphaAt(x) > TH) rightInk++; else break; }
      // 动态远端采样自查(#11 第一版钉死 x=2,贴边时正落在弹窗身上 → 误报)
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

    // 把帧内坐标换算成屏幕坐标 —— 出屏量 / 猫位置 / 帧裁都在这一层判
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
        waRight: waR,
      };
    };

    // ── 正式测量 ──
    const got = await grabFocus();
    log({ ev: 'focus', gotFocus: got });

    // README 记着的坑:第一轮状态可能反相,先预热一轮。
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(300);
    log({ ev: 'warmup', done: true });

    const RIGHT = wa.x + wa.width - 120;
    const RESULTS = {};
    let uid = 0;

    const openAt = async (mode, catX) => {
      await reset(); await sleep(200);
      await clearFrameShift();
      seed(mode, 's' + (++uid)); await sleep(300);
      await placeCat(catX);
      if (mode === 'ask') {
        const f = await forceShow(); await sleep(300);
        await recalc(); await sleep(200);
        return { box: await boxOf('#ask'), forced: f };
      }
      await clickCat('left'); await sleep(600);
      await recalc(); await sleep(150);
      return { box: await boxOf('#peek'), forced: 'n/a' };
    };

    // 一个靶 = 基线 + 帧移后,S 与 popShift 都按实测的 box 现算
    const runTarget = async (id, mode, sel, shadow) => {
      const o = await openAt(mode, RIGHT);
      const box0 = o.box;
      if (typeof box0 !== 'object' || box0 === null) {
        RESULTS[id] = { err: 'open failed: ' + box0, forced: o.forced };
        log({ ev: 'target', id, ERR: 'open failed', box0, forced: o.forced });
        return;
      }
      const fb0 = win.getBounds();
      const ink0 = await inkScan(box0, id + '/before');
      const sc0 = screenOf(box0, fb0);

      // S 与 popShift 现算(不写死,靠实测的 box / 出屏量推)
      const off = sc0.boxOffScreenRight;
      const S = Math.ceil(shadow) + 1 + off;
      const frameXNew = fb0.x - S;
      const wantScreenL = sc0.boxScreenL - off;          // 把出屏量吃掉
      const centered = (fb0.width - box0.w) / 2;
      const popShift = Math.round((wantScreenL - frameXNew - centered) * 10) / 10;

      const ap = await applyFrameShift(S, popShift);
      const box1 = await boxOf(sel);
      const fb1 = win.getBounds();
      const ink1 = await inkScan(box1, id + '/shifted');
      const sc1 = screenOf(box1, fb1);
      await clearFrameShift();

      RESULTS[id] = { plan: { shadow, off, S, frameXNew, wantScreenL, centered, popShift },
                      box0, ink0, sc0, applied: ap.applied, box1, ink1, sc1 };
      log({ ev: 'target', id, desc: mode + ' 贴右缘 / 帧移 S=' + S,
            plan: RESULTS[id].plan, applied: ap.applied,
            before: { ink: ink0, screen: sc0 }, after: { ink: ink1, screen: sc1 } });
    };

    await runTarget('P', 'peek', '#peek', 21.5);   // 探针 #11 实测 .peek 外扩 21.5
    await runTarget('A', 'ask',  '#ask',  21);     // 探针 #11 实测 .ask  外扩 21

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const row = (r) => {
      if (!r || r.err) return String(r && r.err || 'n/a');
      const i0 = r.ink0 || {}, i1 = r.ink1 || {};
      return {
        S: r.plan.S, popShift: r.plan.popShift,
        ink_L: i0.leftInk_css + ' → ' + i1.leftInk_css,
        ink_R: i0.rightInk_css + ' → ' + i1.rightInk_css,
        boxScreen: '[' + r.sc0.boxScreenL + ',' + r.sc0.boxScreenR + '] → ['
                       + r.sc1.boxScreenL + ',' + r.sc1.boxScreenR + ']',
        offScreenRight: r.sc0.boxOffScreenRight + ' → ' + r.sc1.boxOffScreenRight,
        catScreen: r.sc0.catScreenL + ' → ' + r.sc1.catScreenL,
        frameX: r.sc0.frameX + ' → ' + r.sc1.frameX,
        frameW: r.sc0.frameW + ' → ' + r.sc1.frameW,
        clip: [r.sc1.clipLeft, r.sc1.clipRight],
        alphaOK: [i0.alphaTrustworthy, i1.alphaTrustworthy],
        waRight: r.sc1.waRight,
      };
    };
    // 自动判读:把判读表写死在探针里,免得看数时又靠脑补
    const verdict = (r, id, shadow) => {
      if (!r || r.err) return id + ': INVALID(靶没跑起来:' + (r && r.err) + ')';
      const i0 = r.ink0, i1 = r.ink1;
      if (!i0 || !i1 || i0.err || i1.err) return id + ': INVALID(没量到墨迹)';
      if (!i0.alphaTrustworthy || !i1.alphaTrustworthy) return id + ': INVALID(alpha 不可信)';
      // ★ 阴性对照:猫在屏幕上必须一px不动,否则是「假修好」(偷偷把猫推离了边缘)
      if (r.sc0.catScreenL !== r.sc1.catScreenL)
        return id + ': INVALID 假修好 —— 猫在屏幕上动了(' + r.sc0.catScreenL
               + '→' + r.sc1.catScreenL + '),等于偷偷改了用户看到的猫位置';
      if (r.sc0.frameW !== r.sc1.frameW)
        return id + ': INVALID —— 帧宽变了(' + r.sc0.frameW + '→' + r.sc1.frameW
               + '),补偿位移喂回了 measuredRestingWidth';
      if (r.sc1.clipLeft > 1 || r.sc1.clipRight > 1)
        return id + ': INVALID —— 盒子被帧裁了 ' + JSON.stringify([r.sc1.clipLeft, r.sc1.clipRight]);
      if (i1.leftInk_css < shadow - 3)
        return id + ': REFUTED —— 近侧阴影没回来(' + i0.leftInk_css + '→' + i1.leftInk_css
               + ',期望 ~' + shadow + '),我的推理错了';
      if (i1.rightInk_css < shadow - 3)
        return id + ': PARTIAL —— 近侧回来了但远侧阴影丢了(R ' + i0.rightInk_css
               + '→' + i1.rightInk_css + ')';
      if (r.sc1.boxOffScreenRight > r.sc0.boxOffScreenRight)
        return id + ': PARTIAL —— 阴影回来了但正文出屏变多了('
               + r.sc0.boxOffScreenRight + '→' + r.sc1.boxOffScreenRight + ')';
      return id + ': CONFIRMED —— 一侧贴边 + 另一侧阴影在(L ' + i0.leftInk_css + '→'
             + i1.leftInk_css + ', R ' + i1.rightInk_css + '),猫没动,出屏 '
             + r.sc0.boxOffScreenRight + '→' + r.sc1.boxOffScreenRight;
    };
    log({ SUMMARY: {
      P_peek: row(RESULTS.P),
      A_ask: row(RESULTS.A),
      VERDICT: [verdict(RESULTS.P, 'P/peek', 21.5), verdict(RESULTS.A, 'A/ask', 21)],
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_FRAMESHIFT ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_FRAMESHIFT')) runProbeFrameShift();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_FRAMESHIFT')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js。先提交或 stash：")
        print(dirty)
        return 1

    src = open(MAIN, encoding="utf-8").read()
    for needle in (TRIGGER, DOCK):
        if needle not in src:
            print("ABORT: 找不到锚点:\n" + needle)
            return 1
    shutil.copy(MAIN, BAK)
    try:
        patched = src.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE
        open(MAIN, "w", encoding="utf-8").write(patched)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误:\n" + chk.stderr)
            return 1

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_FRAMESHIFT": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=200)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 200s")
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
            if "PROBE_FRAMESHIFT" in line:
                print(line)
    finally:
        shutil.copy(BAK, MAIN)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        print("restored main.js, node --check rc=%d" % chk.returncode)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
