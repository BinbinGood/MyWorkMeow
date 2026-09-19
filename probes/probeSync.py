#!/usr/bin/env python3
# H1 第六轮 —— 判定性实验，直读双份状态。
#
# 前五轮的两个方法论障碍，这轮各有解法：
#   (1) 读不到渲染端的 mouseIgnoring：它是 pet.js 的模块级 let，contextBridge 的
#       window.pet 是冻结对象、hook 不上。→ 解法：**临时 patch pet.js**，在
#       setMouseIgnore 里加一行记账 + 暴露 window.__MI 读取器。改完还原。
#   (2) sendInputEvent 造不出真失焦（G1 的老教训）。→ 解法：主进程**直接调
#       win.blur()**。这是真 NSWindow 失焦，会触发 win.on('blur') → releaseClickThrough。
#
# 判据（三步）：
#   step1 光标停透明区 → 渲染端应发 ignore(true)，两边都 = true
#   step2 主进程 win.blur() → releaseClickThrough 把主进程侧改成 false + 下发
#         setIgnoreMouseEvents(false)。此刻读两边：若 (renderer=true, main=false)
#         → **desync 确证**
#   step3 再往透明区发 mousemove → 渲染端算出 on=true，但守卫
#         `if (on === mouseIgnoring) return` 命中 → 不发 IPC。窗口停在「可点」。
#         → **后果确证：该穿透的时候不穿透**
#
# 附带量 4s 心跳的影响：不掐 statsTimer，记录 setIgnoreMouseEvents 的全部下发时刻，
# 看它是不是每 4s 复位一次（G1 修法引入的重复 OS 级窗口调用）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
PETJS = os.path.join(REPO, "renderer", "pet.js")
BAK_M = "/tmp/main.js.probeSync.bak"
BAK_P = "/tmp/pet.js.probeSync.bak"

# ── pet.js 侧：暴露渲染端那份状态 ────────────────────────────────────────
PET_OLD = """function setMouseIgnore(on) {
  if (on === mouseIgnoring) return;
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}"""
PET_NEW = """function setMouseIgnore(on) {
  try { window.__MIlog = window.__MIlog || []; window.__MIlog.push([Math.round(performance.now()), on ? 1 : 0, (on === mouseIgnoring) ? 'SKIP' : 'SEND']); } catch {}
  if (on === mouseIgnoring) return;
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}
try { window.__MI = () => mouseIgnoring; window.__MIclear = () => { window.__MIlog = []; }; } catch {}"""

