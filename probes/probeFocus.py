#!/usr/bin/env python3
# H1 第三轮探针。前两轮的结论与它们的**盲区**：
#   probeEdge：帧宽恒 520（连 0 会话也是，restingFrameWidth 的 Math.max(POPUP_W,…)
#     下限就是 520 —— 我此前「静息宽 < 520 会 resize」的推断被自己的数据证伪）。
#     但抓到左键独有的差异：chip 在左缘时左键那段有两个位置（相差 5.5px），右键只有一个。
#   probeFlash：setBounds 零次调用、iw/ih/catPos/opacity 全逐帧恒定。**但 blur 只记到 1 次** ——
#     因为 sendInputEvent 不给窗口焦点，w.blur() 是空操作。真机上用户点猫会真聚焦窗口，
#     closePeek 的 blurPet 那下才是**真**失焦。这跟 G1 当初的教训同形：合成事件绕过 NSWindow 层。
#
# 这轮补掉那个盲区：每次点击**之前先 win.focus()**，让 w.blur() 成为真状态变化，
# 且不动用户的真实光标（不用 CGEvent）。同时：
#   - 每轮硬断言 peek 真的打开过（peekOpen && height>0），不允许空转式假通过；
#   - 采样加 chip 与 --chip-shift（probeEdge 抓到的那个 5.5px 是唯一的左键独有信号）；
#   - 记 win.isFocused() 的逐次变化 + 主进程 setBounds/blur/evt 全打桩。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeFocus.bak"

