#!/usr/bin/env python3
# 探针 #23：定位 H4 之后**开窗**残留的那一帧抖动（关窗已 0 偏离）。
#
# #22 实测（e5e27d6 对称加宽帧）：关窗四靶全 0，开窗四靶 +49/+50/±30/0。
# 偏离帧的**绝对坐标**与分布表逐一吻合：
#   A 旧x1120 新x1070 旧inset200 新inset250 → 异常值 1370 = 旧x+新inset
#   M 旧x-200 新x-250                      → 异常值   50 = 旧x+新inset
#   P 旧x1120 新x1090 旧inset200 新inset230 → 1350=旧x+新inset、1290=新x+旧inset
# 两个方向都抛到了 → “帧原点”与“帧宽（内容重居中）”没同帧落地。
#
# 但 probeAtomic 的 GROW 组测的正是同一件事（x-=D 且 width+=2D，flex 居中），
# 实测 0/151 干净。两者矛盾 → 真实路径上一定还有别的东西：
#   假设 1：fitPopup 两拍发了**两笔** setBounds，第一拍宽度估低（退化 520）、
#             第二拍才加宽 → 两笔之隙就是那一帧。
#   假设 2：只一笔，但弹窗内容同时插入/重排，把 resize 的同步提交打断。
#   假设 3：第二笔来自 keepCatOnScreen / restoreWindowOrigin（抢着改原点）。
# 三个假设靠 site+参数一眼分得开。**不猜，把两边对到同一条时间轴上量。**
#
# ── 量法（#20 的像素尺 + #19 的 setBounds 记账，合成一条轴）───────────
#   · 像素：抓屏逐帧扫品红块最左列（唯一“用户眼睛看到的”尺子）
#   · 记账：旁路包住 win.setBounds，记 (t,tEnd,reqX,reqW,before→after,site)
#   两边时间戳都取 performance.timeOrigin + performance.now()，同一时钟。
#   判据：把每个偏离帧夹到它前后两笔 setBounds 之间，看落在哪一段。
#     落在两笔之间 → 假设 1/3，合成一笔即可修
#     落在同一笔的 t..tEnd 内或其后 → 假设 2，得换机制
#
# ⚠️ 只临时改写 main.js。renderer/pet.js 零注入（跑前自证 git diff 为空）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeWhich.bak"
CAPHTML = "/tmp/wm-probe-cap23.html"

CAP_HTML = r"""<!doctype html><meta charset="utf-8"><title>cap</title>
<body style="margin:0;background:#111;color:#0f0;font:11px monospace">cap</body>
<script>
window.__capStart = async (opt) => {
  // opt: { sourceId, dispX, dispY, dispW, dispH, bandTop, bandH }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: opt.sourceId,
                          maxWidth: 4096, maxHeight: 4096, maxFrameRate: 60 } },
  });
  const v = document.createElement('video');
  v.srcObject = stream; v.muted = true;
  await v.play();
  // 等到真的有尺寸
  for (let i = 0; i < 100 && !v.videoWidth; i++) await new Promise(r => setTimeout(r, 30));
  const scale = v.videoWidth / opt.dispW;          // retina 倍率
  const sy = Math.max(0, Math.round((opt.bandTop - opt.dispY) * scale));
  const sh = Math.max(1, Math.round(opt.bandH * scale));
  const sw = v.videoWidth;
  const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  window.__capInfo = { vw: v.videoWidth, vh: v.videoHeight, scale, sy, sh };
  window.__capRows = [];
  window.__capOn = true;
  const T0 = performance.timeOrigin;
  const grab = () => {
    if (!window.__capOn) { try { stream.getTracks().forEach(t => t.stop()); } catch {} return; }
    try {
      ctx.drawImage(v, 0, sy, sw, sh, 0, 0, sw, sh);
      const d = ctx.getImageData(0, 0, sw, sh).data;
      let minX = -1, maxX = -1, n = 0;
      for (let y = 0; y < sh; y++) {
        const base = y * sw * 4;
        for (let x = 0; x < sw; x++) {
          const i = base + x * 4;
          if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) {
            n++;
            if (minX < 0 || x < minX) minX = x;
            if (x > maxX) maxX = x;
          }
        }
      }
      window.__capRows.push([T0 + performance.now(),
        minX < 0 ? null : Math.round((opt.dispX + minX / scale) * 10) / 10,
        maxX < 0 ? null : Math.round((opt.dispX + maxX / scale) * 10) / 10, n]);
    } catch (e) { window.__capRows.push([T0 + performance.now(), null, null, -1, String(e)]); }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(grab);
    else requestAnimationFrame(grab);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(grab);
  else requestAnimationFrame(grab);
  return window.__capInfo;
};
window.__capStop = () => { window.__capOn = false; return window.__capRows || []; };
window.__capClear = () => { window.__capRows = []; return 1; };
</script>
"""