PROBE = r"""
// ==== PROBE_SYNC (临时) ====
function runProbeSync() {
  const log = (o) => console.log('PROBE_SYNC ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal:'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { ERR:String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;

    // 真实下发到 OS 的每一次穿透调用（带时间戳，用来看 4s 心跳）
    const OS = []; const T0 = Date.now();
    const origIgn = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = function (v, ...r) { OS.push([Date.now()-T0, v ? 1 : 0]); return origIgn(v, ...r); };

    // 验证 pet.js 的 patch 生效
    const probeReady = await js('typeof window.__MI');
    log({ ev:'patchCheck', __MI: probeReady });
    if (probeReady !== 'function') { log({ fatal:'pet.js patch 没生效' }); app.exit(1); return; }

    const seed = () => { let s; try { s = buildStats('all'); } catch { return; }
      const now = Date.now();
      s.sessions = [{ sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
        headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 }];
      s.workingCount=1; s.idleMs=1000; s.today={messages:42,tokens:19356,cost:0.2};
      lastStats=s; wc.send(IPC.PET_STATS, s); };

    // 猫挪到屏幕中间
    const b0 = win.getBounds(); const inset = (b0.width - 120) / 2;
    win.setBounds({ x: Math.round(wa.x + wa.width/2 - inset), y: Math.round(wa.y + wa.height/2 - 150),
                    width: b0.width, height: b0.height });
    { const st = stOf(); if (st) applyPetSize(st, null); }
    seed(); await sleep(600);

    const box = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2),
               tx: Math.round(r.left + r.width/2), ty: Math.max(4, Math.round(r.top) - 150) }; })()`);
    log({ ev:'box', box });

    const both = async (tag) => ({ tag, renderer: await js('window.__MI()'),
      main: stOf() ? stOf().mouseIgnoring : null,
      rlog: await js('(window.__MIlog||[]).slice(-6)') });

    for (let round = 0; round < 3; round++) {
      try { win.focus(); } catch {}
      await sleep(200);
      await js('window.__MIclear()'); OS.length = 0;

      // step0：光标先放猫身上（两边归零到 false）
      wc.sendInputEvent({ type:'mouseMove', x:box.cx, y:box.cy }); await sleep(150);
      const s0 = await both('onCat');

      // step1：光标移到透明区 → 渲染端应发 ignore(true)
      wc.sendInputEvent({ type:'mouseMove', x:box.tx, y:box.ty }); await sleep(150);
      wc.sendInputEvent({ type:'mouseMove', x:box.tx+2, y:box.ty+1 }); await sleep(200);
      const s1 = await both('onTransparent');

      // step2：★ 真失焦 —— 主进程直接 win.blur()（不是合成事件）
      const osBefore = OS.length;
      try { win.blur(); } catch (e) {}
      await sleep(300);
      const s2 = await both('afterRealBlur');
      const osDuringBlur = OS.slice(osBefore);

      // step3：再往透明区动一下 → 渲染端该不该补发 ignore(true)？
      await js('window.__MIclear()');
      const osBefore3 = OS.length;
      wc.sendInputEvent({ type:'mouseMove', x:box.tx+5, y:box.ty+3 }); await sleep(200);
      wc.sendInputEvent({ type:'mouseMove', x:box.tx+8, y:box.ty+5 }); await sleep(250);
      const s3 = await both('moveAgainOnTransparent');
      const osAfter3 = OS.slice(osBefore3);

      const desync = (s2.renderer === true && s2.main === false);
      const stuck  = (s3.renderer === true && s3.main === false && osAfter3.length === 0);
      log({ ev:'sync', round, s0, s1, s2, s3, osDuringBlur, osAfter3,
            DESYNC: desync ? 'YES: renderer=true / main=false' : 'no',
            CONSEQUENCE: stuck ? 'YES: 光标在透明区但窗口停在可点态（不穿透）' : 'no' });
      await sleep(400);
    }

    // 附加：静置 10s 不动光标，看 4s 心跳是否反复下发 setIgnoreMouseEvents(false)
    try { win.blur(); } catch {}
    await js('window.__MIclear()'); OS.length = 0;
    wc.sendInputEvent({ type:'mouseMove', x:box.tx, y:box.ty }); await sleep(200);
    const idle0 = await both('idleStart');
    await sleep(10000);
    const idle1 = await both('idleEnd');
    log({ ev:'heartbeat10s', idle0, idle1, osCalls: OS.slice(),
          note:'osCalls 里每 4s 一次 v:0 = 心跳在反复复位穿透' });

    log({ ev:'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_SYNC ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_SYNC')) runProbeSync();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_SYNC')) app.dock.hide(); } catch {}"

def main():
    m = open(MAIN, encoding="utf-8").read()
    p = open(PETJS, encoding="utf-8").read()
    shutil.copy(MAIN, BAK_M); shutil.copy(PETJS, BAK_P)
    proc = None
    try:
        assert TRIGGER in m and DOCK in m, "main.js anchor missing"
        assert PET_OLD in p, "pet.js setMouseIgnore anchor missing"
        open(MAIN,"w",encoding="utf-8").write(m.replace(TRIGGER,TRIGGER_NEW,1).replace(DOCK,DOCK_NEW,1)+"\n"+PROBE)
        open(PETJS,"w",encoding="utf-8").write(p.replace(PET_OLD,PET_NEW,1))
        subprocess.run(["node","--check",MAIN], check=True)
        subprocess.run(["node","--check",PETJS], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_SYNC":"1","HOME":"/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET":"1","WORKMEOW_ALLOW_MULTI":"1","WORKMEOW_NO_HOOKS":"1",
                    "WORKMEOW_NO_CODEX":"1","WORKMEOW_NO_OPENCODE":"1","WORKMEOW_NO_TRAE":"1"})
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
            if "PROBE_SYNC" in line: print(line)
        if "PROBE_SYNC" not in blob:
            print("--- no probe output; tail ---"); print(blob[-3000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK_M, MAIN); shutil.copy(BAK_P, PETJS)
        subprocess.run(["node","--check",MAIN], check=True)
        subprocess.run(["node","--check",PETJS], check=True)
        print("restored main.js + pet.js")

main()
