#!/usr/bin/env python3
# H1 第九轮 —— 判定性实验：visibilityState 隐身闪烁 = 「喵没了又出现」。
#
# 上一轮（probeThrottle）的意外收获，也是本轮的靶心：
#   A 组（backgroundThrottling 未设 = Electron 默认 true）3/3 轮抓到
#     visibilitychange → hidden (5.5ms) → visible (6.8ms)，一个约 1.3ms 的隐身窗口。
#   B 组（backgroundThrottling:false）零次 visibilitychange。
#   visibilityState==='hidden' 时 Chromium 停止合成；桌宠是 transparent:true 的窗口，
#   停止合成 == 屏幕上什么都没有 == 用户说的「喵也没了。然后再出现」。
#
# 上一轮的缺陷（本轮全部修掉）：
#   (1) 9 轮里 7 轮 focusedBefore:false → win.blur() 空操作，数据作废。
#       → 本轮 win.focus() 带重试轮询，且 probe 内允许 app.focus({steal:true})
#         （只在 probe 里，产品代码不动），拿不到焦点就明确标 INVALID 而不混入统计。
#   (2) 测的是裸 win.blur()，不是用户的真实路径。
#       → 本轮走**真实路径**：sendInputEvent 点猫开 peek、再点关 peek（closePeek →
#         blurPet → PET_BLUR → w.blur()），左键 vs 右键 radial 作对照。
#         右键（closeRadial 不调 blurPet）必须零闪烁 —— 这正是用户说的
#         「右键的时候动画没有任何影响，只有左键弹气泡才有」。
#   (3) 只记 visibilitychange 事件，没记 hidden 持续多久、期间掉了几帧。
#       → 本轮同时跑 rAF 采样，把每帧的 visibilityState 一起记下来，算出
#         hidden 态实际横跨几帧（这才是用户肉眼看到的东西）。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK  = "/tmp/main.js.probeVis.bak"
WP_OLD = "    webPreferences: {"

