#!/usr/bin/env python3
# H1 第七轮 —— 验证候选修法：closePeek() 去掉 blurPet() 之后 F4 会不会回归。
#
# 为什么这是 H1 的头号候选：
#   * 左右键唯一的代码差异就是它（closeRadial 不调 blurPet）——精确对上用户
#     「右键没影响，只有左键弹气泡才有」。
#   * blurPet 的自我描述是「输入框结束后归还窗口焦点」，而 #peek 没有任何输入框
#     （只有 #ask 有 textarea）。closePeek 里这一行很可能是照抄 hideAsk 的产物。
#   * 它曾是 F4（AppKit constrainFrameRect 钳帧）的触发源，但 probeClamp 已实测
#     证明钳帧不再发生（6 轮 2ms 轮询帧全程零变化）——修掉 F4 的是
#     enableLargerThanScreen: true，不是 blurPet。
#
# 这轮做 A/B：同一份进程里，先测「有 blurPet」再测「无 blurPet」（运行时 patch
# window.pet.blurPet 成 no-op），各测左缘/右缘 × 3 轮，2ms 轮询 getBounds()。
# 判据：两组的帧变化次数都必须为 0。若无 blurPet 那组出现漂移 → 修法不可行。
#
# 注意：不能改 pet.js 源码来去掉 blurPet（那会让 A 组也失效）。改成运行时把
# window.pet.blurPet 换掉 —— 但 contextBridge 对象是冻结的。所以改 preload.js：
# 让 blurPet 读一个可切换的开关。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
PRE  = os.path.join(REPO, "preload.js")
BAK_M = "/tmp/main.js.probeNoBlur.bak"
BAK_P = "/tmp/preload.js.probeNoBlur.bak"

PRE_OLD = "  blurPet: () => ipcRenderer.send(IPC.PET_BLUR),"
PRE_NEW = ("  blurPet: () => { if (globalThis.__NOBLUR) { globalThis.__blurSkipped = "
           "(globalThis.__blurSkipped||0)+1; return; } return ipcRenderer.send(IPC.PET_BLUR); },\n"
           "  __setNoBlur: (v) => { globalThis.__NOBLUR = !!v; return !!globalThis.__NOBLUR; },\n"
           "  __blurSkipped: () => globalThis.__blurSkipped || 0,")

