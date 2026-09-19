#!/usr/bin/env python3
# 探针 #21：平台事实题 —— 「窗口原点位移」和「窗口内容变化」在什么条件下**原子**落地？
#
# 背景：探针 #20 用像素级抓屏确认了 H3 的两进程拆分会在屏幕上画出 1–3 帧错位
#       （猫瞬移 −catShift，三个贴边靶全中，拆解式 = 新帧原点 + 旧帧内偏移）。
#       任何「先 A 后 B」都抖、只是符号相反，所以必须让两者原子落地。
#       pet.js:927-929 声称 resize 事件是这样一条原子通道。这里验它。
#
# ── 四组对照（都用像素抓屏量真实屏幕位置，与 #20 同一把尺）──────────────────
#   BASE : 只移原点，内容不变                  → 预期干净（整窗平移，没有内容要追）
#   H3   : 渲染端写 style.left=+D，再 setBounds x-=D（**现行做法**）→ 预期抖（#20 已证）
#   REV  : 先 setBounds x-=D，再写 style.left=+D                 → 预期抖（反向）
#   GROW : setBounds 同时 width+=2D 且 x-=D，内容靠 **flex 居中**自然右移 D
#          → 这是候选修法。resize 若真与原点位移同帧提交，这组应当干净。
#   GROW2: 同 GROW，但内容偏移在渲染端 resize 事件里显式写（模拟 applyPendingEdgeLayout）
#
#   每组重复 ROUNDS 轮、正反各一次，取品红块最左列的众数作基线，
#   |偏离| > 3px 的帧即「屏幕上真的移了」。
#
# ⚠️ 这是**平台行为**测试，不走产品代码：探针自建一个窗口、自己摆一个品红块，
#    不碰 pet.js / main.js 的任何布局逻辑。这样结论只关于 Electron+macOS 本身，
#    不被产品那堆耦合污染。因此**不需要改写 main.js**，独立 app 直接跑。

import os, subprocess, signal, json

TMPAPP = "/tmp/wm-probe-atomic"

