#!/usr/bin/env python3
# H1 第八轮 —— 判定「喵没了又出现」的成因是不是 backgroundThrottling。
#
# 为什么是它：
#   * 前四轮已穷尽排除 DOM 层：#cat-img 的 rect / src / opacity、#cat 的 computed
#     display、帧的 x/y/w/h（2ms 轮询）全程恒定。所以「没了又出现」不在 DOM，
#     只可能在合成器层。
#   * 桌宠窗口是 transparent:true。Electron 默认 backgroundThrottling:true —— 窗口
#     失焦/被遮挡时 Chromium 节流后台渲染。透明窗一旦停止产出合成帧，屏幕上呈现的
#     就是**完全透明**（= 喵没了）；重新聚焦产出新帧才「又出现」。
#   * 全仓库 grep backgroundThrottling 为空 → 用的就是默认值。
#
# 判据：真失焦（主进程 win.blur()）之后，渲染端 rAF 的帧间隔。
#   正常 ~16.7ms。若节流 → 间隔跳到 1000ms 量级或直接断流。
# A/B：同一份脚本跑两次，第二次给 petWin 的 webPreferences 加
#   backgroundThrottling:false，比较断流是否消失。
#
# 注意：不能用 sendInputEvent 造失焦（G1 老教训：合成事件不给 NSWindow 焦点）。
# 必须主进程直接 win.blur()。且 blur 前要先 win.focus() 让它真的持有焦点，
# 否则 blur() 是空操作（探针 #6 的 Round 0/2 就是这么空转的）。

import os, shutil, subprocess, signal, sys

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK  = "/tmp/main.js.probeThrottle.bak"

# petWin 的 webPreferences（main.js:475）——只在 B 组注入 backgroundThrottling:false
WP_OLD = "    webPreferences: {"