PROBE = r"""
// ==== PROBE_NOBLUR (临时) ====
function runProbeNoBlur() {
  const log = (o) => console.log('PROBE_NOBLUR ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal:'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { ERR:String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}
    log({ ev:'env', wa });

    const chk = await js('typeof window.pet.__setNoBlur');
    log({ ev:'patchCheck', __setNoBlur: chk });
    if (chk !== 'function') { log({ fatal:'preload patch 没生效' }); app.exit(1); return; }

    // 记主进程 PET_BLUR 是否真的到达（A 组应到达、B 组应为 0）
    let blurCount = 0;
    const origBlur = win.blur.bind(win);
    win.blur = function (...a) { blurCount++; return origBlur(...a); };

    const seed = () => { let s; try { s = buildStats('all'); } catch { return; }
      const now = Date.now();
      s.sessions = [{ sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
        headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 },
        { sessionId:'p2', agent:'codex', project:'other', state:'waiting',
        headless:false, updatedAt:now, startedAt:now-120000, tokens:6789, cost:0.07 }];
      s.workingCount=1; s.waitingCount=1; s.idleMs=1000;
      s.today={messages:42,tokens:19356,cost:0.2}; lastStats=s; wc.send(IPC.PET_STATS, s); };

    // 2ms 高频轮询帧本身（AppKit 钳帧在 JS 层之下，给 setBounds 打桩看不见）
    let POLL=null, TRACE=[], t0=0;
    const startPoll = () => { TRACE=[]; t0=Date.now();
      POLL = setInterval(() => { try { const b=win.getBounds();
        TRACE.push([Date.now()-t0,b.x,b.y,b.width,b.height,win.isFocused()?1:0]); } catch {} }, 2); };
    const stopPoll = () => { if (POLL) clearInterval(POLL); POLL=null;
      const out=[]; let prev=null;
      for (const s of TRACE) { const k=s.slice(1,5).join(',');
        if (k!==prev) { out.push(s); prev=k; } }
      return { samples:TRACE.length, frameChanges: out.length-1, changes: out }; };

    const place = async (catX) => { const b=win.getBounds(); const inset=(b.width-120)/2;
      win.setBounds({ x: Math.round(catX-inset), y: Math.round(wa.y+wa.height/2-150),
                      width:b.width, height:b.height });
      const st=stOf(); if (st) applyPetSize(st,null); await sleep(450);
      return win.getBounds(); };
    const cbox = () => js(`(() => { const r=document.querySelector('#cat').getBoundingClientRect();
      return { cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2) }; })()`);
    const click = async () => { try { win.focus(); } catch {} await sleep(130);
      const b = await cbox();
      wc.sendInputEvent({ type:'mouseMove', x:b.cx, y:b.cy }); await sleep(25);
      wc.sendInputEvent({ type:'mouseDown', x:b.cx, y:b.cy, button:'left', clickCount:1 }); await sleep(35);
      wc.sendInputEvent({ type:'mouseUp',   x:b.cx, y:b.cy, button:'left', clickCount:1 }); };
    const peek = () => js(`(() => { const n=document.querySelector('#peek');
      return { hidden:n.classList.contains('hidden'), h:Math.round(n.getBoundingClientRect().height) }; })()`);
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){} return 1; })()`);

    for (const mode of ['A_withBlur', 'B_noBlur']) {
      const noBlur = mode === 'B_noBlur';
      log({ ev:'mode', mode, set: await js(`window.pet.__setNoBlur(${noBlur})`) });

      for (const [label, catX] of [['左缘', wa.x], ['右缘', wa.x + wa.width - 120]]) {
        for (let round = 0; round < 3; round++) {
          await reset(); seed(); await sleep(300);
          const placed = await place(catX);
          blurCount = 0;

          startPoll();
          await click(); await sleep(700);           // 开
          const opened = await peek();
          await click(); await sleep(900);           // 关 → closePeek
          const closed = await peek();
          const tr = stopPoll();
          const after = win.getBounds();

          const drift = { dx: after.x - placed.x, dy: after.y - placed.y,
                          dw: after.width - placed.width, dh: after.height - placed.height };
          log({ ev:'ab', mode, label, round,
                placed:{x:placed.x,y:placed.y,w:placed.width,h:placed.height},
                after:{x:after.x,y:after.y,w:after.width,h:after.height}, drift,
                peekOpened:opened, peekClosed:closed,
                winBlurCalls: blurCount,
                blurSkipped: await js('window.pet.__blurSkipped()'),
                frameChanges: tr.frameChanges, samples: tr.samples,
                changes: tr.frameChanges > 0 ? tr.changes : undefined,
                FATAL: (opened && opened.hidden) ? 'peek 没打开，本轮作废' : undefined });
          await sleep(250);
        }
      }
    }
    log({ ev:'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_NOBLUR ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_NOBLUR')) runProbeNoBlur();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_NOBLUR')) app.dock.hide(); } catch {}"

def main():
    m = open(MAIN, encoding="utf-8").read()
    p = open(PRE, encoding="utf-8").read()
    shutil.copy(MAIN, BAK_M); shutil.copy(PRE, BAK_P)
    proc = None
    try:
        assert TRIGGER in m and DOCK in m, "main.js anchor missing"
        assert PRE_OLD in p, "preload blurPet anchor missing"
        open(MAIN,"w",encoding="utf-8").write(m.replace(TRIGGER,TRIGGER_NEW,1).replace(DOCK,DOCK_NEW,1)+"\n"+PROBE)
        open(PRE,"w",encoding="utf-8").write(p.replace(PRE_OLD,PRE_NEW,1))
        subprocess.run(["node","--check",MAIN], check=True)
        subprocess.run(["node","--check",PRE], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_NOBLUR":"1","HOME":"/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET":"1","WORKMEOW_ALLOW_MULTI":"1","WORKMEOW_NO_HOOKS":"1",
                    "WORKMEOW_NO_CODEX":"1","WORKMEOW_NO_OPENCODE":"1","WORKMEOW_NO_TRAE":"1"})
        os.makedirs("/tmp/wm-probe-home", exist_ok=True)
        proc = subprocess.Popen(["npx","electron","."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try: blob,_ = proc.communicate(timeout=260)
        except subprocess.TimeoutExpired:
            print("!!! TIMEOUT"); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob,_ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_NOBLUR" in line: print(line)
        if "PROBE_NOBLUR" not in blob:
            print("--- no probe output; tail ---"); print(blob[-3000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK_M, MAIN); shutil.copy(BAK_P, PRE)
        subprocess.run(["node","--check",MAIN], check=True)
        subprocess.run(["node","--check",PRE], check=True)
        print("restored main.js + preload.js")

main()
