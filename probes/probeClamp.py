#!/usr/bin/env python3
# H1 第四轮探针。前三轮的净结果 + 它们共同的**结构性盲区**：
#   probeEdge  : 帧宽恒 520（含 0 会话）。证伪了「静息宽 < 520 → 关气泡 resize」。
#   probeFlash : 给 win.setBounds 打桩 → **零次调用**；iw/ih/catRect/opacity 逐帧恒定。
#   probeFocus : 数据废（docFocus 全 0、5/6 轮 peek 没开）。
#
# 盲区：三轮都在 **JS 层**观测。而 test/popup-style.js:175-186 钉住的实测结论是
#   —— macOS AppKit 的 constrainFrameRect:toScreen: 在 w.blur() 后 **~3ms** 钳帧，
#   **没有 will-move、没有任何 JS setBounds**。所以「setBounds 零次调用」跟
#   「帧没动过」根本不是一回事：给 setBounds 打桩永远看不见 AppKit 自己的钳制。
#   main.js 上全部窗口 mutator 已逐一 grep 过，petWin 只有 setBounds 一处 →
#   零调用是真的，但正因为如此，**帧若仍在动，动因只能来自 JS 之外**。
#
# 这轮改成**高频轮询 getBounds()**（~2ms），直接测帧本身，不问谁改的。
# 同时修掉 probeFocus 的三个缺陷：
#   (1) win.focus() 无效 —— 根因是 app.dock.hide() 把 app 变成 accessory app
#       （main.js:126 的注释明写这个副作用）。探针里把它 patch 掉，focus 才真生效，
#       closePeek 的 w.blur() 才是**真**状态变化。这是能测到 H1 的前提。
#   (2) radialOpen 残留 → 下一轮 openPeek() 首行守卫直接 return。每轮开始前强制复位。
#   (3) 4s 心跳把注入快照冲掉（污染胶囊宽度，制造 chipShift 假信号）→ patch 掉 statsTimer。
#
# 判据：猫贴左缘时帧 x = wa.x - 200 = -200（合法悬出）。若关气泡后 x 被拉回 wa.x=0，
#   就是 F4 那条链**没被 enableLargerThanScreen 真正修掉**，而随后 applyPetSize 按被
#   污染的 b.x 反解 → 猫净移动，即用户看到的「波动」+「喵没了又出现」。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeClamp.bak"

