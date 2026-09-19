#!/usr/bin/env python3
# 探针 #11：H2 修法 (a) 留下的阴影洞。
#
# 用户实测报告（2026-09-18，H2 修完之后）：
#   「我看，这次确实没有气泡在边缘的裁切了，但是气泡周围本来是有阴影的吧？
#     如果喵靠在右边，左边缘的阴影也没了」
#
# 假说：修法 (a) 把位移压到「弹窗**盒子**刚好贴住帧缘」（探针 #10 实测：猫贴右缘时
# .ask 落在 L=0 R=340）。但 box-shadow 画在盒子**外面**：
#   .peek  0 9px 26px rgba(120,60,35,.30)  → 向外水平扩散 ≈ 13px
#   .ask   0 8px 24px rgba(120,60,35,.32)  → 向外水平扩散 ≈ 12px
# 盒子贴死帧缘 ⇒ 那 12-13px 阴影落在帧外 ⇒ 被 html,body{overflow:hidden} 裁掉。
# 也就是说我夹的是**盒子矩形**，而该夹的是**盒子+阴影**这坨可见的墨。
#
# ⚠️ 为什么不能用 getBoundingClientRect：**它不含 box-shadow**。
#    rect 会老老实实报 L=0 R=340「一切正常」，而屏幕上左侧阴影已经没了。
#    探针 #10 全部结论都建立在 rect 上，所以它对这个现象**结构性地盲** —— 同 CONSTRAINTS
#    §三 盲区 A（rAF 看不见合成中断）一个性质：量错了量纲。
#    → 本探针改用 wc.capturePage() 抓**真实像素**，直接数盒子两侧还剩几列非透明墨。
#
# 判据（NativeImage 的 bitmap 是 BGRA，alpha 在第 4 字节）：
#   在弹窗竖直中心那条扫描线上，从盒子左缘往**左**数连续非透明像素 = 左侧可见阴影宽度
#   从盒子右缘往**右**数 = 右侧可见阴影宽度
#   · 猫居中：左 ≈ 右 ≈ 12-13px           → 基线，证明这个量法测得到阴影
#   · 猫贴右缘：左 ≈ 0 而右 ≈ 12-13px      → 假说成立（左侧阴影被帧裁）
#   · 猫贴左缘：右 ≈ 0 而左 ≈ 12-13px      → 对称确认
# 三条同时成立才算证实；若猫居中时左右都量到 0，说明量法本身不对（而不是没阴影）。
#
# 另外量一条**修法方向验证**：把 --pop-shift 手工回退 13px（模拟「给阴影留余量」），
# 看左侧阴影是否恢复、正文是否因此出屏 —— 这是「加宽帧」vs「阴影跟着内缩」的取舍依据。
#
# ⚠️ 本探针会临时改写 main.js，跑之前 worktree 必须干净（跑完会自动恢复 + node --check）。

import os, shutil, subprocess, signal, json

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeShadow.bak"

