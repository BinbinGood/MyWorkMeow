#!/usr/bin/env python3
# 边缘探针。上一轮 /tmp/probeRender.py 有两个盲区，用户报的两条新现象正好都落在盲区里：
#
#   盲区 1：猫摆在屏幕**正中**。那里 --pop-shift 恒为 0 —— 位移路径一次都没测过。
#           用户报的「喵在屏幕边缘时，气泡消息不完整，而且不完整的是**另一边**」就在这。
#   盲区 2：seed() 灌 3 条会话 → 胶囊够宽 → restingFrameWidth() 被 Math.max(POPUP_W,…)
#           顶到 520 == 弹窗宽 → 关气泡时 willResize 为假、**resize 压根没发生**。
#           用户报的「左键气泡消失时喵也没了、然后再出现」需要真的缩窗才能复现。
#
# 靶 A（问题 2）：猫贴左/右缘时，量 #peek / #ask 在**窗口帧内**的矩形，看有没有超出
#   [0, innerW]。算术预测：peek 宽 320、帧 520、每侧余量 100，而 capsuleShift 封顶
#   (320-120)/2+4 = 104 → 超 4px。ask 宽 340、余量 90、封顶 114 → 超 24px。
#   html,body{overflow:hidden} 会把超出的部分裁掉，裁的是**远离屏幕边缘**的那一侧。
#
# 靶 B（问题 1）：0 会话（静息窄）时开关气泡，逐帧记 innerW 和 #cat 的矩形。
#   若关气泡那一刻 innerW 从 520 掉回静息宽，且某几帧 #cat 消失/跳变 → 就是
#   resetPetSize() 触发的窗口 resize 造成的闪现。对照组：右键 radial 开关
#   （closeRadial 不调 blurPet/resetPetSize，帧尺寸不变）必须完全干净。

import os, shutil, subprocess, signal, sys

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeEdge.bak"