PROBE = r"""
// ==== PROBE_VIS (临时) ====
function runProbeVis() {
  const log = (o) => console.log('PROBE_VIS ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal:'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { ERR:String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}
    const MODE = process.env.WORKMEOW_VIS_MODE || 'A_default';
    log({ ev:'env', mode: MODE, wa });

    // 渲染端：rAF 逐帧记 visibilityState + #cat-img 矩形，另挂 visibilitychange 监听
    const INSTALL = `(() => {
      window.__V = { fr:[], on:false, t0:0, ev:[], marks:[] };
      const tick = () => { if (!window.__V.on) return;
        const n = document.querySelector('#cat-img');
        const r = n ? n.getBoundingClientRect() : null;
        window.__V.fr.push([Math.round((performance.now()-window.__V.t0)*10)/10,
          document.visibilityState === 'visible' ? 1 : 0,
          r ? Math.round(r.width) : -1, document.hasFocus() ? 1 : 0]);
        requestAnimationFrame(tick); };
      window.__Vstart = () => { window.__V.fr=[]; window.__V.ev=[]; window.__V.marks=[];
        window.__V.on=true; window.__V.t0=performance.now(); requestAnimationFrame(tick); };
      window.__Vmark = (s) => window.__V.marks.push([Math.round((performance.now()-window.__V.t0)*10)/10, s]);
      window.__Vstop = () => { window.__V.on=false;
        return { fr:window.__V.fr, ev:window.__V.ev, marks:window.__V.marks }; };
      document.addEventListener('visibilitychange', () => {
        try { window.__V.ev.push([Math.round((performance.now()-(window.__V.t0||0))*10)/10,
              'vis:'+document.visibilityState]); } catch {} }, true);
      window.addEventListener('blur', () => { try { window.__V.ev.push(
        [Math.round((performance.now()-(window.__V.t0||0))*10)/10,'blur']); } catch {} }, true);
      window.addEventListener('focus', () => { try { window.__V.ev.push(
        [Math.round((performance.now()-(window.__V.t0||0))*10)/10,'focus']); } catch {} }, true);
      return 'ok'; })()`;
    log({ ev:'install', r: await js(INSTALL) });

    const seed = () => { let s; try { s = buildStats('all'); } catch { return; }
      const now = Date.now();
      s.sessions = [{ sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
        headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 },
        { sessionId:'p2', agent:'codex', project:'other', state:'waiting',
        headless:false, updatedAt:now, startedAt:now-120000, tokens:6789, cost:0.07 }];
      s.workingCount=1; s.waitingCount=1; s.idleMs=1000;
      s.today={messages:42,tokens:19356,cost:0.2}; lastStats=s; wc.send(IPC.PET_STATS, s); };

    // 焦点获取带重试（上一轮 7/9 轮拿不到焦点，数据全废）
    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };
    const cbox = () => js(`(() => { const r=document.querySelector('#cat').getBoundingClientRect();
      return { cx:Math.round(r.left+r.width/2), cy:Math.round(r.top+r.height/2) }; })()`);
    const clickCat = async (button) => { const b = await cbox();
      wc.sendInputEvent({ type:'mouseMove', x:b.cx, y:b.cy }); await sleep(25);
      wc.sendInputEvent({ type:'mouseDown', x:b.cx, y:b.cy, button, clickCount:1 }); await sleep(35);
      wc.sendInputEvent({ type:'mouseUp',   x:b.cx, y:b.cy, button, clickCount:1 }); };
    const peekState = () => js(`(() => { const n=document.querySelector('#peek');
      return { hidden:n.classList.contains('hidden'), h:Math.round(n.getBoundingClientRect().height) }; })()`);
    const radialState = () => js(`(() => { const n=document.querySelector('#radial');
      return { hidden:n.classList.contains('hidden') }; })()`);
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){} return 1; })()`);

    const analyze = (out) => {
      const fr = out.fr || [];
      // 隐身帧：visibilityState !== 'visible' 的帧
      const hiddenFrames = fr.filter(f => f[1] === 0).length;
      // 连续隐身段（用户肉眼看到的「没了」）
      const runs = []; let cur = null;
      for (const f of fr) { if (f[1] === 0) { if (!cur) cur = { from:f[0], to:f[0], n:0 }; cur.to=f[0]; cur.n++; }
                            else if (cur) { runs.push(cur); cur=null; } }
      if (cur) runs.push(cur);
      const gaps = [];
      for (let i=1;i<fr.length;i++) { const d = Math.round((fr[i][0]-fr[i-1][0])*10)/10;
        if (d > 50) gaps.push({ at:fr[i-1][0], gap:d }); }
      const visEvents = (out.ev||[]).filter(e => e[1].startsWith('vis:'));
      return { frames: fr.length, hiddenFrames, hiddenRuns: runs,
               visChangeCount: visEvents.length, gaps50: gaps,
               events: out.ev, marks: out.marks,
               imgW: [...new Set(fr.map(f=>f[2]))] };
    };

    seed(); await sleep(400);
    { const b = win.getBounds(); const inset = (b.width-120)/2;
      win.setBounds({ x: Math.round(wa.x-inset), y: Math.round(wa.y+wa.height/2-150),
                      width:b.width, height:b.height }); await sleep(400); }

    let stats = { left:{ rounds:0, hidden:0, visChanges:0 }, right:{ rounds:0, hidden:0, visChanges:0 } };

    for (let round = 0; round < 4; round++) {
      for (const button of ['left', 'right']) {
        await reset(); seed(); await sleep(350);
        const gotFocus = await grabFocus();

        await js('window.__Vstart()');
        await js(`window.__Vmark('open')`);
        await clickCat(button); await sleep(700);
        const opened = button === 'left' ? await peekState() : await radialState();
        await js(`window.__Vmark('close')`);
        await clickCat(button); await sleep(1200);          // 关 → closePeek/closeRadial
        const A = analyze(await js('window.__Vstop()'));

        const valid = gotFocus && opened && !opened.hidden;
        if (valid) { const k = button === 'left' ? 'left' : 'right';
          stats[k].rounds++; stats[k].hidden += A.hiddenFrames; stats[k].visChanges += A.visChangeCount; }

        log({ ev:'vis', mode: MODE, round, button, gotFocus, opened,
              valid, ...A,
              VERDICT: !valid ? 'INVALID' : (A.hiddenFrames > 0
                ? 'HIDDEN_FLICKER: ' + A.hiddenFrames + ' 帧隐身'
                : (A.visChangeCount > 0 ? 'VIS_EVENT_ONLY: 事件有但没抓到隐身帧' : 'clean')) });
        await sleep(300);
      }
    }
    log({ ev:'SUMMARY', mode: MODE, stats });
    log({ ev:'done', mode: MODE });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_VIS ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_VIS')) runProbeVis();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_VIS')) app.dock.hide(); } catch {}"


def run(mode, patch_bg):
    src = open(MAIN, encoding="utf-8").read()
    assert TRIGGER in src and DOCK in src, "anchor missing"
    out = src.replace(TRIGGER, TRIGGER_NEW, 1).replace(DOCK, DOCK_NEW, 1)
    if patch_bg:
        i = out.index(WP_OLD)
        out = out[:i] + WP_OLD + "\n      backgroundThrottling: false,\n" + out[i+len(WP_OLD):]
    open(MAIN, "w", encoding="utf-8").write(out + "\n" + PROBE)
    subprocess.run(["node","--check",MAIN], check=True)
    env = dict(os.environ)
    env.update({"WORKMEOW_PROBE_VIS":"1","WORKMEOW_VIS_MODE":mode,
                "HOME":"/tmp/wm-probe-home","WORKMEOW_NO_NET":"1","WORKMEOW_ALLOW_MULTI":"1",
                "WORKMEOW_NO_HOOKS":"1","WORKMEOW_NO_CODEX":"1","WORKMEOW_NO_OPENCODE":"1",
                "WORKMEOW_NO_TRAE":"1"})
    os.makedirs("/tmp/wm-probe-home", exist_ok=True)
    proc = subprocess.Popen(["npx","electron","."], cwd=REPO, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, start_new_session=True)
    try: blob,_ = proc.communicate(timeout=200)
    except subprocess.TimeoutExpired:
        print("!!! TIMEOUT "+mode); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        blob,_ = proc.communicate()
    finally:
        if proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
    blob = blob or ""
    for line in blob.splitlines():
        if "PROBE_VIS" in line: print(line)
    if "PROBE_VIS" not in blob:
        print("--- no output ("+mode+"); tail ---"); print(blob[-2500:])


def main():
    shutil.copy(MAIN, BAK)
    try:
        print("######## A 组：默认 backgroundThrottling ########")
        run("A_default", False)
        shutil.copy(BAK, MAIN)
        print()
        print("######## B 组：backgroundThrottling: false ########")
        run("B_noThrottle", True)
    finally:
        shutil.copy(BAK, MAIN)
        subprocess.run(["node","--check",MAIN], check=True)
        print("restored main.js")

main()
