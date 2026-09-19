#!/usr/bin/env python3
# 探针 #10：H2 唯一的实测欠账。
#
# H2 修法 (a) 已提交（43ec5f6）：capsuleShift 收 frameWidth，再压一层帧内余量。
# 但整个 H2 里有**两条**判断从头到尾只有算术，没有一次真机测量：
#
#   欠账 1：`.ask`（340 宽）在 520 帧里余量只有 90，而旧位移上限是 114 → 算术预测
#           修前**最多被帧裁 24px**。probeEdge 靶 A 只测到了 peek（320 宽、裁 4px），
#           从没把 .ask 真的打开过 —— 因为它需要一个带 choice 的会话才会出现。
#           24px 这个数是纯推的。
#
#   欠账 2：修后 `.ask` 贴死屏幕缘时还差 20px：
#             (340-120)/2 - (520-340)/2 = 110 - 90 = 20
#           这 20px 到底是**出屏**（屏幕外，任何窗口程序在屏幕缘的常规表现，可以接受）
#           还是**仍被帧裁**（内容不完整，H2 没修干净）？
#           这一条直接决定要不要把 POPUP_W 从 520 抬到 568 —— 那会连带动 catInset
#           200→220 和一大票钉死的数，代价很大，不能靠推理决定。
#
# 判据（关键：clipRight/clipLeft 量的是**帧**，offScreen 量的是**屏幕**）：
#   · clip* > 0  → 被 html,body{overflow:hidden} 裁掉 → 内容不完整 → H2 未修净
#   · clip* == 0 且 offScreen* > 0 → 只是探到屏幕外 → 可接受，不动 POPUP_W
#
# 对照：同一轮里顺便量 peek（320），它修后应当**一像素不亏**
#   （余量 100 == 上限 100，见 shared/pet-geometry.js 的注释表）。
#
# ⚠️ 本探针会临时改写 main.js，跑之前 worktree 必须干净（跑完会自动恢复 + node --check）。

import os, shutil, subprocess, signal, json

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeAsk.bak"