PROBE = r"""
// ==== PROBE_EDGE (临时) ====
function runProbeEdge() {
  const log = (o) => console.log('PROBE_EDGE ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // nSessions=0 → 胶囊窄 → 静息帧宽 < 520 → 关气泡时真的会 resize（靶 B 需要）
    // nSessions=3 → 有内容可看（靶 A 需要 peek 里真的有行）
    const seed = (n) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return false; }
      const now = Date.now();
      const all = [
        { sessionId: 'p1', agent: 'claude', project: 'WorkMeow', state: 'working',
          headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12 },
        { sessionId: 'p2', agent: 'codex', project: 'some-other-repo', state: 'waiting',
          headless: false, updatedAt: now, startedAt: now - 120000, tokens: 6789, cost: 0.07 },
        { sessionId: 'p3', agent: 'workbuddy', project: 'third', state: 'thinking',
          headless: false, updatedAt: now, startedAt: now - 30000, tokens: 222, cost: 0.01 },
      ];
      snap.sessions = all.slice(0, n);
      snap.workingCount = n > 0 ? 1 : 0;
      snap.waitingCount = n > 1 ? 1 : 0;
      snap.thinkingCount = n > 2 ? 1 : 0;
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return true;
    };

    // 把猫挪到指定屏幕 x（左缘 / 右缘 / 中间），走 setBounds + applyPetSize 钳制
    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height/2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      const nb = win.getBounds();
      const cat = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width) }; })()`);
      return { frame: nb, cat, catScreenX: cat ? nb.x + cat.left : null };
    };

    const catBox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }; })()`);
    const clickCat = async (button) => { const b = await catBox();
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); };

    // ════════════════════════════════════════════════════════════════════
    // 靶 A：边缘时弹窗有没有被**窗口帧**裁掉（不是被屏幕裁）
    // ════════════════════════════════════════════════════════════════════
    log({ ev: 'phase', n: 'A', what: '边缘弹窗是否被窗口帧裁掉' });
    const MEASURE = `(() => {
      const out = {};
      out.innerW = window.innerWidth; out.innerH = window.innerHeight;
      out.popShift = getComputedStyle(document.querySelector('#stage'))
        .getPropertyValue('--pop-shift').trim();
      for (const [name, sel] of [['peek','#peek'],['ask','#ask'],['chip','#chip'],['cat','#cat']]) {
        const n = document.querySelector(sel);
        if (!n) { out[name] = 'missing'; continue; }
        if (n.classList.contains('hidden') || n.hidden) { out[name] = 'hidden'; continue; }
        const r = n.getBoundingClientRect();
        const L = Math.round(r.left*10)/10, R = Math.round(r.right*10)/10;
        out[name] = { L, R, w: Math.round(r.width*10)/10,
                      clipLeft: Math.max(0, Math.round((-L)*10)/10),
                      clipRight: Math.max(0, Math.round((R - window.innerWidth)*10)/10) };
      }
      // 内部内容有没有被自己的容器裁（横向溢出）
      const pk = document.querySelector('#peek');
      if (pk && !pk.classList.contains('hidden')) {
        out.peekScroll = { sw: pk.scrollWidth, cw: pk.clientWidth, overflowX: pk.scrollWidth - pk.clientWidth };
      }
      return out; })()`;

    for (const [label, catX] of [['左缘', wa.x], ['左缘+4', wa.x + 4], ['中间', wa.x + Math.round(wa.width/2)],
                                 ['右缘-4', wa.x + wa.width - 124], ['右缘', wa.x + wa.width - 120]]) {
      seed(3); await sleep(150);
      const placed = await placeCat(catX);
      await clickCat('left'); await sleep(650);           // 开 peek
      const m = await js(MEASURE);
      log({ ev: 'edgePeek', label, wantCatX: catX, gotCatX: placed.catScreenX,
            frameX: placed.frame.x, frameW: placed.frame.width, m });
      await clickCat('left'); await sleep(500);           // 关
      await sleep(150);
    }

    // ════════════════════════════════════════════════════════════════════
    // 靶 B：0 会话（静息窄）时关气泡的 resize 闪现；右键 radial 作对照组
    // ════════════════════════════════════════════════════════════════════
    log({ ev: 'phase', n: 'B', what: '关气泡的 resize 闪现（左键 vs 右键对照）' });
    const INSTALL = `(() => {
      window.__E = { frames: [], on: false, t0: 0 };
      const rect = (sel) => { const n = document.querySelector(sel);
        if (!n) return null;
        if (n.classList.contains('hidden') || n.hidden) return 'hidden';
        const r = n.getBoundingClientRect();
        return [Math.round(r.left*10)/10, Math.round(r.top*10)/10,
                Math.round(r.width*10)/10, Math.round(r.height*10)/10]; };
      const tick = () => { if (!window.__E.on) return;
        window.__E.frames.push({ t: Math.round(performance.now() - window.__E.t0),
          iw: window.innerWidth, ih: window.innerHeight,
          cat: rect('#cat'), chip: rect('#chip'), peek: rect('#peek'), radial: rect('#radial'),
          shift: getComputedStyle(document.querySelector('#stage')).getPropertyValue('--pop-shift').trim() });
        requestAnimationFrame(tick); };
      window.__Estart = () => { window.__E.frames = []; window.__E.on = true;
        window.__E.t0 = performance.now(); requestAnimationFrame(tick); };
      window.__Estop = () => { window.__E.on = false; return window.__E.frames; };
      return 'ok'; })()`;
    log({ ev: 'install', r: await js(INSTALL) });

    const summarize = (frames) => {
      const iw = [...new Set(frames.map(f => f.iw))];
      const cat = [...new Set(frames.map(f => JSON.stringify(f.cat)))];
      const chip = [...new Set(frames.map(f => JSON.stringify(f.chip)))];
      const shift = [...new Set(frames.map(f => f.shift))];
      // 「猫没了」的判据：某几帧 cat 为 'hidden'/null，或 cat 的宽变 0
      const catGone = frames.filter(f => f.cat === 'hidden' || f.cat === null
        || (Array.isArray(f.cat) && f.cat[2] === 0)).length;
      // 帧宽变化的时刻
      const iwChanges = [];
      for (let i = 1; i < frames.length; i++) if (frames[i].iw !== frames[i-1].iw)
        iwChanges.push({ t: frames[i].t, from: frames[i-1].iw, to: frames[i].iw });
      return { n: frames.length, iwVariants: iw, iwChanges,
               catVariants: cat.length > 4 ? cat.slice(0,4).concat(['…+' + (cat.length-4)]) : cat,
               chipVariants: chip.length > 4 ? chip.slice(0,4).concat(['…+' + (chip.length-4)]) : chip,
               shiftVariants: shift, catGoneFrames: catGone };
    };

    for (const nSess of [0, 1, 3]) {
      for (const [label, catX] of [['中间', wa.x + Math.round(wa.width/2)], ['左缘', wa.x]]) {
        seed(nSess); await sleep(400);
        await placeCat(catX);
        const restingW = win.getBounds().width;

        // 左键：peek
        await js('window.__Estart()');
        await clickCat('left'); await sleep(600);
        await clickCat('left'); await sleep(700);
        const fL = await js('window.__Estop()');

        await sleep(250);
        // 右键：radial（对照组）
        await js('window.__Estart()');
        await clickCat('right'); await sleep(600);
        await clickCat('right'); await sleep(700);
        const fR = await js('window.__Estop()');

        log({ ev: 'resizeFlash', nSess, label, restingFrameW: restingW,
              left_peek: Array.isArray(fL) ? summarize(fL) : fL,
              right_radial: Array.isArray(fR) ? summarize(fR) : fR });
        await sleep(200);
      }
    }

    log({ ev: 'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_EDGE ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_EDGE')) runProbeEdge();\n"


def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor not found"
        open(MAIN, "w", encoding="utf-8").write(src.replace(TRIGGER, TRIGGER_NEW, 1) + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_EDGE": "1", "HOME": "/tmp/wm-probe-home",
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
            print("!!! TIMEOUT — killing probe process group")
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_EDGE" in line:
                print(line)
        if "PROBE_EDGE" not in blob:
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