PROBE = r"""
// ==== PROBE_SHADOW (临时) ====
function runProbeShadow() {
  const log = (o) => console.log('PROBE_SHADOW ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // 探针 #10 踩过：4s 心跳（main.js setInterval(emitStats, 4000)）会把假快照冲掉。
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

    // ⚠️ 第二版探针的欠账：`ask` 三轮仍全 hidden，而**同一次 applyStats 里 notepad 却可见**
    //    （pad.hidden:false）。说明假快照到了、updateNotepad 认了这个会话（actionableItems()
    //    非空），紧挨着的 refreshAsk(s) 拿同一份数据却 hideAsk() 了。已排除的：
    //      · stats.actions —— main.js 的 buildStats 根本没有这个字段，走不到那条分支
    //      · choice 形状 —— 与探针 #10 成功那次逐字相同
    //      · #ask 的 HTML `hidden` 属性 —— 没有，只有 class
    //      · 渲染抛异常 —— errs: []
    //    剩下的门只能打点看，不能再静态推。askState() 把 refreshAsk 的每道门的**实际值**读出来。
    //    注意：CSP 无 unsafe-eval，但直接写标识符能解析（见 CONSTRAINTS §四）。
    const askState = () => js(`(() => {
      try {
        const n = document.querySelector('#ask');
        return {
          askActive, actionPopOpen, radialOpen, peekOpen, quotaPopoverOpen,
          askQueueLen: askQueue.length, askIdx, lastAskSig,
          answeredSize: answered.size, answeredKeys: [...answered].slice(0, 4),
          curActionsLen: curActions.length, curSessionsLen: curSessions.length,
          actionableLen: actionableItems().length,
          actionableKeys: actionableItems().map(choiceKey).slice(0, 4),
          interacting: (typeof isInteracting === 'function') ? isInteracting() : 'n/a',
          askClass: n ? n.className : 'missing',
          lastStatsSessions: (lastStats && lastStats.sessions || []).map(
            (s) => s.sessionId + ':' + s.state + ':' + (s.choice ? 'choice' : 'nochoice')),
        };
      } catch (e) { return 'askState threw: ' + String(e); }
    })()`);

    // 直调 showAskPanel：如果这一步能把面板打开，说明门在 refreshAsk 里而不在渲染里。
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

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    // seed：照抄探针 #10（refreshAsk 的门槛在 renderer/pet.js:1003-1075）
    // ⚠️ 第一版探针踩的坑：`ask` 三轮全 hidden。原因是前面反复 hideAsk() 之后，
    //    重灌**同一个 sessionId** 不再弹（该会话的 choice 已被标成打发过）。
    //    → seed 收一个 uid，每轮换新 sessionId。
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
            question: '阴影被帧裁这件事要用像素量，rect 量不到。这条问题要够长，好让 .ask 撑到 340px 上限。',
            options: [
              { id: 'yes', label: '阴影跟着弹窗内缩' },
              { id: 'no', label: '把帧加宽到 592' },
            ],
            allowInput: true,
          },
        })];
        snap.waitingCount = 1; snap.needsinputCount = 1; snap.workingCount = 0; snap.thinkingCount = 0;
      } else {
        snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

    // ⚠️ 盲区：原版 placeCat 把 y 钉死在工作区竖直中点，三轮 notepad 全是 stageClass:"edge-below"
    //    （猫在帧顶、弹窗在下）。而 `bottom:96px` 在 edge-above（猫在帧底）下落点完全不同 ——
    //    那才可能是用户平时看到「在喵边上」的那一种。必须两种布局都量，否则又是 CONSTRAINTS §三
    //    「量错了条件」。→ 收一个可选 catScreenY。
    const placeCat = async (catScreenX, catScreenY) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      const y = catScreenY == null ? (wa.y + wa.height / 2 - 150) : catScreenY;
      win.setBounds({ x: Math.round(catScreenX - inset), y: Math.round(y),
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

    // 探针 #10 踩过：reset() 不重算 --pop-shift，改完猫位置必须显式重算，否则量到陈值。
    const recalc = async () => {
      const fx = win.getBounds().x;
      return js(`(() => { try { applyPopupShift(${fx} + (window.innerWidth - 120) / 2, 120); return 1; }
                          catch (e) { return String(e); } })()`);
    };

    // 盒子矩形（不含阴影）—— 拿来定位扫描起点，以及和像素量法交叉验证
    const boxOf = (sel) => js(`(() => { const n = document.querySelector('${sel}');
      if (!n) return 'missing';
      if (n.hidden || n.classList.contains('hidden')) return 'hidden';
      const r = n.getBoundingClientRect();
      return { L: Math.round(r.left * 10) / 10, R: Math.round(r.right * 10) / 10,
               T: Math.round(r.top * 10) / 10, B: Math.round(r.bottom * 10) / 10,
               w: Math.round(r.width * 10) / 10, innerW: window.innerWidth,
               shadow: getComputedStyle(n).boxShadow,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // ── 附带靶：#notepad（用户 2026-09-18 新报的问题）──────────────────
    // 「有审批的时候，喵边上那个日记本小图标的位置。应该在哪？」
    // .notepad 是 position:absolute; right:44px; bottom:96px，锚的是 #stage（帧），
    // **不锚猫**。猫贴右缘时帧右缘伸到屏外 200px，图标可能整块出屏。
    // 这里量它相对猫、相对屏幕的实际位置，判定「是否出屏」「离猫多远」。
    const padBox = () => js(`(() => {
      const n = document.querySelector('#notepad');
      if (!n) return 'missing';
      const cs = getComputedStyle(n);
      const hid = n.hidden || n.classList.contains('hidden') || cs.display === 'none';
      const r = n.getBoundingClientRect();
      const c = document.querySelector('#cat').getBoundingClientRect();
      return { hidden: hid, display: cs.display, position: cs.position,
               cssRight: cs.right, cssBottom: cs.bottom,
               L: Math.round(r.left * 10) / 10, R: Math.round(r.right * 10) / 10,
               T: Math.round(r.top * 10) / 10, B: Math.round(r.bottom * 10) / 10,
               catL: Math.round(c.left * 10) / 10, catR: Math.round(c.right * 10) / 10,
               catT: Math.round(c.top * 10) / 10, catB: Math.round(c.bottom * 10) / 10,
               innerW: window.innerWidth, innerH: window.innerHeight,
               stageClass: document.querySelector('#stage').className }; })()`);

    const padVerdict = (p, frameX, frameY) => {
      if (typeof p !== 'object' || p === null) return { err: 'no box: ' + p };
      const sx = { L: p.L + frameX, R: p.R + frameX };
      const sy = { T: p.T + frameY, B: p.B + frameY };
      const waR = wa.x + wa.width, waB = wa.y + wa.height;
      return {
        hidden: p.hidden, position: p.position, cssRight: p.cssRight, cssBottom: p.cssBottom,
        stageClass: p.stageClass,
        screenL: Math.round(sx.L), screenR: Math.round(sx.R),
        screenT: Math.round(sy.T), screenB: Math.round(sy.B),
        offScreenRight: Math.max(0, Math.round(sx.R - waR)),
        offScreenLeft: Math.max(0, Math.round(wa.x - sx.L)),
        offScreenBottom: Math.max(0, Math.round(sy.B - waB)),
        offScreenTop: Math.max(0, Math.round(wa.y - sy.T)),
        // 帧裁（html,body{overflow:hidden}）
        clipRight: Math.max(0, Math.round(p.R - p.innerW)),
        clipLeft: Math.max(0, Math.round(-p.L)),
        clipBottom: Math.max(0, Math.round(p.B - p.innerH)),
        // 相对猫：正数 = 在猫右侧多远 / 猫下方多远
        gapFromCatRight: Math.round(p.L - p.catR),
        gapFromCatBottom: Math.round(p.T - p.catB),
        vsCatTop: Math.round(p.T - p.catT),
      };
    };

    // ════════════════════════════════════════════════════════════════════
    // 像素量法：capturePage → BGRA bitmap → 在弹窗竖直中心扫描线上数墨
    // ════════════════════════════════════════════════════════════════════
    // ⚠️ 这是本探针的核心，rect 量不到阴影，只有像素能。
    // scaleFactor=2（1680x1050@2x）时 bitmap 是**物理像素**，宽 = innerWidth * 2。
    // 所有 CSS 坐标都要乘 sf 才能索引 bitmap。
    const inkScan = async (box, label) => {
      if (typeof box !== 'object' || box === null) return { label, err: 'no box: ' + box };
      let img;
      try { img = await wc.capturePage(); } catch (e) { return { label, err: 'capture: ' + String(e) }; }
      const size = img.getSize();
      const bmp = img.getBitmap();          // BGRA，4 字节/像素
      const sf = Math.round((size.width / (await js('window.innerWidth'))) * 100) / 100;
      const W = size.width, H = size.height;
      const bytesPerRow = W * 4;
      // 扫描线取弹窗竖直中心（避开 0 9px 的竖直 offset 让上下缘阴影不对称）
      const y = Math.round(((box.T + box.B) / 2) * sf);
      if (y < 0 || y >= H) return { label, err: 'scanline out of bitmap: y=' + y + ' H=' + H };
      const alphaAt = (x) => {
        if (x < 0 || x >= W) return -1;     // -1 = 出了 bitmap，区别于 0 = 透明
        return bmp[y * bytesPerRow + x * 4 + 3];
      };
      // 从盒子缘往外数连续非透明像素（alpha > 阈值）。阈值取 3：阴影最外圈
      // alpha 会衰减到 1-2，算「肉眼无」；同时排掉 PNG 量化噪声。
      const TH = 3;
      const boxL = Math.round(box.L * sf), boxR = Math.round(box.R * sf);
      let leftInk = 0;
      for (let x = boxL - 1; x >= 0; x--) { if (alphaAt(x) > TH) leftInk++; else break; }
      let rightInk = 0;
      for (let x = boxR; x < W; x++) { if (alphaAt(x) > TH) rightInk++; else break; }
      // 也记下盒子缘内侧一像素的 alpha：应当很高（弹窗自己的背景 .98 不透明）。
      // 如果这个都接近 0，说明扫描线没打在弹窗上，整组数据作废。
      //
      // ⚠️ 还有一个更根本的失败模式：**透明窗口的 capturePage 可能把 alpha 抹成全 255**
      //    （合成到不透明底上）。那样 leftInk/rightInk 会一律等于「到 bitmap 边缘的距离」，
      //    看着像「阴影超宽」而不是 0 —— 假阳性，比假阴性更坑。
      //    自检：取一个**离弹窗很远**的采样点。
      //    ⚠️ 第一版把它定在 bitmap 最左 2px —— 猫贴右缘时弹窗恰好被推到 L=0，
      //       那个点正落在弹窗自己的奶油底色上（读出 alpha 251、rgb(251,248,246)），
      //       于是误报 alphaTrustworthy:false。改成动态选点：取盒子**外侧最远**那一边，
      //       即左右两个候选里离盒子更远的那个。
      const farCandL = Math.max(0, boxL - 120);
      const farCandR = Math.min(W - 1, boxR + 120);
      const farX = (boxL - farCandL) >= (farCandR - boxR) ? farCandL : farCandR;
      const farA = alphaAt(farX);
      const farRGB = [bmp[y * bytesPerRow + farX * 4 + 2],   // R（BGRA，第 3 字节才是 R）
                      bmp[y * bytesPerRow + farX * 4 + 1],   // G
                      bmp[y * bytesPerRow + farX * 4 + 0]];  // B
      return {
        label, sf, bitmap: { W, H }, scanY: y,
        boxL_css: box.L, boxR_css: box.R, innerW_css: box.innerW,
        insideLeftAlpha: alphaAt(boxL + 2), insideRightAlpha: alphaAt(boxR - 3),
        farX, farAlpha: farA, farRGB, alphaTrustworthy: farA <= TH,
        leftInk_px: leftInk, rightInk_px: rightInk,
        leftInk_css: Math.round((leftInk / sf) * 10) / 10,
        rightInk_css: Math.round((rightInk / sf) * 10) / 10,
      };
    };

    // ── 正式测量 ──
    const got = await grabFocus();
    log({ ev: 'focus', gotFocus: got });

    // README 记着的坑：第一轮状态可能反相，先预热一轮。
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(300);
    log({ ev: 'warmup', done: true });

    const RESULTS = {};
    let uid = 0;

    // 靶 A：peek（320 宽）三个位置
    for (const [tag, catX] of [
      ['center', wa.x + Math.round(wa.width / 2)],
      ['rightEdge', wa.x + wa.width - 120],
      ['leftEdge', wa.x],
    ]) {
      await reset(); await sleep(200);
      seed('peek', 'p' + (++uid)); await sleep(300);
      await placeCat(catX);
      await clickCat('left'); await sleep(600);
      await recalc(); await sleep(150);
      const box = await boxOf('#peek');
      const ink = await inkScan(box, 'peek/' + tag);
      RESULTS['peek_' + tag] = { box, ink };
      log({ ev: 'measure', target: 'peek', pos: tag, catX, box, ink });
      await reset(); await sleep(200);
    }

    // 靶 B：ask（340 宽）三个位置
    // ⚠️ 每轮换新 sessionId（见 seed 注释），否则 hideAsk 之后重灌同一个 id 不再弹。
    for (const [tag, catX] of [
      ['center', wa.x + Math.round(wa.width / 2)],
      ['rightEdge', wa.x + wa.width - 120],
      ['leftEdge', wa.x],
    ]) {
      await reset(); await sleep(250);
      seed('ask', 'a' + (++uid)); await sleep(700);
      await placeCat(catX);
      await sleep(200);
      await recalc(); await sleep(200);
      let box = await boxOf('#ask');
      // 面板没开 → 先把 refreshAsk 每道门的实际值打出来，再试直调 showAskPanel
      let diag = null, forced = null;
      if (box === 'hidden' || box === 'missing') {
        diag = await askState();
        forced = await forceShow();
        await sleep(300);
        await recalc(); await sleep(200);
        box = await boxOf('#ask');
      }
      const ink = await inkScan(box, 'ask/' + tag);
      // 记事本此刻必然可见（有审批 ⇒ actionableItems 非空），一并量
      const fb = win.getBounds();
      const pad = padVerdict(await padBox(), fb.x, fb.y);
      RESULTS['ask_' + tag] = { box, ink, pad, diag, forced };
      log({ ev: 'measure', target: 'ask', pos: tag, catX, box, ink, pad, diag, forced });
    }

    // ════════════════════════════════════════════════════════════════════
    // 靶 C：修法方向验证 —— 手工把位移往内回退 SHADOW_PAD，看阴影是否恢复
    // ════════════════════════════════════════════════════════════════════
    // 这直接回答「加宽帧」vs「阴影跟着内缩」的取舍：
    //   若回退后 leftInk 恢复到 ~12px 而正文 screenL 出屏 → 代价就是拿正文换阴影
    //   （那就该选「阴影跟着内缩」，正文一px不让）
    await reset(); await sleep(250);
    seed('ask', 'pad' + (++uid)); await sleep(700);
    await placeCat(wa.x + wa.width - 120);
    await recalc(); await sleep(200);
    let before = await boxOf('#ask');
    if (before === 'hidden' || before === 'missing') {
      await forceShow(); await sleep(300);
      await recalc(); await sleep(200);
      before = await boxOf('#ask');
    }
    const beforeInk = await inkScan(before, 'ask/rightEdge/before');
    // 手工把 --pop-shift 往内（右）推 22px：模拟「给阴影留余量」
    // 22 而不是 12 —— peek 那组实测阴影外扩 **21.5px**（不是按 blur/2 推的 13px）。
    const cur = parseFloat(String(before.popShift)) || 0;
    await js(`(() => { document.querySelector('#stage').style
                .setProperty('--pop-shift', ${cur + 22} + 'px'); return 1; })()`);
    await sleep(250);
    const after = await boxOf('#ask');
    const afterInk = await inkScan(after, 'ask/rightEdge/padded22');
    const fbp = win.getBounds();
    RESULTS.padTest = { before, beforeInk, after, afterInk,
                        frameX: fbp.x, waX: wa.x,
                        // 修后盒子屏幕左缘：负数 = 正文出屏，这就是「拿正文换阴影」的代价
                        afterScreenL: after && after.L != null ? Math.round(after.L + fbp.x) : null };
    log({ ev: 'padTest', before, beforeInk, after, afterInk, frameX: fbp.x,
          afterScreenL: RESULTS.padTest.afterScreenL });

    // 靶 D：记事本的落点 —— 3 个横向位置 × 2 种竖直布局（edge-below / edge-above）
    // ⚠️ 上一轮只量到 edge-below 一种（placeCat 把猫钉在屏幕上半）。`bottom:96px` 在两种
    //    布局下落点完全不同，只量一种就下结论是 §三 同款盲区。
    //    猫在屏幕**下**半 → 上方余量够 → chooseRestingLayout 应给 'above'（猫在帧底）。
    for (const [vtag, catY] of [
      ['below', wa.y + 120],                       // 猫靠屏幕上部 → 弹窗只能在下
      ['above', wa.y + wa.height - 240],           // 猫靠屏幕下部 → 弹窗在上，猫贴帧底
    ]) {
      for (const [tag, catX] of [
        ['center', wa.x + Math.round(wa.width / 2)],
        ['rightEdge', wa.x + wa.width - 120],
        ['leftEdge', wa.x],
      ]) {
        await reset(); await sleep(250);
        seed('ask', 'np' + (++uid)); await sleep(700);
        await placeCat(catX, catY);
        await sleep(300);
        const fb = win.getBounds();
        const pad = padVerdict(await padBox(), fb.x, fb.y);
        RESULTS['pad_' + vtag + '_' + tag] = pad;
        log({ ev: 'notepad', layout: vtag, pos: tag, catX, catY,
              frameX: fb.x, frameY: fb.y, frameH: fb.height, pad });
      }
    }

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const brief = (k) => {
      const r = RESULTS[k]; if (!r || !r.ink || r.ink.err) return String(r && r.ink && r.ink.err || 'n/a');
      return { L: r.ink.leftInk_css, R: r.ink.rightInk_css,
               boxL: r.ink.boxL_css, boxR: r.ink.boxR_css,
               insideA: [r.ink.insideLeftAlpha, r.ink.insideRightAlpha],
               alphaOK: r.ink.alphaTrustworthy, farA: r.ink.farAlpha };
    };
    log({ SUMMARY: {
      peek: { center: brief('peek_center'), rightEdge: brief('peek_rightEdge'), leftEdge: brief('peek_leftEdge') },
      ask: { center: brief('ask_center'), rightEdge: brief('ask_rightEdge'), leftEdge: brief('ask_leftEdge') },
      padTest: RESULTS.padTest && RESULTS.padTest.beforeInk && !RESULTS.padTest.beforeInk.err ? {
        beforeInk: [RESULTS.padTest.beforeInk.leftInk_css, RESULTS.padTest.beforeInk.rightInk_css],
        afterInk: [RESULTS.padTest.afterInk.leftInk_css, RESULTS.padTest.afterInk.rightInk_css],
        beforeBoxL: RESULTS.padTest.before.L, afterBoxL: RESULTS.padTest.after.L,
        afterScreenL: RESULTS.padTest.afterScreenL,
        frameX: RESULTS.padTest.frameX, waX: RESULTS.padTest.waX,
      } : 'n/a',
      notepad: {
        below: { center: RESULTS.pad_below_center, rightEdge: RESULTS.pad_below_rightEdge,
                 leftEdge: RESULTS.pad_below_leftEdge },
        above: { center: RESULTS.pad_above_center, rightEdge: RESULTS.pad_above_rightEdge,
                 leftEdge: RESULTS.pad_above_leftEdge },
      },
      askDiag: { center: RESULTS.ask_center && RESULTS.ask_center.diag,
                 forced: RESULTS.ask_center && RESULTS.ask_center.forced },
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_SHADOW ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_SHADOW')) runProbeShadow();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_SHADOW')) app.dock.hide(); } catch {}"


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
        env.update({"WORKMEOW_PROBE_SHADOW": "1", "HOME": "/tmp/wm-probe-home",
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
            out, _ = proc.communicate(timeout=20)
        for line in out.splitlines():
            if "PROBE_SHADOW" in line:
                print(line)
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:
            pass
        shutil.copy(BAK, MAIN)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        print("restored main.js, node --check rc=" + str(chk.returncode))
        print(subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                             capture_output=True, text=True).stdout.strip() or "(worktree clean)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