MAIN_JS = r"""
const { app, BrowserWindow, screen, desktopCapturer, systemPreferences } = require('electron');
const { performance } = require('perf_hooks');
const path = require('path');

const log = (o) => console.log('PROBE_ATOMIC ' + JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROUNDS = 6;     // 每组正反各 ROUNDS 次（抓屏会漏帧，靠重复提高命中）
const D = 50;         // 位移量，与 .ask 贴边时的 catShift 同量级
const TH = 3;         // 屏幕横移门槛 px

app.whenReady().then(async () => {
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  log({ ev: 'display', bounds: disp.bounds, wa, sf: disp.scaleFactor,
        tcc: systemPreferences.getMediaAccessStatus('screen') });

  // ── 被测窗口：和桌宠同构（透明、无边框、置顶、520 宽），里面一个品红块靠 flex 居中 ──
  const FRAME_W = 520, FRAME_H = 300, BLOCK = 120;
  const target = new BrowserWindow({
    width: FRAME_W, height: FRAME_H,
    x: Math.round(wa.x + wa.width - 60 - (FRAME_W - BLOCK) / 2),
    y: Math.round(wa.y + wa.height / 2 - FRAME_H / 2),
    frame: false, transparent: true, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  target.setAlwaysOnTop(true, 'screen-saver');
  target.setIgnoreMouseEvents(true);
  await target.loadFile(path.join(__dirname, 'target.html'));
  const tjs = async (c) => { try { return await target.webContents.executeJavaScript(c, true); } catch (e) { return { error: String(e) }; } };

  // ── 抓屏窗口 ──
  const capWin = new BrowserWindow({ width: 240, height: 80, x: wa.x + 10, y: wa.y + 10,
    show: true, title: 'atomic-cap',
    webPreferences: { nodeIntegration: false, contextIsolation: true } });
  await capWin.loadFile(path.join(__dirname, 'cap.html'));
  const cjs = async (c) => { try { return await capWin.webContents.executeJavaScript(c, true); } catch (e) { return { error: String(e) }; } };

  const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  const src = srcs.find((s) => String(s.display_id) === String(disp.id)) || srcs[0];
  log({ ev: 'source', n: src && src.name, d: src && src.display_id });

  const b0 = target.getBounds();
  const geom = await tjs(`(() => { const r = document.getElementById('blk').getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
  log({ ev: 'geom', geom, bounds: b0 });

  const info = await cjs('window.__capStart(' + JSON.stringify({
    sourceId: src.id, dispX: disp.bounds.x, dispY: disp.bounds.y,
    dispW: disp.bounds.width, dispH: disp.bounds.height,
    bandTop: b0.y + geom.top + geom.h / 2 - 6, bandH: 12,
  }) + ')');
  log({ ev: 'capStart', info });
  await sleep(800);

  const analyze = (rows, label) => {
    const ok = rows.filter((r) => r[1] != null && r[3] > 20);
    if (!ok.length) return { label, err: 'no magenta', totalRows: rows.length, sample: rows.slice(0, 3) };
    const cnt = new Map();
    for (const r of ok) { const k = Math.round(r[1]); cnt.set(k, (cnt.get(k) || 0) + 1); }
    let base = null, bestN = -1;
    for (const [v, n] of cnt) if (n > bestN) { bestN = n; base = v; }
    let bad = 0, maxDev = 0; const samples = [];
    const t0 = ok[0][0];
    for (const r of ok) {
      const dev = Math.round((r[1] - base) * 10) / 10;
      if (Math.abs(dev) > TH) { bad++;
        if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
        if (samples.length < 8) samples.push({ dtMs: Math.round(r[0] - t0), dev, minX: r[1], px: r[3] }); }
    }
    const span = ok[ok.length - 1][0] - t0;
    return { label, frames: ok.length, fps: Math.round(ok.length / Math.max(0.001, span / 1000) * 10) / 10,
             base, baseFrames: bestN, distinct: [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
             badFrames: bad, maxDevPx: maxDev, samples };
  };

  const home = target.getBounds();
  // ⚠️ 必须用 ${v} 插值：模板串是注入到**页面上下文**里执行的，主进程的局部变量 v
  //    在那边不存在 → 裸写 v 会抛 ReferenceError，而 tjs 把异常吞成 {error}。
  //    第一版就栽在这：H3/REV 两组的 setLeft 全部无声失败、退化成 BASE，
  //    比例（31%）和 BASE 一模一样才暴露出来。所以**每个注入调用都要断言返回值**。
  const setLeft = async (v) => {
    const r = await tjs(`(() => { const b = document.getElementById('blk');
      b.style.position = ${v} ? 'relative' : ''; b.style.left = ${v} ? (${v} + 'px') : '';
      const rc = b.getBoundingClientRect();
      // 预期位置按**当前帧宽**算：块是 flex 居中的，帧宽变了居中位也变。
      // （第二版断言写死 want=200，GROW 的 restore 里帧还是 620 宽、块在 250，误报 FATAL。）
      return { styleLeft: b.style.left, rectLeft: Math.round(rc.left * 10) / 10,
               innerW: window.innerWidth,
               want: Math.round(((window.innerWidth - rc.width) / 2 + ${v}) * 10) / 10 }; })()`);
    if (!r || r.error || Math.abs(r.rectLeft - r.want) > 1) {
      log({ FATAL: 'setLeft 没生效', v, got: r }); app.exit(1);
      throw new Error('setLeft failed');
    }
    return r;
  };
  // 先把帧恢复原状、再清偏移：顺序反了的话 setLeft(0) 会在宽帧下断言，虽然按
  // 上面的算法也能过，但恢复顺序统一成「帧→内容」更接近产品的关窗路径。
  const restore = async () => { target.setBounds({ ...home }); await sleep(120);
                                await setLeft(0); await sleep(400); };

  const MODES = {
    // 阳性对照：只移原点、内容不补 → 屏幕上**本来就该**整块移 −D。
    // 它不是「抖」，是量法自证：这把尺子测得出 50px 的横移。
    BASE: async () => { target.setBounds({ ...home, x: home.x - D }); },
    // 现行 H3：渲染端先写帧内偏移 +D，主进程再反向移帧 −D（宽度不变 → 无 resize）。
    // 净位移 0，所以**任何**偏离帧都是抖动。
    H3: async () => { await setLeft(D); target.setBounds({ ...home, x: home.x - D }); },
    // 反序：先移帧再写偏移。净位移同样 0。
    REV: async () => { target.setBounds({ ...home, x: home.x - D }); await setLeft(D); },
    // ★ 候选修法：**对称**加宽 —— x -= D 且 width += 2D。
    //   帧中心 = (x0-D) + (w0+2D)/2 = x0 + w0/2，**中心不变** → flex 居中的内容
    //   原地不动，一次 setBounds 搞定，**完全不需要 catShift**。
    //   左墙同时外扩 D，正好给贴右缘的弹窗腾出溢出空间。
    GROW: async () => { target.setBounds({ x: home.x - D, y: home.y,
                                           width: home.width + 2 * D, height: home.height }); },
    // 负对照：**只朝左**加宽（x -= D, width += D）。中心移 −D/2 → 内容得补 +D/2，
    //   又回到两阶段。用来证明「免补偿」这个性质来自**对称**，不是来自 resize 本身。
    ASYM: async () => { await setLeft(D / 2);
                        target.setBounds({ x: home.x - D, y: home.y,
                                           width: home.width + D, height: home.height }); },
  };
  const EXPECT_MOVE = { BASE: true, H3: false, REV: false, GROW: false, ASYM: false };

  const results = {};
  for (const name of Object.keys(MODES)) {
    await restore();
    await cjs('window.__capClear()'); await sleep(400);
    const restA = analyze(await cjs('(window.__capRows||[]).slice()'), name + '/静息');

    await cjs('window.__capClear()');
    for (let i = 0; i < ROUNDS; i++) {
      await MODES[name]();
      await sleep(420);
      await restore();
      await sleep(420);
    }
    const a = analyze(await cjs('(window.__capRows||[]).slice()'), name);
    results[name] = { rest: restA, run: a, expectMove: EXPECT_MOVE[name] };
    log({ ev: 'mode', name, expectMove: EXPECT_MOVE[name], rest: restA, run: a });
  }

  await cjs('window.__capStop()');
  try { capWin.destroy(); } catch {}
  try { target.destroy(); } catch {}

  const verdict = [];
  for (const n of Object.keys(results)) {
    const r = results[n];
    if (r.rest.err) verdict.push('⚠️ ' + r.rest.label + '：' + r.rest.err);
    else verdict.push((r.rest.badFrames ? '⚠️ 静息就不稳 ' : '✓ 静息稳 ') + r.rest.label
      + '：' + r.rest.badFrames + '/' + r.rest.frames + ' 帧');
    const A = r.run;
    if (A.err) { verdict.push('⚠️ ' + A.label + '：' + A.err); continue; }
    const pct = Math.round(A.badFrames / A.frames * 100);
    if (r.expectMove) {
      // 阳性对照：**必须**看到 ≈ −D 的横移，且占比接近 hold 时长占比（420/1340≈31%）。
      // 看不到就说明这把尺子测不出 50px 位移，后面所有「干净」结论一律作废。
      const ok = A.badFrames > 0 && Math.abs(Math.abs(A.maxDevPx) - D) <= 2;
      verdict.push((ok ? '✓ 量法自证通过 ' : '⚠️ 量法失效 ') + A.label
        + '（设计上就该移 −' + D + 'px）：' + A.badFrames + '/' + A.frames + ' 帧 = ' + pct
        + '%，最大 ' + A.maxDevPx + 'px（' + A.fps + 'fps）');
    } else {
      // 净位移 0 的组：任何偏离帧都是抖动。
      verdict.push((A.badFrames > 0 ? '★★ 抖 ' : '✓ 原子·不抖 ') + A.label
        + '（净位移应为 0）：' + A.badFrames + '/' + A.frames + ' 帧 = ' + pct
        + '%，最大 ' + A.maxDevPx + 'px（基线 ' + A.base + '，' + A.fps + 'fps）'
        + (A.badFrames ? '  分布 ' + JSON.stringify(A.distinct) : ''));
    }
  }
  log({ ev: 'SUMMARY', verdict });
  log({ ev: 'done' });
  app.exit(0);
}).catch((e) => { log({ FATAL: String(e && e.stack || e) }); app.exit(1); });
"""

