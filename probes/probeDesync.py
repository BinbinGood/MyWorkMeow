#!/usr/bin/env python3
# H1 第五轮。前四轮把**几何**全部排除：帧 x/y/w/h 在 2ms 轮询下零变化（含 AppKit 钳帧）、
# #cat 与 #cat-img 的 rect/display/opacity/src 逐帧恒定、setBounds 零调用。
#
# 这轮换靶：查 **穿透态的双份拷贝是否 desync**。
#   渲染端 pet.js:3460 有 `let mouseIgnoring`；主进程 main.js 有 `st.mouseIgnoring`。
#   releaseClickThrough（G1 的修法）只改**主进程**那份 + setIgnoreMouseEvents(false)，
#   没有任何 IPC 通知渲染端（SET_IGNORE_MOUSE 是单向 renderer→main，preload 无对应 on*）。
#   而 setMouseIgnore 首行是 `if (on === mouseIgnoring) return;` —— 渲染端那份仍是 true 时，
#   命中测试算出 on=true 会**直接 return，不发 IPC**。于是真实窗口停在「不穿透」，
#   而两边状态各说各话。
# 判据：关气泡后打印 (renderer mouseIgnoring, main st.mouseIgnoring)。若出现 (true,false)
#   → desync 确证。再把光标移到透明区，看渲染端会不会补发 IPC（预期：不会）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeDesync.bak"

PROBE = r"""
// ==== PROBE_DESYNC (临时) ====
function runProbeDesync() {
  const log = (o) => console.log('PROBE_DESYNC ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal:'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { error:String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}

    // 记录真实下发到 OS 的穿透调用
    const IGN = [];
    const origIgn = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = function (v, ...r) { IGN.push({ t: Date.now()%100000, v: !!v }); return origIgn(v, ...r); };

    const seed = () => { let s; try { s = buildStats('all'); } catch { return; }
      const now = Date.now();
      s.sessions = [{ sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
        headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 },
        { sessionId:'p2', agent:'codex', project:'other', state:'waiting',
        headless:false, updatedAt:now, startedAt:now-120000, tokens:6789, cost:0.07 }];
      s.workingCount=1; s.waitingCount=1; s.idleMs=1000;
      s.today={messages:42,tokens:19356,cost:0.2};
      lastStats=s; wc.send(IPC.PET_STATS, s); };

    // 渲染端那份 mouseIgnoring 是模块级 let，外部读不到 → 用 setIgnoreMouse 的调用痕迹反推
    await js(`(() => {
      window.__D = { sent: [] };
      const orig = window.pet.setIgnoreMouse;
      window.pet.setIgnoreMouse = (v) => { window.__D.sent.push(!!v); return orig(v); };
      window.__Dsent = () => window.__D.sent.slice();
      window.__Dclear = () => { window.__D.sent = []; };
      window.__Dpeek = () => { const n=document.querySelector('#peek');
        return { hidden:n.classList.contains('hidden') }; };
      window.__Dreset = () => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){} };
      return 'ok'; })()`);

    const b0 = win.getBounds(); const inset = (b0.width-120)/2;
    win.setBounds({ x: Math.round(wa.x + wa.width/2 - inset), y: Math.round(wa.y+wa.height/2-150),
                    width: b0.width, height: b0.height });
    const st0 = stOf(); if (st0) applyPetSize(st0, null);
    await sleep(400);
    const cb = await js(`(() => { const r=document.querySelector('#cat').getBoundingClientRect();
      return { cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2),
               tx:Math.round(r.left+r.width/2), ty:Math.round(r.top)-120 }; })()`);

    for (let round = 0; round < 3; round++) {
      await js('window.__Dreset()'); seed(); await sleep(300);
      await js('window.__Dclear()'); IGN.length = 0;

      // 先把光标放到猫身上 → 渲染端应发 ignore(false)，两边同步为 false
      win.focus(); await sleep(120);
      wc.sendInputEvent({ type:'mouseMove', x:cb.cx, y:cb.cy }); await sleep(120);
      const s1 = { rendererSent: await js('window.__Dsent()'), main: stOf().mouseIgnoring, osCalls: IGN.slice() };

      // 开气泡
      wc.sendInputEvent({ type:'mouseDown', x:cb.cx, y:cb.cy, button:'left', clickCount:1 }); await sleep(35);
      wc.sendInputEvent({ type:'mouseUp',   x:cb.cx, y:cb.cy, button:'left', clickCount:1 }); await sleep(700);
      const opened = await js('window.__Dpeek()');

      // 关气泡 → closePeek → blurPet → PET_BLUR → releaseClickThrough(st)
      await js('window.__Dclear()'); IGN.length = 0;
      wc.sendInputEvent({ type:'mouseDown', x:cb.cx, y:cb.cy, button:'left', clickCount:1 }); await sleep(35);
      wc.sendInputEvent({ type:'mouseUp',   x:cb.cx, y:cb.cy, button:'left', clickCount:1 }); await sleep(800);
      const closed = await js('window.__Dpeek()');
      const afterClose = { rendererSent: await js('window.__Dsent()'), main: stOf().mouseIgnoring, osCalls: IGN.slice() };

      // ★ 关键：把光标移到**透明区**（猫上方 120px）。正确行为 = 渲染端发 ignore(true)。
      //   若渲染端那份 mouseIgnoring 仍是 true（stale），首行守卫会让它**不发**。
      await js('window.__Dclear()'); IGN.length = 0;
      wc.sendInputEvent({ type:'mouseMove', x:cb.tx, y:cb.ty }); await sleep(200);
      wc.sendInputEvent({ type:'mouseMove', x:cb.tx+3, y:cb.ty+2 }); await sleep(250);
      const onTransparent = { rendererSent: await js('window.__Dsent()'), main: stOf().mouseIgnoring, osCalls: IGN.slice() };

      log({ ev:'desync', round, peekOpened:opened, peekClosed:closed,
            onCat:s1, afterClose, onTransparent,
            verdict: (onTransparent.rendererSent.length === 0 && onTransparent.main === false)
              ? 'DESYNC: 光标在透明区但渲染端没发 ignore(true) → 窗口保持不穿透'
              : 'ok' });
      await sleep(300);
    }
    log({ ev:'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_DESYNC ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_DESYNC')) runProbeDesync();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_DESYNC')) app.dock.hide(); } catch {}"

def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src and DOCK in src, "anchor missing"
        out = src.replace(TRIGGER, TRIGGER_NEW, 1).replace(DOCK, DOCK_NEW, 1)
        open(MAIN, "w", encoding="utf-8").write(out + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_DESYNC":"1", "HOME":"/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET":"1", "WORKMEOW_ALLOW_MULTI":"1",
                    "WORKMEOW_NO_HOOKS":"1", "WORKMEOW_NO_CODEX":"1",
                    "WORKMEOW_NO_OPENCODE":"1", "WORKMEOW_NO_TRAE":"1"})
        os.makedirs("/tmp/wm-probe-home", exist_ok=True)
        proc = subprocess.Popen(["npx","electron","."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try: blob,_ = proc.communicate(timeout=200)
        except subprocess.TimeoutExpired:
            print("!!! TIMEOUT"); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob,_ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_DESYNC" in line: print(line)
        if "PROBE_DESYNC" not in blob:
            print("--- no probe output; tail ---"); print(blob[-3000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node","--check",MAIN], check=True)
        print("restored main.js")

main()
