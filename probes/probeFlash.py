#!/usr/bin/env python3
# H1 聚焦探针。上一轮 probeEdge 的结论：帧宽恒 520（连 0 会话都是，restingFrameWidth 的
# Math.max(POPUP_W,…) 下限就是 520），猫的窗内矩形逐帧不变、catGoneFrames=0。
# 所以「喵也没了、然后再出现」不是 DOM 层位移/隐藏，只可能在合成器/窗口层。
#
# 这一层在渲染进程里只留一种痕迹：**rAF 掉帧**。所以这轮：
#   1) 输出完整逐帧间隔，找 >32ms 的尖峰（正常 ~16ms），标出尖峰相对「关气泡」的时刻；
#   2) 给主进程的 win.setBounds 打桩，记下每一次调用的实参 + 调用栈里的函数名；
#   3) 记 win.blur() 的时刻；
#   4) 左键（走 blurPet + resetPetSize）与右键（都不走）对照，尖峰若只出现在左键 → 定案。
#
# 只测「猫在左缘」这一种位置（帧 x = -200，悬出屏幕，最容易触发 macOS 重排）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeFlash.bak"

PROBE = r"""
// ==== PROBE_FLASH (临时) ====
function runProbeFlash() {
  const log = (o) => console.log('PROBE_FLASH ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;

    // ── 主进程侧打桩：setBounds / blur 的每一次调用 ────────────────────────
    const MAINLOG = [];
    let t0 = Date.now();
    const origSetBounds = win.setBounds.bind(win);
    win.setBounds = function (b, ...rest) {
      const st = new Error().stack.split('\n').slice(2, 5)
        .map(s => (s.match(/at ([\w.<>]+)/) || [,'?'])[1]).join('<');
      MAINLOG.push({ t: Date.now() - t0, op: 'setBounds', b: { x: b.x, y: b.y, w: b.width, h: b.height }, st });
      return origSetBounds(b, ...rest);
    };
    const origBlur = win.blur.bind(win);
    win.blur = function (...a) {
      const st = new Error().stack.split('\n').slice(2, 5)
        .map(s => (s.match(/at ([\w.<>]+)/) || [,'?'])[1]).join('<');
      MAINLOG.push({ t: Date.now() - t0, op: 'blur', st });
      return origBlur(...a);
    };
    win.on('blur', () => MAINLOG.push({ t: Date.now() - t0, op: 'evt:blur' }));
    win.on('focus', () => MAINLOG.push({ t: Date.now() - t0, op: 'evt:focus' }));
    win.on('resize', () => MAINLOG.push({ t: Date.now() - t0, op: 'evt:resize', b: win.getBounds() }));
    win.on('move', () => MAINLOG.push({ t: Date.now() - t0, op: 'evt:move', b: win.getBounds() }));

    const seed = (n) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return false; }
      const now = Date.now();
      const all = [
        { sessionId: 'p1', agent: 'claude', project: 'WorkMeow', state: 'working',
          headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12 },
        { sessionId: 'p2', agent: 'codex', project: 'other', state: 'waiting',
          headless: false, updatedAt: now, startedAt: now - 120000, tokens: 6789, cost: 0.07 },
      ];
      snap.sessions = all.slice(0, n);
      snap.workingCount = n > 0 ? 1 : 0; snap.waitingCount = n > 1 ? 1 : 0;
      snap.idleMs = 1000; snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return true;
    };

    // ── 渲染侧：逐帧 rAF 采样，重点是**帧间隔** ──────────────────────────
    const INSTALL = `(() => {
      window.__F = { fr: [], on: false, t0: 0, marks: [] };
      const tick = () => { if (!window.__F.on) return;
        const n = document.querySelector('#cat');
        const r = n ? n.getBoundingClientRect() : null;
        window.__F.fr.push([Math.round((performance.now() - window.__F.t0) * 10) / 10,
          window.innerWidth, window.innerHeight,
          r ? Math.round(r.left) : -1, r ? Math.round(r.top) : -1,
          n ? Math.round(parseFloat(getComputedStyle(n).opacity) * 100) / 100 : -1,
          document.visibilityState === 'visible' ? 1 : 0]);
        requestAnimationFrame(tick); };
      window.__Fstart = () => { window.__F.fr = []; window.__F.marks = []; window.__F.on = true;
        window.__F.t0 = performance.now(); requestAnimationFrame(tick); };
      window.__Fmark = (s) => { window.__F.marks.push([Math.round((performance.now() - window.__F.t0)*10)/10, s]); };
      window.__Fstop = () => { window.__F.on = false;
        return { fr: window.__F.fr, marks: window.__F.marks }; };
      return 'ok'; })()`;
    log({ ev: 'install', r: await js(INSTALL) });

    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      origSetBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height/2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(450);
    };
    const catBox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
    const clickCat = async (button) => { const b = await catBox();
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); };

    const analyze = (out) => {
      const fr = out.fr || [];
      const gaps = [];
      for (let i = 1; i < fr.length; i++) {
        const d = Math.round((fr[i][0] - fr[i-1][0]) * 10) / 10;
        if (d > 32) gaps.push({ at: fr[i-1][0], gap: d });
      }
      const iw = [...new Set(fr.map(f => f[1]))], ih = [...new Set(fr.map(f => f[2]))];
      const catPos = [...new Set(fr.map(f => f[3] + ',' + f[4]))];
      const op = [...new Set(fr.map(f => f[5]))];
      const vis = [...new Set(fr.map(f => f[6]))];
      const ds = fr.slice(1).map((f, i) => f[0] - fr[i][0]);
      const maxGap = ds.length ? Math.round(Math.max(...ds) * 10) / 10 : 0;
      return { n: fr.length, span: fr.length ? fr[fr.length-1][0] : 0, maxGap,
               gaps32: gaps, iw, ih, catPos, catOpacity: op, visible: vis, marks: out.marks };
    };

    for (const [label, catX] of [['左缘', wa.x], ['中间', wa.x + Math.round(wa.width/2)]]) {
      for (let round = 0; round < 3; round++) {
        seed(2); await sleep(300);
        await placeCat(catX);

        // ── 左键：peek（closePeek → blurPet + resetPetSize）
        MAINLOG.length = 0; t0 = Date.now();
        await js('window.__Fstart()');
        await js(`window.__Fmark('open-click')`);
        await clickCat('left'); await sleep(700);
        await js(`window.__Fmark('close-click')`);
        const closeAtMain = Date.now() - t0;
        await clickCat('left'); await sleep(900);
        const L = analyze(await js('window.__Fstop()'));
        const mainL = MAINLOG.slice();

        await sleep(300);

        // ── 右键：radial（closeRadial 不调 blurPet / resetPetSize）
        MAINLOG.length = 0; t0 = Date.now();
        await js('window.__Fstart()');
        await js(`window.__Fmark('open-click')`);
        await clickCat('right'); await sleep(700);
        await js(`window.__Fmark('close-click')`);
        await clickCat('right'); await sleep(900);
        const R = analyze(await js('window.__Fstop()'));
        const mainR = MAINLOG.slice();

        log({ ev: 'flash', label, round,
              LEFT: L, LEFT_main: mainL, closeAtMainMs: closeAtMain,
              RIGHT: R, RIGHT_main: mainR });
        await sleep(200);
      }
    }

    log({ ev: 'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_FLASH ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_FLASH')) runProbeFlash();\n"


def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor not found"
        open(MAIN, "w", encoding="utf-8").write(src.replace(TRIGGER, TRIGGER_NEW, 1) + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_FLASH": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        os.makedirs("/tmp/wm-probe-home", exist_ok=True)
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            blob, _ = proc.communicate(timeout=280)
        except subprocess.TimeoutExpired:
            print("!!! TIMEOUT")
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_FLASH" in line:
                print(line)
        if "PROBE_FLASH" not in blob:
            print("--- no probe output; tail ---")
            print(blob[-4000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node", "--check", MAIN], check=True)
        print("restored main.js")


main()