PROBE = r"""
// ==== PROBE_CLAMP (临时) ====
function runProbeClamp() {
  const log = (o) => console.log('PROBE_CLAMP ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ fatal: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (c) => { try { return await wc.executeJavaScript(c, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'env', wa, larger: true, dockHidden: false });

    // (3) 掐掉 4s 心跳：否则注入快照被真 buildStats（空 HOME → 0 会话）冲掉
    try { if (statsTimer) { clearInterval(statsTimer); statsTimer = null; } } catch {}

    // 高频帧轮询：不问谁改的，只看帧动没动
    let POLL = null, TRACE = [], t0 = Date.now();
    const startPoll = () => { TRACE = []; t0 = Date.now();
      POLL = setInterval(() => { try { const b = win.getBounds();
        TRACE.push([Date.now() - t0, b.x, b.y, b.width, b.height, win.isFocused() ? 1 : 0]);
      } catch {} }, 2); };
    const stopPoll = () => { if (POLL) clearInterval(POLL); POLL = null;
      // 只保留发生变化的采样点 + 首末
      const out = []; let prev = null;
      for (const s of TRACE) { const k = s.slice(1).join(',');
        if (k !== prev) { out.push(s); prev = k; } }
      if (TRACE.length && out[out.length-1] !== TRACE[TRACE.length-1]) out.push(TRACE[TRACE.length-1]);
      return { samples: TRACE.length, changes: out }; };

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
      window.__C = { fr: [], on: false, t0: 0 };
      // ★ 用 #cat-img（真正显示画面的元素），不是 #cat 那个 CSS 固定尺寸的容器 div。
      //   前三轮量的都是 #cat —— 它永远不动，所以「逐帧恒定」从没覆盖猫身上画的是什么。
      const shot = () => { const c = document.querySelector('#cat'), im = document.querySelector('#cat-img');
        const cs = c ? getComputedStyle(c) : null;
        const r = c ? c.getBoundingClientRect() : null;
        const ir = im ? im.getBoundingClientRect() : null;
        return { cl: r ? Math.round(r.left*10)/10 : null, ct: r ? Math.round(r.top*10)/10 : null,
                 cd: cs ? cs.display : null, cv: cs ? cs.visibility : null,
                 co: cs ? Math.round(parseFloat(cs.opacity)*100)/100 : null,
                 iw2: ir ? Math.round(ir.width) : null, ih2: ir ? Math.round(ir.height) : null,
                 src: im ? String(im.getAttribute('src')||'').split('/').pop() : null }; };
      const tick = () => { if (!window.__C.on) return;
        const s = shot();
        window.__C.fr.push([Math.round((performance.now()-window.__C.t0)*10)/10,
          window.innerWidth, window.innerHeight, s.cl, s.ct, s.cd, s.co, s.iw2, s.src]);
        requestAnimationFrame(tick); };
      window.__Cstart = () => { window.__C.fr=[]; window.__C.on=true;
        window.__C.t0 = performance.now(); requestAnimationFrame(tick); };
      window.__Cstop = () => { window.__C.on=false; return window.__C.fr; };
      window.__Cpeek = () => { const n=document.querySelector('#peek');
        return { hidden:n.classList.contains('hidden'), h:Math.round(n.getBoundingClientRect().height) }; };
      window.__Creset = () => { try { if (typeof closeRadial==='function') closeRadial(); } catch(e){}
        try { if (typeof closePeek==='function') closePeek(); } catch(e){}
        const r=document.querySelector('#radial'), p=document.querySelector('#peek');
        return { radialHidden:r.classList.contains('hidden'), peekHidden:p.classList.contains('hidden') }; };
      return 'ok'; })()`;
    log({ ev: 'install', r: await js(INSTALL) });

    const placeCat = async (catScreenX) => {
      const b = win.getBounds(); const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height/2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(450); return win.getBounds(); };
    const catBox = () => js(`(() => { const r=document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left+r.width/2), cy: Math.round(r.top+r.height/2) }; })()`);
    const clickCat = async (button) => {
      try { win.focus(); } catch {}
      await sleep(140);
      const b = await catBox();
      wc.sendInputEvent({ type:'mouseMove', x:b.cx, y:b.cy }); await sleep(25);
      wc.sendInputEvent({ type:'mouseDown', x:b.cx, y:b.cy, button, clickCount:1 }); await sleep(35);
      wc.sendInputEvent({ type:'mouseUp', x:b.cx, y:b.cy, button, clickCount:1 }); };

    const anaR = (fr) => { const u=(i)=>[...new Set(fr.map(f=>f[i]))];
      const gaps=[]; for(let i=1;i<fr.length;i++){const d=Math.round((fr[i][0]-fr[i-1][0])*10)/10;
        if(d>32) gaps.push({at:fr[i-1][0],gap:d});}
      return { n:fr.length, iw:u(1), ih:u(2), catL:u(3), catT:u(4),
               display:u(5), opacity:u(6), imgW:u(7), src:u(8), gaps32:gaps }; };

    for (const [label, catX] of [['左缘', wa.x], ['右缘', wa.x + wa.width - 120], ['中间', wa.x + Math.round(wa.width/2)]]) {
      for (let round = 0; round < 2; round++) {
        // (2) 强制状态复位，避免 radialOpen 残留让 openPeek 首行守卫 return
        const rst = await js('window.__Creset()');
        seed(2); await sleep(350);
        const placed = await placeCat(catX);

        // ── 左键 peek：closePeek → blurPet → w.blur() → (AppKit 钳帧?)
        await js('window.__Cstart()'); startPoll();
        await clickCat('left'); await sleep(750);
        const opened = await js('window.__Cpeek()');
        const bOpen = win.getBounds();
        await clickCat('left'); await sleep(950);
        const closed = await js('window.__Cpeek()');
        const L = anaR(await js('window.__Cstop()'));
        const Lb = stopPoll();

        await sleep(350);
        await js('window.__Creset()'); await sleep(200);

        // ── 右键 radial 对照：closeRadial 不调 blurPet / resetPetSize
        await js('window.__Cstart()'); startPoll();
        await clickCat('right'); await sleep(750);
        await clickCat('right'); await sleep(950);
        const R = anaR(await js('window.__Cstop()'));
        const Rb = stopPoll();

        log({ ev:'clamp', label, round, placedFrame:{x:placed.x,w:placed.width},
              openFrame:{x:bOpen.x,w:bOpen.width}, resetBefore:rst,
              peekOpened:opened, peekClosed:closed,
              LEFT_frame:Lb, LEFT_dom:L, RIGHT_frame:Rb, RIGHT_dom:R });
        await sleep(250);
      }
    }
    log({ ev:'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_CLAMP ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_CLAMP')) runProbeClamp();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_CLAMP')) app.dock.hide(); } catch {}"


def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor missing"
        assert DOCK in src, "dock anchor missing"
        out = src.replace(TRIGGER, TRIGGER_NEW, 1).replace(DOCK, DOCK_NEW, 1)
        open(MAIN, "w", encoding="utf-8").write(out + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_CLAMP": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        os.makedirs("/tmp/wm-probe-home", exist_ok=True)
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            blob, _ = proc.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            print("!!! TIMEOUT"); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_CLAMP" in line: print(line)
        if "PROBE_CLAMP" not in blob:
            print("--- no probe output; tail ---"); print(blob[-4000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node", "--check", MAIN], check=True)
        print("restored main.js")


main()