TARGET_HTML = r"""<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent}
  /* 和 #stage 同构：flex 居中，块不设 left → 对称加宽帧时块自然原地不动 */
  #stage{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}
  #blk{width:120px;height:120px;background:#ff00ff}
</style>
<body><div id="stage"><div id="blk"></div></div></body>
"""

CAP_HTML = r"""<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#111;color:#0f0;font:11px monospace">atomic-cap</body>
<script>
window.__capStart = async (opt) => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: opt.sourceId,
                          maxWidth: 4096, maxHeight: 4096, maxFrameRate: 60 } } });
  const v = document.createElement('video');
  v.srcObject = stream; v.muted = true; await v.play();
  for (let i = 0; i < 100 && !v.videoWidth; i++) await new Promise(r => setTimeout(r, 30));
  const scale = v.videoWidth / opt.dispW;
  const sy = Math.max(0, Math.round((opt.bandTop - opt.dispY) * scale));
  const sh = Math.max(1, Math.round(opt.bandH * scale));
  const sw = v.videoWidth;
  const cv = document.createElement('canvas'); cv.width = sw; cv.height = sh;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  window.__capInfo = { vw: v.videoWidth, vh: v.videoHeight, scale, sy, sh };
  window.__capRows = []; window.__capOn = true;
  const T0 = performance.timeOrigin;
  const grab = () => {
    if (!window.__capOn) { try { stream.getTracks().forEach(t => t.stop()); } catch {} return; }
    try {
      ctx.drawImage(v, 0, sy, sw, sh, 0, 0, sw, sh);
      const d = ctx.getImageData(0, 0, sw, sh).data;
      let minX = -1, maxX = -1, n = 0;
      for (let y = 0; y < sh; y++) { const base = y * sw * 4;
        for (let x = 0; x < sw; x++) { const i = base + x * 4;
          if (d[i] > 200 && d[i+1] < 60 && d[i+2] > 200) { n++;
            if (minX < 0 || x < minX) minX = x; if (x > maxX) maxX = x; } } }
      window.__capRows.push([T0 + performance.now(),
        minX < 0 ? null : Math.round((opt.dispX + minX / scale) * 10) / 10,
        maxX < 0 ? null : Math.round((opt.dispX + maxX / scale) * 10) / 10, n]);
    } catch (e) { window.__capRows.push([T0 + performance.now(), null, null, -1, String(e)]); }
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(grab); else requestAnimationFrame(grab);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(grab); else requestAnimationFrame(grab);
  return window.__capInfo;
};
window.__capStop = () => { window.__capOn = false; return window.__capRows || []; };
window.__capClear = () => { window.__capRows = []; return 1; };
</script>
"""


def main():
    os.makedirs(TMPAPP, exist_ok=True)
    open(os.path.join(TMPAPP, "main.js"), "w", encoding="utf-8").write(MAIN_JS)
    open(os.path.join(TMPAPP, "target.html"), "w", encoding="utf-8").write(TARGET_HTML)
    open(os.path.join(TMPAPP, "cap.html"), "w", encoding="utf-8").write(CAP_HTML)
    open(os.path.join(TMPAPP, "package.json"), "w", encoding="utf-8").write(
        json.dumps({"name": "wm-probe-atomic", "version": "1.0.0", "main": "main.js"}))

    chk = subprocess.run(["node", "--check", os.path.join(TMPAPP, "main.js")],
                         capture_output=True, text=True)
    if chk.returncode != 0:
        print("ABORT: 探针自身语法错误:\n%s" % chk.stderr)
        return 1

    env = dict(os.environ)
    env["HOME"] = "/tmp/wm-probe-home"
    proc = subprocess.Popen(["npx", "electron", TMPAPP],
                            cwd="/Users/gaobinbin/Downloads/codes/WorkMeow",
                            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=400)
    except subprocess.TimeoutExpired:
        print("TIMEOUT 400s")
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
        if "PROBE_ATOMIC" in line:
            print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