PROBE = r"""
// ==== PROBE_THROTTLE (临时) ====
function runProbeThrottle() {
  const log = (o) => console.log('PROBE_THROTTLE ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal:'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { ERR:String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}
    const MODE = process.env.WORKMEOW_THROTTLE_MODE || 'A_default';
    log({ ev:'env', mode: MODE, wa,
          bgThrottleSetting: (() => { try { return wc.getLastWebPreferences().backgroundThrottling; } catch (e) { return 'unknown'; } })() });

    // 渲染端：连续 rAF 采样，只记时间戳 + 可见性 + 是否有焦点
    const INSTALL = `(() => {
      window.__T = { fr: [], on:false, t0:0, marks:[], vis:[], events:[] };
      const tick = () => { if (!window.__T.on) return;
        window.__T.fr.push(Math.round((performance.now()-window.__T.t0)*10)/10);
        requestAnimationFrame(tick); };
      window.__Tstart = () => { window.__T.fr=[]; window.__T.marks=[]; window.__T.events=[];
        window.__T.on=true; window.__T.t0=performance.now(); requestAnimationFrame(tick); };
      window.__Tmark = (s) => window.__T.marks.push([Math.round((performance.now()-window.__T.t0)*10)/10, s]);
      window.__Tstop = () => { window.__T.on=false;
        return { fr: window.__T.fr, marks: window.__T.marks, events: window.__T.events }; };
      for (const ev of ['blur','focus','visibilitychange']) {
        (ev === 'visibilitychange' ? document : window).addEventListener(ev, () => {
          try { window.__T.events.push([Math.round((performance.now()-(window.__T.t0||0))*10)/10,
                ev, document.visibilityState, document.hasFocus()?1:0]); } catch {} }, true); }
      return 'ok'; })()`;
    log({ ev:'install', r: await js(INSTALL) });

    const seed = () => { let s; try { s = buildStats('all'); } catch { return; }
      const now = Date.now();
      s.sessions = [{ sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
        headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 }];
      s.workingCount=1; s.idleMs=1000; s.today={messages:42,tokens:19356,cost:0.2};
      lastStats=s; wc.send(IPC.PET_STATS, s); };

    // 分析帧间隔：找 >50ms 的断流（正常 16.7ms；>50ms 已是丢 2 帧以上）
    const analyze = (out, marks) => {
      const fr = out.fr || [];
      const gaps = [];
      for (let i=1;i<fr.length;i++) { const d = Math.round((fr[i]-fr[i-1])*10)/10;
        if (d > 50) gaps.push({ at: fr[i-1], gap: d }); }
      const ds = fr.slice(1).map((v,i)=>v-fr[i]);
      const sorted = ds.slice().sort((a,b)=>a-b);
      const med = sorted.length ? Math.round(sorted[Math.floor(sorted.length/2)]*10)/10 : 0;
      return { frames: fr.length, span: fr.length ? fr[fr.length-1] : 0,
               medianGap: med, maxGap: ds.length ? Math.round(Math.max(...ds)*10)/10 : 0,
               gaps50: gaps, totalStalledMs: Math.round(gaps.reduce((a,g)=>a+g.gap,0)),
               marks: out.marks, events: out.events };
    };

    seed(); await sleep(400);
    // 摆到左缘（帧悬出屏幕，最贴近用户报 bug 的场景）
    { const b = win.getBounds(); const inset = (b.width-120)/2;
      win.setBounds({ x: Math.round(wa.x-inset), y: Math.round(wa.y+wa.height/2-150),
                      width:b.width, height:b.height }); await sleep(400); }

    for (let round = 0; round < 3; round++) {
      // 先真聚焦（否则 blur() 是空操作）
      try { win.focus(); } catch {}
      await sleep(600);
      const focusedBefore = win.isFocused();

      await js('window.__Tstart()');
      await sleep(500);                              // 基线：聚焦态的帧率
      await js(`window.__Tmark('baseline-end')`);
      const baseline = await js('window.__Tstop()');

      await js('window.__Tstart()');
      await js(`window.__Tmark('before-blur')`);
      try { win.blur(); } catch {}                   // ★ 真 NSWindow 失焦
      await sleep(2500);                             // 失焦后观察 2.5s
      await js(`window.__Tmark('after-2500')`);
      const blurred = await js('window.__Tstop()');
      const focusedAfter = win.isFocused();

      log({ ev:'throttle', mode: MODE, round,
            focusedBefore, focusedAfter,
            BASELINE_focused: analyze(baseline),
            AFTER_BLUR: analyze(blurred),
            VERDICT: (() => { const b = analyze(blurred);
              if (!focusedBefore) return 'INVALID: blur 前窗口本来就没焦点，blur() 是空操作';
              if (b.frames <= 2) return 'THROTTLED_HARD: 失焦后 rAF 基本停了';
              if (b.medianGap > 100) return 'THROTTLED: 中位帧间隔 ' + b.medianGap + 'ms';
              if (b.maxGap > 200) return 'STALL: 出现 ' + b.maxGap + 'ms 断流';
              return 'ok: 失焦后帧率正常'; })() });
      await sleep(400);
    }
    log({ ev:'done', mode: MODE });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_THROTTLE ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_THROTTLE')) runProbeThrottle();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_THROTTLE')) app.dock.hide(); } catch {}"


def run(mode, patch_bg):
    src = open(MAIN, encoding="utf-8").read()
    assert TRIGGER in src and DOCK in src, "anchor missing"
    out = src.replace(TRIGGER, TRIGGER_NEW, 1).replace(DOCK, DOCK_NEW, 1)
    if patch_bg:
        # 只改第一个 webPreferences（main.js:475 == petWin）
        i = out.index(WP_OLD)
        out = out[:i] + WP_OLD + "\n      backgroundThrottling: false,\n" + out[i+len(WP_OLD):]
    open(MAIN, "w", encoding="utf-8").write(out + "\n" + PROBE)
    subprocess.run(["node", "--check", MAIN], check=True)
    env = dict(os.environ)
    env.update({"WORKMEOW_PROBE_THROTTLE":"1","WORKMEOW_THROTTLE_MODE":mode,
                "HOME":"/tmp/wm-probe-home","WORKMEOW_NO_NET":"1","WORKMEOW_ALLOW_MULTI":"1",
                "WORKMEOW_NO_HOOKS":"1","WORKMEOW_NO_CODEX":"1","WORKMEOW_NO_OPENCODE":"1",
                "WORKMEOW_NO_TRAE":"1"})
    os.makedirs("/tmp/wm-probe-home", exist_ok=True)
    proc = subprocess.Popen(["npx","electron","."], cwd=REPO, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, start_new_session=True)
    try: blob,_ = proc.communicate(timeout=150)
    except subprocess.TimeoutExpired:
        print("!!! TIMEOUT " + mode); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        blob,_ = proc.communicate()
    finally:
        if proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
    blob = blob or ""
    for line in blob.splitlines():
        if "PROBE_THROTTLE" in line: print(line)
    if "PROBE_THROTTLE" not in blob:
        print("--- no output ("+mode+"); tail ---"); print(blob[-2500:])


def main():
    shutil.copy(MAIN, BAK)
    try:
        print("######## A 组：默认（backgroundThrottling 未设） ########")
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