PROBE = r"""
// ==== PROBE_FOCUS (临时) ====
function runProbeFocus() {
  const log = (o) => console.log('PROBE_FOCUS ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;

    const M = []; let t0 = Date.now();
    const origSetBounds = win.setBounds.bind(win);
    win.setBounds = function (b, ...r) {
      M.push({ t: Date.now() - t0, op: 'setBounds', b: { x: b.x, y: b.y, w: b.width, h: b.height } });
      return origSetBounds(b, ...r); };
    const origBlur = win.blur.bind(win);
    win.blur = function (...a) { M.push({ t: Date.now() - t0, op: 'blur()' }); return origBlur(...a); };
    win.on('blur', () => M.push({ t: Date.now() - t0, op: 'evt:blur' }));
    win.on('focus', () => M.push({ t: Date.now() - t0, op: 'evt:focus' }));
    win.on('resize', () => { const b = win.getBounds();
      M.push({ t: Date.now() - t0, op: 'evt:resize', b: { x: b.x, y: b.y, w: b.width, h: b.height } }); });
    win.on('move', () => { const b = win.getBounds();
      M.push({ t: Date.now() - t0, op: 'evt:move', b: { x: b.x, y: b.y, w: b.width, h: b.height } }); });

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
      lastStats = snap; wc.send(IPC.PET_STATS, snap); return true; };

    const INSTALL = `(() => {
      window.__P = { fr: [], on: false, t0: 0, marks: [] };
      const rect = (sel) => { const n = document.querySelector(sel);
        if (!n) return 'missing';
        if (n.classList.contains('hidden') || n.hidden) return 'hidden';
        const r = n.getBoundingClientRect(); const cs = getComputedStyle(n);
        return [Math.round(r.left*10)/10, Math.round(r.top*10)/10,
                Math.round(r.width*10)/10, Math.round(r.height*10)/10,
                Math.round(parseFloat(cs.opacity)*100)/100]; };
      const tick = () => { if (!window.__P.on) return;
        const s = getComputedStyle(document.querySelector('#stage'));
        window.__P.fr.push({ t: Math.round((performance.now() - window.__P.t0)*10)/10,
          iw: window.innerWidth, ih: window.innerHeight,
          cat: rect('#cat'), chip: rect('#chip'), peek: rect('#peek'), radial: rect('#radial'),
          ps: s.getPropertyValue('--pop-shift').trim(), cshift: s.getPropertyValue('--chip-shift').trim(),
          vis: document.visibilityState, af: document.hasFocus() ? 1 : 0 });
        requestAnimationFrame(tick); };
      window.__Pstart = () => { window.__P.fr = []; window.__P.marks = []; window.__P.on = true;
        window.__P.t0 = performance.now(); requestAnimationFrame(tick); };
      window.__Pmark = (s) => window.__P.marks.push([Math.round((performance.now()-window.__P.t0)*10)/10, s]);
      window.__Pstop = () => { window.__P.on = false; return { fr: window.__P.fr, marks: window.__P.marks }; };
      window.__Popen = () => { const n = document.querySelector('#peek');
        return { hidden: n.classList.contains('hidden'), h: Math.round(n.getBoundingClientRect().height) }; };
      window.__Radial = () => { const n = document.querySelector('#radial');
        return { hidden: n.classList.contains('hidden'), h: Math.round(n.getBoundingClientRect().height) }; };
      return 'ok'; })()`;
    log({ ev: 'install', r: await js(INSTALL) });

    const placeCat = async (catScreenX) => {
      const b = win.getBounds(); const inset = (b.width - 120) / 2;
      origSetBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height/2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(450); };
    const catBox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
    // ★ 关键：点击前先真聚焦窗口，让 closePeek 里的 w.blur() 成为真状态变化。
    const clickCat = async (button) => {
      try { win.focus(); } catch {}
      await sleep(120);
      const b = await catBox();
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); };

    const analyze = (out) => {
      const fr = out.fr || [];
      const uniq = (f) => [...new Set(fr.map(f))];
      const gaps = [];
      for (let i = 1; i < fr.length; i++) { const d = Math.round((fr[i].t - fr[i-1].t)*10)/10;
        if (d > 32) gaps.push({ at: fr[i-1].t, gap: d }); }
      const catV = uniq(f => JSON.stringify(f.cat));
      const chipV = uniq(f => JSON.stringify(f.chip));
      // 猫的横向位移幅度（窗内）
      const xs = fr.map(f => Array.isArray(f.cat) ? f.cat[0] : null).filter(v => v !== null);
      const ys = fr.map(f => Array.isArray(f.cat) ? f.cat[1] : null).filter(v => v !== null);
      const cxs = fr.map(f => Array.isArray(f.chip) ? f.chip[0] : null).filter(v => v !== null);
      const rng = (a) => a.length ? [Math.min(...a), Math.max(...a), Math.round((Math.max(...a)-Math.min(...a))*10)/10] : null;
      return { n: fr.length, gaps32: gaps,
               iw: uniq(f => f.iw), ih: uniq(f => f.ih),
               catXrange: rng(xs), catYrange: rng(ys), chipXrange: rng(cxs),
               catVariants: catV.length > 5 ? catV.length : catV,
               chipVariants: chipV.length > 5 ? chipV.length : chipV,
               popShift: uniq(f => f.ps), chipShift: uniq(f => f.cshift),
               vis: uniq(f => f.vis), docFocus: uniq(f => f.af),
               catGone: fr.filter(f => f.cat === 'hidden' || f.cat === 'missing').length,
               marks: out.marks }; };

    for (const [label, catX] of [['左缘', wa.x], ['中间', wa.x + Math.round(wa.width/2)],
                                 ['右缘', wa.x + wa.width - 120]]) {
      for (let round = 0; round < 2; round++) {
        seed(2); await sleep(300);
        await placeCat(catX);

        // ── 左键 peek（closePeek → blurPet + resetPetSize）
        M.length = 0; t0 = Date.now();
        await js('window.__Pstart()');
        await js(`window.__Pmark('focus+open')`);
        await clickCat('left'); await sleep(700);
        const opened = await js('window.__Popen()');
        await js(`window.__Pmark('close')`);
        await clickCat('left'); await sleep(900);
        const closed = await js('window.__Popen()');
        const L = analyze(await js('window.__Pstop()'));
        const mainL = M.slice();
        if (opened && opened.hidden) { log({ ev: 'FATAL', why: 'peek 没打开，本轮数据作废', label, round, opened }); }

        await sleep(300);

        // ── 右键 radial（对照：closeRadial 不调 blurPet / resetPetSize）
        M.length = 0; t0 = Date.now();
        await js('window.__Pstart()');
        await js(`window.__Pmark('focus+open')`);
        await clickCat('right'); await sleep(700);
        const rOpened = await js('window.__Radial()');
        await js(`window.__Pmark('close')`);
        await clickCat('right'); await sleep(900);
        const R = analyze(await js('window.__Pstop()'));
        const mainR = M.slice();

        log({ ev: 'focusFlash', label, round,
              peekOpened: opened, peekClosed: closed, radialOpened: rOpened,
              LEFT: L, LEFT_main: mainL, RIGHT: R, RIGHT_main: mainR });
        await sleep(200);
      }
    }
    log({ ev: 'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_FOCUS ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_FOCUS')) runProbeFocus();\n"


def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor not found"
        open(MAIN, "w", encoding="utf-8").write(src.replace(TRIGGER, TRIGGER_NEW, 1) + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_FOCUS": "1", "HOME": "/tmp/wm-probe-home",
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
            print("!!! TIMEOUT"); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_FOCUS" in line: print(line)
        if "PROBE_FOCUS" not in blob:
            print("--- no probe output; tail ---"); print(blob[-4000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node", "--check", MAIN], check=True)
        print("restored main.js")


main()