PROBE = r"""
// ==== PROBE_WHICH (临时) ====
function runProbeWhich() {
  const log = (o) => console.log('PROBE_WHICH ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const ROUNDS = 8;      // 每靶重复开关轮数（抓屏可能漏帧）
  const TH = 3;          // 屏幕横移门槛 px
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const disp = screen.getPrimaryDisplay();
    const wa = disp.workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    const { performance: perf } = require('perf_hooks');
    const mNow = () => perf.timeOrigin + perf.now();
    // setBounds 旁路记账（不改行为）。site 取栈第 2 行，用来分辨发起者。
    const sbLog = [];
    if (!win.__whHooked) {
      win.__whHooked = 1;
      const origSB = win.setBounds.bind(win);
      win.setBounds = function (bb, ...rest) {
        let bx = null, bw = null; try { const g = win.getBounds(); bx = g.x; bw = g.width; } catch {}
        const t = mNow();
        const r = origSB(bb, ...rest);
        const tEnd = mNow();
        let ax = null, aw = null; try { const g = win.getBounds(); ax = g.x; aw = g.width; } catch {}
        let site = ''; try { site = (new Error().stack.split('\n')[2] || '').trim().slice(0, 76); } catch {}
        sbLog.push({ t, tEnd, reqX: bb && bb.x, reqW: bb && bb.width, bx, bw, ax, aw, site });
        return r;
      };
    }
    log({ ev: 'display', bounds: disp.bounds, wa, sf: disp.scaleFactor });
    try { clearInterval(statsTimer); statsTimer = null; } catch {}

    // ── 抓屏窗口 ──
    const { BrowserWindow: BW, desktopCapturer: DC } = require('electron');
    const capWin = new BW({ width: 260, height: 90, x: Math.round(wa.x + 10), y: Math.round(wa.y + 10),
      show: true, alwaysOnTop: false, title: 'probe-cap',
      webPreferences: { nodeIntegration: false, contextIsolation: true } });
    await capWin.loadFile('/tmp/wm-probe-cap23.html');
    const cjs = async (code) => { try { return await capWin.webContents.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };

    const srcs = await DC.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    let src = srcs.find((s) => String(s.display_id) === String(disp.id)) || srcs[0];
    log({ ev: 'source', picked: src && src.name, id: src && src.id, display_id: src && src.display_id,
          all: srcs.map((s) => ({ n: s.name, d: s.display_id })) });
    if (!src) { log({ FATAL: 'no screen source' }); app.exit(1); return; }

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
        snap.sessions = [mk('ask-' + uid, 'waiting', { choice: {
          question: '贴边开关弹窗时,猫在屏幕上会不会横向瞬移?这条问题要够长,好让 .ask 撑到 340px 上限。',
          options: [{ id: 'yes', label: '不移' }, { id: 'no', label: '移了' }] } })];
        snap.workingCount = 0; snap.thinkingCount = 0; snap.waitingCount = 1; snap.needsinputCount = 1;
      } else {
        snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000; snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };
    const forceShow = () => js(`(() => { try {
      const items = (lastStats && lastStats.sessions || []).map((x) => x.choice).filter(Boolean);
      if (!items.length) return 'no choice';
      answered.clear(); askQueue = items; askIdx = 0; lastAskSig = '';
      showAskPanel(); return 'ok';
    } catch (e) { return 'threw: ' + String(e.stack || e); } })()`);
    const placeCat = async (catLeft) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catLeft - inset),
                      y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      return win.getBounds();
    };
    const cbox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`);
    const clickCat = async () => { const b = await cbox();
      if (!b || b.cx == null) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button: 'left', clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button: 'left', clickCount: 1 }); return true; };
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){}
      try{hideAsk()}catch(e){} return 1; })()`);

    // ── 给猫涂品红。只改 background，**不动几何**（background 不参与布局）──
    const paintCat = () => js(`(() => {
      let s = document.getElementById('__probePaint');
      if (!s) { s = document.createElement('style'); s.id = '__probePaint'; document.head.appendChild(s); }
      s.textContent = '#cat{background:#ff00ff !important;} #cat *{visibility:hidden !important;}';
      const r = document.querySelector('#cat').getBoundingClientRect();
      return { left: Math.round(r.left * 10) / 10, top: Math.round(r.top * 10) / 10,
               w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; })()`);

    log({ ev: 'focus', gotFocus: await grabFocus() });

    const analyze = (rows, label) => {
      const ok = rows.filter((r) => r[1] != null && r[3] > 20);
      if (!ok.length) return { label, err: 'no magenta frames', totalRows: rows.length,
        sample: rows.slice(0, 3) };
      const cnt = new Map();
      for (const r of ok) { const k = Math.round(r[1]); cnt.set(k, (cnt.get(k) || 0) + 1); }
      let base = null, bestN = -1;
      for (const [v, n] of cnt) if (n > bestN) { bestN = n; base = v; }
      let bad = 0, maxDev = 0; const samples = [];
      const t0 = ok[0][0];
      for (const r of ok) {
        const dev = Math.round((r[1] - base) * 10) / 10;
        if (Math.abs(dev) > TH) {
          bad++;
          if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
          if (samples.length < 12) samples.push({ dtMs: Math.round(r[0] - t0), dev,
            minX: r[1], maxX: r[2], px: r[3] });
        }
      }
      const span = ok[ok.length - 1][0] - t0;
      return { label, magentaFrames: ok.length, totalRows: rows.length,
               fps: Math.round(ok.length / Math.max(0.001, span / 1000) * 10) / 10,
               baseMinX: base, baseFrames: bestN,
               distinct: [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
               badFrames: bad, maxDevPx: maxDev, samples };
    };

    // 把每个偏离帧夹到前后 setBounds 之间。两边同一时钟（timeOrigin + now）。
    const correlate = (rows, sb, base) => {
      const bad = rows.filter((r) => r[1] != null && r[3] > 20 && Math.abs(r[1] - base) > TH);
      const out = [];
      for (const f of bad.slice(0, 8)) {
        const t = f[0];
        const prev = sb.filter((s) => s.t <= t).slice(-2);
        const next = sb.filter((s) => s.t > t).slice(0, 1);
        out.push({
          dev: Math.round((f[1] - base) * 10) / 10, minX: f[1],
          prev: prev.map((s) => ({ agoMs: Math.round((t - s.t) * 100) / 100,
            req: s.reqX + '/' + s.reqW, x: s.bx + '>' + s.ax, w: s.bw + '>' + s.aw,
            durMs: Math.round((s.tEnd - s.t) * 100) / 100, site: s.site })),
          next: next.map((s) => ({ inMs: Math.round((s.t - t) * 100) / 100,
            req: s.reqX + '/' + s.reqW, x: s.bx + '>' + s.ax, w: s.bw + '>' + s.aw, site: s.site })),
        });
      }
      return { badCount: bad.length, shown: out };
    };

    const results = {};
    const TARGETS = [
      { id: 'A', desc: '.ask 齐右缘', mode: 'ask', at: () => wa.x + wa.width - 60 },
      { id: 'M', desc: '.ask 齐左缘', mode: 'ask', at: () => wa.x - 60 },
      { id: 'P', desc: '.peek 齐右缘', mode: 'peek', at: () => wa.x + wa.width - 60 },
      { id: 'C', desc: '.ask 居中对照', mode: 'ask', at: () => wa.x + Math.round(wa.width / 2) },
    ];

    let capStarted = false;
    for (const T of TARGETS) {
      await reset(); await sleep(300);
      seed(T.mode === 'ask' ? 'ask' : 'peek', T.id);
      await sleep(400);
      await placeCat(T.at());
      await sleep(500);
      const geom = await paintCat();
      const b0 = win.getBounds();
      await sleep(300);

      if (!capStarted) {
        const info = await cjs('window.__capStart(' + JSON.stringify({
          sourceId: src.id, dispX: disp.bounds.x, dispY: disp.bounds.y,
          dispW: disp.bounds.width, dispH: disp.bounds.height,
          bandTop: b0.y + geom.top + geom.h / 2 - 6, bandH: 12,
        }) + ')');
        log({ ev: 'capStart', info });
        capStarted = true;
        await sleep(600);
      } else {
        // 换靶后猫的 y 没变（placeCat 固定同一个 y），带不用重开
        await cjs('window.__capClear()');
      }

      // 静息基准（不动任何东西，纯抓）
      await cjs('window.__capClear()'); await sleep(450);
      const restRows = await cjs('(window.__capRows || []).slice()');
      const restA = analyze(restRows, T.id + '/rest');

      // 开窗 × ROUNDS
      await cjs('window.__capClear()');
      const sbMark = sbLog.length;
      for (let i = 0; i < ROUNDS; i++) {
        if (T.mode === 'ask') { await js('(()=>{try{hideAsk()}catch(e){} return 1})()'); await sleep(70);
                                await forceShow(); }
        else { await clickCat(); }
        await sleep(900);
        if (i < ROUNDS - 1) { await reset(); await sleep(700); }
      }
      const openRows = await cjs('(window.__capRows || []).slice()');
      const openA = analyze(openRows, T.id + '/open×' + ROUNDS);
      const openSb = sbLog.slice(sbMark);
      const openCorr = openA.err ? { err: openA.err } : correlate(openRows, openSb, openA.baseMinX);
      log({ ev: 'sbLog', id: T.id, n: openSb.length,
            all: openSb.slice(0, 20).map((s) => ({ req: s.reqX + '/' + s.reqW,
              x: s.bx + '>' + s.ax, w: s.bw + '>' + s.aw,
              durMs: Math.round((s.tEnd - s.t) * 100) / 100, site: s.site })) });
      log({ ev: 'correlate', id: T.id, corr: openCorr });
      const openSnap = await js(`(() => { let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        let fw = null; try { fw = popupFrameWidth(); } catch (e) { fw = 'threw:' + String(e); }
        const row = document.querySelector('#compact-row');
        return { applied: ap, innerW: window.innerWidth, wantFrameW: fw,
                 rowLeft: row ? (row.style.left || '(空)') : null,
                 rowPos: row ? (row.style.position || '(空)') : null,
                 popShift: getComputedStyle(document.getElementById('stage')).getPropertyValue('--pop-shift').trim(),
                 frameW_main: null }; })()`);

      // 关窗 × ROUNDS（每轮先开好再关，只统计关的那段）
      await cjs('window.__capClear()');
      for (let i = 0; i < ROUNDS; i++) {
        await reset(); await sleep(800);
        if (T.mode === 'ask') { await forceShow(); } else { await clickCat(); }
        await sleep(800);
        await cjs('window.__capClear()');       // 丢掉开窗那段
        await reset();
        await sleep(900);
        if (i < ROUNDS - 1) {
          const part = await cjs('(window.__capRows || []).slice()');
          if (!results[T.id]) results[T.id] = {};
          (results[T.id].closeParts = results[T.id].closeParts || []).push(part.length);
        }
      }
      const closeRows = await cjs('(window.__capRows || []).slice()');
      const closeA = analyze(closeRows, T.id + '/close');

      results[T.id] = Object.assign(results[T.id] || {},
        { desc: T.desc, geom, frameX: b0.x, openApplied: openSnap, restA, openA, closeA });
      log({ ev: 'target', id: T.id, desc: T.desc, geom, frameX: b0.x, openSnap });
      log({ ev: 'rest', id: T.id, a: restA });
      log({ ev: 'open', id: T.id, a: openA });
      log({ ev: 'close', id: T.id, a: closeA });
      await reset(); await sleep(300);
      await js(`(() => { const s = document.getElementById('__probePaint'); if (s) s.textContent = ''; return 1; })()`);
    }

    await cjs('window.__capStop()');
    try { capWin.destroy(); } catch {}

    const verdict = [];
    for (const id of Object.keys(results)) {
      const r = results[id];
      verdict.push('— ' + id + ' ' + r.desc + '（帧原点 ' + r.frameX + '，开窗 catShift='
        + JSON.stringify(r.openApplied) + '）');
      for (const A of [r.restA, r.openA, r.closeA]) {
        if (A.err) { verdict.push('   ⚠️ ' + A.label + '：' + A.err); continue; }
        const tag = A.badFrames > 0 ? '★★ 屏幕上真的移了' : '✓ 像素级干净';
        verdict.push('   ' + tag + ' ' + A.label + '：' + A.badFrames + '/' + A.magentaFrames
          + ' 帧偏离，最大 ' + A.maxDevPx + 'px（基线 ' + A.baseMinX + ' 占 ' + A.baseFrames
          + ' 帧，抓屏 ' + A.fps + 'fps）');
        if (A.badFrames > 0) verdict.push('      分布 ' + JSON.stringify(A.distinct));
      }
    }
    log({ ev: 'SUMMARY', verdict });
    for (const id of Object.keys(results)) {
      log({ ev: 'detail', id, rest: results[id].restA, open: results[id].openA, close: results[id].closeA });
    }
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_WHICH')) runProbeWhich();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_WHICH')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js。先提交或 stash：")
        print(dirty)
        return 1

    open(CAPHTML, "w", encoding="utf-8").write(CAP_HTML)

    msrc = open(MAIN, encoding="utf-8").read()
    for needle in (TRIGGER, DOCK):
        n = msrc.count(needle)
        if n != 1:
            print("ABORT: main.js 锚点命中 %d 次（要求 1 次）:\n%s" % (n, needle))
            return 1

    shutil.copy(MAIN, BAK_MAIN)
    try:
        open(MAIN, "w", encoding="utf-8").write(
            msrc.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误:\n%s" % chk.stderr)
            return 1
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_WHICH": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=580)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 580s")
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
            if "PROBE_WHICH" in line:
                print(line)
    finally:
        shutil.copy(BAK_MAIN, MAIN)
        rc = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True).returncode
        print("restored main.js, node --check rc=%d" % rc)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)


if __name__ == "__main__":
    raise SystemExit(main())