PROBE = r"""
// ==== PROBE_ASK (临时) ====
function runProbeAsk() {
  const log = (o) => console.log('PROBE_ASK ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // 主进程每 4s 推一次真实 stats（main.js:1245 setInterval(emitStats, 4000)）。
    // 真实快照里没有带 choice 的会话 → applyStats → refreshAsk → hideAsk()，
    // 会在两次测量之间把 #ask 关掉。探针期间必须掐掉这个心跳。
    try { clearInterval(statsTimer); log({ ev: 'killStatsTimer', ok: true }); }
    catch (e) { log({ ev: 'killStatsTimer', err: String(e) }); }

    // 渲染端异常捕获：applyStats 里 refreshAsk(s) 排在 renderSessions / fitRestingFrame /
    // updateNotepad **后面**（renderer/pet.js:2850-2858）。我灌的假会话字段不全，
    // 前面任一处抛异常，refreshAsk 就压根不会执行 —— 那才是 #ask 恒 hidden 的头号嫌疑。
    // 没有这个回收桶的话，异常只会静静落在 onStats 的 IPC 回调里，探针什么都看不见。
    // ⚠️ 不要试图包 window.applyStats：pet.js:2902 的 window.pet.onStats(applyStats) 早已
    // 把**原始引用**捞走，事后替换 window 上那个名字拦不到任何东西。所以只挂全局 error，
    // 另外在下面用 seedDirect() 手工调 applyStats 并就地 try/catch。
    await js(`(() => { window.__probeErrs = window.__probeErrs || [];
      if (!window.__probeHooked) { window.__probeHooked = 1;
        window.addEventListener('error', (e) => window.__probeErrs.push(
          String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
        window.addEventListener('unhandledrejection', (e) => window.__probeErrs.push(
          'reject: ' + String(e.reason && e.reason.stack || e.reason)));
      } return { hooked: 1 }; })()`);
    const errs = () => js('(window.__probeErrs || []).slice(-6)');

    // 唯一好使的取焦方案（probeVis 16/16）。只在探针里允许 steal。
    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    // ── seed：mode 'peek' 只要有内容；mode 'ask' 必须让 refreshAsk → showAskPanel 真的触发 ──
    // renderer/pet.js refreshAsk 的门槛（:1003-1075）：会话 state 为 waiting/needsinput
    // 且带 choice，choice 要么有非空 options 要么 allowInput。少一个条件 #ask 就不会出现，
    // 那样量到的就是 'hidden' 而不是 0 —— 所以下面必须自检，绝不能把 hidden 当成「没裁」。
    const seed = (mode) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return String(e); }
      const now = Date.now();
      const mk = (id, state, extra) => Object.assign({
        sessionId: id, agent: 'claude', project: 'WorkMeow', state,
        headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12,
      }, extra || {});
      if (mode === 'ask') {
        snap.sessions = [mk('a1', 'waiting', {
          choice: {
            question: '要不要把 POPUP_W 从 520 抬到 568？这条问题本身要够长，好让 .ask 撑到它的 340px 上限宽度，否则量到的宽度不是 340 就白测了。',
            options: [
              { id: 'yes', label: '抬到 568（连带改 catInset 200→220）' },
              { id: 'no', label: '不抬，那 20px 出屏可接受' },
            ],
            allowInput: true,
          },
        })];
        snap.waitingCount = 1; snap.needsinputCount = 1; snap.workingCount = 0; snap.thinkingCount = 0;
      } else {
        snap.sessions = [mk('p1', 'working'), mk('p2', 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      const nb = win.getBounds();
      const cat = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        return { left: Math.round(r.left), w: Math.round(r.width) }; })()`);
      return { frame: nb, catScreenX: (cat && cat.left != null) ? nb.x + cat.left : null };
    };

    const cbox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`);
    const clickCat = async (button) => { const b = await cbox();
      if (!b || b.cx == null) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); return true; };
    // 每轮之前强制回到干净态。probes/README 记着「第一轮 peek 状态反相已累计出现 3 次」。
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){}
      try{hideAsk()}catch(e){} return 1; })()`);

    // clip* 量的是**帧**（innerWidth），offScreen* 量的是**屏幕**（workArea）。
    // 这两个必须分开报 —— H2 的整个判断就建立在「裁的是帧不是屏幕」上。
    const MEASURE = (frameX) => `(() => {
      const out = { innerW: window.innerWidth, frameX: ${frameX} };
      const stg = document.querySelector('#stage');
      out.popShift = stg ? getComputedStyle(stg).getPropertyValue('--pop-shift').trim() : '?';
      out.chipShift = stg ? getComputedStyle(stg).getPropertyValue('--chip-shift').trim() : '?';
      const WA_X = ${wa.x}, WA_R = ${wa.x + wa.width};
      for (const [name, sel] of [['peek', '#peek'], ['ask', '#ask'], ['cat', '#cat']]) {
        const n = document.querySelector(sel);
        if (!n) { out[name] = 'missing'; continue; }
        if (n.classList.contains('hidden') || n.hidden) { out[name] = 'hidden'; continue; }
        const r = n.getBoundingClientRect();
        const L = Math.round(r.left * 10) / 10, R = Math.round(r.right * 10) / 10;
        const sL = Math.round((${frameX} + L) * 10) / 10, sR = Math.round((${frameX} + R) * 10) / 10;
        out[name] = {
          L, R, w: Math.round(r.width * 10) / 10,
          clipLeft: Math.max(0, Math.round((-L) * 10) / 10),
          clipRight: Math.max(0, Math.round((R - window.innerWidth) * 10) / 10),
          screenL: sL, screenR: sR,
          offScreenLeft: Math.max(0, Math.round((WA_X - sL) * 10) / 10),
          offScreenRight: Math.max(0, Math.round((sR - WA_R) * 10) / 10),
        };
        // 容器有没有在裁自己的内容（横向溢出）—— 「消息不完整」的另一种可能形态
        out[name + 'Scroll'] = { sw: n.scrollWidth, cw: n.clientWidth, overflowX: n.scrollWidth - n.clientWidth };
      }
      return out; })()`;

    const verdict = (box) => {
      if (typeof box !== 'object' || box === null) return 'INVALID(' + box + ')';
      const clip = Math.max(box.clipLeft || 0, box.clipRight || 0);
      const off = Math.max(box.offScreenLeft || 0, box.offScreenRight || 0);
      if (clip > 0.5) return 'FRAME_CLIPPED ' + clip + 'px（内容不完整 → H2 未修净）';
      if (off > 0.5) return 'OFF_SCREEN ' + off + 'px（只探到屏幕外，帧内完整 → 可接受）';
      return 'clean';
    };

    // ════════════════════════════════════════════════════════════════════
    // 靶：.peek 和 .ask 在左/右缘各自的 clip / offScreen
    // ════════════════════════════════════════════════════════════════════
    const got = await grabFocus();
    log({ ev: 'focus', gotFocus: got });
    if (!got) log({ WARN: '没取到焦点 —— clickCat 可能不生效，下面的 opened 自检会兜住' });

    // README 记着的坑：第一轮状态可能反相。先空跑一轮预热再进正式循环。
    await reset(); seed('peek'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(300);
    log({ ev: 'warmup', done: true });

    // ── 诊断：#ask 为什么不出现 ──
    // 第一版探针 seed 了带 options+allowInput 的 waiting 会话，#ask 仍是 hidden。
    // 三层递进，能精确定位断在哪一环：
    //   L1 手工调 applyStats(快照)   → 排「前置渲染抛异常，refreshAsk 没执行到」
    //   L2 手工调 refreshAsk(快照)   → 排「refreshAsk 自己的门槛把它挡了」
    //   L3 手工填队列 + showAskPanel → 一定能开；只要 L3 开得起来，量到的几何就有效
    // ⚠️ diag 里用 eval 读顶层 let/const 会被 CSP 挡掉（页面没开 unsafe-eval），
    // 全部回 '<不可见>'。这不影响结论：L1/L2/L3 里直接写标识符（applyStats / showAskPanel）
    // 是注入代码的普通引用，不走 eval，能正常解析 —— 所以别为了 diag 去动 CSP。
    const diag = () => js(`(() => { const n = document.querySelector('#ask');
      return { askClass: n ? n.className : 'missing',
               askW: n ? Math.round(n.getBoundingClientRect().width) : null }; })()`);

    const CHOICE = `{ sessionId: 'a1', project: 'WorkMeow',
      question: '要不要把 POPUP_W 从 520 抬到 568？这条问题本身要够长，好让 .ask 撑到它的 340px 上限宽度，否则量到的宽度不是 340 就白测了。',
      options: [{ id: 'yes', label: '抬到 568（连带改 catInset 200→220）' },
                { id: 'no', label: '不抬，那 20px 出屏可接受' }], allowInput: true }`;
    const SNAP = `{ sessions: [{ sessionId: 'a1', agent: 'claude', project: 'WorkMeow', state: 'waiting',
        headless: false, updatedAt: Date.now(), startedAt: Date.now() - 60000, tokens: 12345, cost: 0.12,
        choice: ${CHOICE} }],
      waitingCount: 1, needsinputCount: 1, workingCount: 0, thinkingCount: 0, idleMs: 1000,
      today: { messages: 42, tokens: 19356, cost: 0.2 } }`;

    // L1/L2/L3 都在渲染端就地 try/catch，异常文本直接回传（否则只会静静落在 IPC 回调里）。
    // ⚠️ 逐层的门必须看**上一层的实际结果**：第一版写成 `if (!out.L2 || out.L2.hidden !== false)`，
    // L1 已经开成功时 out.L2 是 undefined → 条件为真 → 又白跑一遍 L3。实测日志里
    // L1 和 L3 同时出现、L2 缺席，就是这个 bug（结论不受影响，但会掩盖「哪一层真正管用」）。
    const askW = `(() => { const n = document.querySelector('#ask');
      return { hidden: n.classList.contains('hidden'), w: Math.round(n.getBoundingClientRect().width * 10) / 10 }; })()`;
    const forceAsk = () => js(`(() => {
      const out = {}; const open = (r) => r && r.hidden === false;
      try { applyStats(${SNAP}); out.L1 = ${askW}; } catch (e) { out.L1err = String(e.stack || e); }
      if (!open(out.L1)) {
        try { refreshAsk(${SNAP}); out.L2 = ${askW}; } catch (e) { out.L2err = String(e.stack || e); }
      }
      if (!open(out.L1) && !open(out.L2)) {
        try { answered.clear(); askQueue = [${CHOICE}]; askIdx = 0; lastAskSig = '';
              showAskPanel(); out.L3 = ${askW}; } catch (e) { out.L3err = String(e.stack || e); }
      }
      out.openedAt = open(out.L1) ? 'L1(applyStats 全链路)' : open(out.L2) ? 'L2(直调 refreshAsk)'
                   : open(out.L3) ? 'L3(手工填队列)' : '全都没开';
      out.final = ${askW};
      return out; })()`);

    await reset(); log({ ev: 'diag', when: '灌 ask 之前', d: await diag() });
    log({ ev: 'forceAsk', r: await forceAsk() });
    log({ ev: 'diag', when: '强开之后', d: await diag() });
    log({ ev: 'rendererErrors', errs: await errs() });

    for (const mode of ['peek', 'ask']) {
      for (const [label, catX] of [['左缘', wa.x], ['中间', wa.x + Math.round(wa.width / 2)],
                                   ['右缘', wa.x + wa.width - 120]]) {
        await reset(); await sleep(150);
        const sd = seed(mode); await sleep(500);
        const placed = await placeCat(catX);

        let opening = null;
        if (mode === 'peek') { await clickCat('left'); await sleep(700); }
        else {
          // #ask 不能靠 stats 推送（第一版探针实测恒 hidden，见上面 L1/L2/L3 的注释）。
          // 这里走 forceAsk 的三层递进，并把它开在哪一层记进日志 —— 走到 L3 说明
          // 绕过了 refreshAsk 的门槛，几何仍然有效（showAskPanel → fitPopup 是同一条路），
          // 但「产品里 .ask 到底怎么被触发」这条另算一笔账，不能当成本探针验过了。
          opening = await forceAsk();
          await sleep(500);
        }

        // ⚠️ 探针卫生（第一版的坑）：ask 三轮的 --pop-shift 全读到上一轮 右缘 的 -100px，
        // 连「中间」也是 —— reset() 不触发位移重算。窗口挪了之后必须显式重算一次，
        // 否则量到的是陈值，位置和几何对不上。
        const frameX0 = win.getBounds().x;
        await js(`(() => { try { applyPopupShift(${frameX0} + (window.innerWidth - 120) / 2, 120); return 1; }
                          catch (e) { return String(e); } })()`);
        await sleep(200);

        const frameX = win.getBounds().x;
        const m = await js(MEASURE(frameX));
        const target = mode === 'peek' ? (m && m.peek) : (m && m.ask);

        // 自检：目标必须**真的开着**。hidden/missing 时 clip 恒为 0，会被误读成「没裁」。
        const opened = typeof target === 'object' && target !== null && target.w > 0;
        log({
          ev: 'edge', mode, label, seeded: sd, opening,
          wantCatX: catX, gotCatX: placed.catScreenX,
          frameX, frameW: placed.frame.width, popShift: m && m.popShift,
          targetW: opened ? target.w : null,
          box: target,
          VERDICT: !opened ? 'INVALID：' + mode + ' 没打开（量到 ' + JSON.stringify(target)
                             + '），本轮数据无效，不能当成「没裁」'
                           : verdict(target),
          full: m,
        });
        await reset(); await sleep(250);
      }
    }

    log({ ev: 'rendererErrors', errs: await errs() });

    // ════════════════════════════════════════════════════════════════════
    // 欠账 1 的 A/B：修前 .ask 到底被帧裁多少？
    // 算术预测 24px（帧内余量 90 vs 旧上限 114），但 probeEdge 靶 A 只测过 peek。
    // 现在 fix(a) 已经在树里了，没法直接跑旧代码 —— 改成在渲染端把 capsuleShift
    // 包一层、**剥掉 frameWidth 入参**，行为就等价于修前那一版。同一轮、同一位置、
    // 同一个 .ask，A/B 只差这一个参数，是这个欠账能拿到的最干净的实测。
    for (const [label, catX] of [['左缘', wa.x], ['右缘', wa.x + wa.width - 120]]) {
      await reset(); await sleep(150);
      seed('ask'); await sleep(300);
      await placeCat(catX);
      const o = await forceAsk(); await sleep(400);
      const fx = win.getBounds().x;

      const ab = await js(`(() => {
        const G = window.PetGeometry, orig = G.capsuleShift;
        const shot = () => { const n = document.querySelector('#ask');
          if (n.classList.contains('hidden')) return 'hidden';
          const r = n.getBoundingClientRect();
          const L = Math.round(r.left * 10) / 10, R = Math.round(r.right * 10) / 10;
          return { L, R, w: Math.round(r.width * 10) / 10,
            popShift: getComputedStyle(document.querySelector('#stage')).getPropertyValue('--pop-shift').trim(),
            clipLeft: Math.max(0, Math.round((-L) * 10) / 10),
            clipRight: Math.max(0, Math.round((R - window.innerWidth) * 10) / 10) }; };
        const recalc = () => applyPopupShift(${fx} + (window.innerWidth - 120) / 2, 120);
        try {
          recalc(); const after = shot();
          // 剥掉 frameWidth → 等价修前
          G.capsuleShift = (a) => { const b = Object.assign({}, a); delete b.frameWidth; return orig(b); };
          recalc(); const before = shot();
          return { before, after };
        } finally { G.capsuleShift = orig; recalc(); }
      })()`);

      const mk = (s) => (typeof s === 'object' && s ? Math.max(s.clipLeft || 0, s.clipRight || 0) : null);
      log({ ev: 'ab', label, openedAt: o && o.openedAt, frameX: fx, ab,
            修前帧裁: mk(ab && ab.before), 修后帧裁: mk(ab && ab.after) });
      await reset(); await sleep(200);
    }

    log({ ev: 'done' });
    setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300);
  }, 4500);
}
// ==== /PROBE_ASK ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_ASK')) runProbeAsk();\n"


def main():
    dirty = subprocess.run(["git", "status", "--short"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("!!! worktree 不干净，探针会改写 main.js，先提交或 stash：")
        print(dirty)
        return

    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor not found"
        open(MAIN, "w", encoding="utf-8").write(src.replace(TRIGGER, TRIGGER_NEW, 1) + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_ASK": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        os.makedirs("/tmp/wm-probe-home", exist_ok=True)
        # start_new_session：探针自成进程组，超时只杀自己，绝不波及用户的 npm start
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            blob, _ = proc.communicate(timeout=200)
        except subprocess.TimeoutExpired:
            print("!!! TIMEOUT — killing probe process group")
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        blob = blob or ""
        for line in blob.splitlines():
            if "PROBE_ASK" in line:
                try:
                    o = json.loads(line.split("PROBE_ASK ", 1)[1])
                except Exception:
                    print(line); continue
                if o.get("ev") == "edge":
                    print("\n── %s @ %s ──" % (o["mode"], o["label"]))
                    print("  猫x 想=%s 实=%s  帧x=%s 帧宽=%s  --pop-shift=%s"
                          % (o["wantCatX"], o["gotCatX"], o["frameX"], o["frameW"], o["popShift"]))
                    if o.get("opening"):
                        print("  打开方式=%s" % o["opening"].get("openedAt"))
                    print("  %s 宽=%s  盒=%s" % (o["mode"], o["targetW"], json.dumps(o["box"], ensure_ascii=False)))
                    print("  ⇒ %s" % o["VERDICT"])
                elif o.get("ev") == "ab":
                    print("\n══ A/B（剥掉 frameWidth = 等价修前）@ %s ══" % o["label"])
                    print("  修前：%s" % json.dumps((o.get("ab") or {}).get("before"), ensure_ascii=False))
                    print("  修后：%s" % json.dumps((o.get("ab") or {}).get("after"), ensure_ascii=False))
                    print("  ⇒ 帧裁 %s px → %s px" % (o.get("修前帧裁"), o.get("修后帧裁")))
                else:
                    print(line)
        if "PROBE_ASK" not in blob:
            print("--- no probe output; tail ---")
            print(blob[-4000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node", "--check", MAIN], check=True)
        print("restored main.js")
        after = subprocess.run(["git", "status", "--short"], cwd=REPO,
                               capture_output=True, text=True).stdout.strip()
        print("git status 恢复后：" + (after if after else "干净"))


main()
