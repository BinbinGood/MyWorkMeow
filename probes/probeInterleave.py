#!/usr/bin/env python3
# 探针 #19：贴边开/关弹窗时，「猫的帧内偏移落地」和「帧原点落地」之间，
#           **有没有夹着一次真实的帧提交**。夹住了就等于屏幕上画出了一帧错位。
#
# ── 为什么 #18 问不出来（我自己的量法第二个洞）────────────────────────────
# #18 每帧读 getBoundingClientRect().left + 主进程 getBounds().x，报 0/77 干净。
# 但 rect 读的是**布局值**：样式一写进去它当帧就变；而屏幕上的**像素**要等合成器
# 提交。rAF 回调跑在该帧 paint **之前**，所以：
#   帧 N 的 rAF 读到 left=200（旧）→ 我记一行「干净」
#   紧接着同一帧的脚本里 applyCatShift 写 left=250 → 帧 N **带着 250 提交**
#   而帧原点还是旧的 1120 → 屏幕上这一帧猫在 1370，跳了 +50
# 我记的那行「干净」正是这一帧。**我量的是账面，用户看的是像素。**
#
# ── 干净量法：不量位置，量**时序交错** ────────────────────────────────────
#   T_dom : #compact-row 的 style 被写的时刻（MutationObserver，零产品改动）
#   T_sb  : 主进程 win.setBounds 的时刻（wrapper）
#   T_f[] : 每一次帧提交的时刻（rAF 入口 = 该帧开始，提交在它之后）
#   判据：[min(T_dom,T_sb), max(T_dom,T_sb)] 这段里，只要落进一个 T_f，
#         那一帧必然以「新帧内偏移 + 旧帧原点」（或反之）提交 → 屏幕上画出错位。
#   两个方向都算数：T_sb < T_dom 也一样坏（旧偏移 + 新原点，反向跳）。
#
#   ★ 为什么这个判据可信：它不依赖任何「位置读数」，只依赖三串时间戳，
#     而三串都来自各自那一侧的权威点（DOM 写入 / setBounds 调用 / rAF）。
#     #16 的 window.screenX 和 #18 的 rect 都是「读数」，这次一个都不用。
#
#   ⚠️ 已知偏保守：真实窗口移动比 setBounds 返回还要晚（要过 window server），
#     所以实测间隙是**下界**。夹到帧 = 确认有问题；夹不到 ≠ 一定没问题。
#
# ── 靶位（修了 #18 的不对称）──────────────────────────────────────────────
#   placeCat 收的是猫的**左边**。#18 里右靶被主进程 clampCatOrigin 拉到齐右缘
#   (猫左=1320，紧贴)，左靶却停在 60、离边还差 60px → popupShiftPlan 算出 0 位移，
#   M 靶白跑了（applied=0, setBounds 空）。这次左靶传 wa.x-60，让 clamp 把它推到齐左。
#
# ⚠️ 只临时改写 main.js（探针入口 + 不隐藏 dock + setBounds 记账）。
#    **renderer/pet.js 零注入**（跑前自证 git diff 为空）。跑完自动恢复。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeInterleave.bak"

PROBE = r"""
// ==== PROBE_INTERLEAVE (临时) ====
function runProbeInterleave() {
  const log = (o) => console.log('PROBE_INTERLEAVE ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });
    try { clearInterval(statsTimer); statsTimer = null; } catch {}

    const { performance: perf } = require('perf_hooks');
    const mNow = () => perf.timeOrigin + perf.now();

    // ── setBounds 记账（旁路，不改行为）──
    const sbLog = [];
    if (!win.__ilHooked) {
      win.__ilHooked = 1;
      const orig = win.setBounds.bind(win);
      win.setBounds = function (b, ...rest) {
        let before = null; try { before = win.getBounds().x; } catch {}
        const t = mNow();
        const r = orig(b, ...rest);
        const tEnd = mNow();
        let after = null; try { after = win.getBounds().x; } catch {}
        // stack 取一行，用来分辨是 applyPetSize 还是 keepCatOnScreen 发的
        let site = '';
        try { site = (new Error().stack.split('\n')[2] || '').trim().slice(0, 78); } catch {}
        sbLog.push({ t, tEnd, reqX: b && b.x, reqW: b && b.width, before, after, site });
        return r;
      };
    }

    await js(`(() => { window.__ilErrs = window.__ilErrs || [];
      if (!window.__ilHooked) { window.__ilHooked = 1;
        window.addEventListener('error', (e) => window.__ilErrs.push(String(e.message)));
        window.addEventListener('unhandledrejection', (e) => window.__ilErrs.push('reject: ' + String(e.reason)));
      } return 1; })()`);

    const pre = await js(`(() => ({ plan: typeof popupShiftPlan === 'function',
      shift: typeof applyCatShift === 'function',
      row: !!document.querySelector('#compact-row') }))()`);
    log({ ev: 'pre', pre });

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    const seed = (mode, uid) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return String(e); }
      const now = Date.now();
      const mk = (id, state, extra) => Object.assign({
        sessionId: id, agent: 'claude', project: 'WorkMeow', state,
        headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12,
      }, extra || {});
      if (mode === 'ask') {
        snap.sessions = [mk('ask-' + uid, 'waiting', { choice: {
          question: '贴边开关弹窗时,猫在屏幕上会不会横向瞬移?这条问题要够长,好让 .ask 撑到 340px 上限。',
          options: [{ id: 'yes', label: '不移' }, { id: 'no', label: '移了' }] } })];
        snap.workingCount = 0; snap.thinkingCount = 0; snap.waitingCount = 1; snap.needsinputCount = 1;
      } else {
        snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000; snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

    const forceShow = () => js(`(() => { try {
      const items = (lastStats && lastStats.sessions || []).map((x) => x.choice).filter(Boolean);
      if (!items.length) return 'no choice';
      answered.clear(); askQueue = items; askIdx = 0; lastAskSig = '';
      showAskPanel(); return 'ok';
    } catch (e) { return 'threw: ' + String(e.stack || e); } })()`);

    // placeCat 收的是猫的**左边**屏幕 x（帧内 inset 恒 200）
    const placeCat = async (catLeft) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catLeft - inset),
                      y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      return win.getBounds();
    };

    const cbox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`);
    const clickCat = async () => { const b = await cbox();
      if (!b || b.cx == null) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button: 'left', clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button: 'left', clickCount: 1 }); return true; };
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){}
      try{hideAsk()}catch(e){} return 1; })()`);

    // ── 渲染端：MutationObserver 记 style 写入时刻 + rAF 记帧提交时刻 ──
    // MutationObserver 回调是当前 task 末尾的微任务 → 时间戳 = 那个 task 的末尾。
    // 正好是我们要的：paint 只能发生在 task 之间，所以「task 末尾」就是这次写入
    // 能被画出来的最早时刻。零产品改动。
    const startWatch = () => js(`(() => {
      const T0 = performance.timeOrigin;
      window.__ilDom = []; window.__ilFrame = []; window.__ilOn = 1;
      const row = document.querySelector('#compact-row');
      if (!row) return 'no row';
      if (window.__ilMo) window.__ilMo.disconnect();
      // ⚠️ 必须用 oldValue，不能在回调里读 row.style.left：MutationObserver 回调是
      // **批量异步**的（当前 task 末尾一次性交付所有 record），回调里读到的永远是
      // 最终状态。applyCatShift 写 position+left 两个属性 → 两条 record，两条都会
      // 读到同一个终值，于是「变了几次」完全看不出来（探针 #19 第一版就栽在这）。
      // oldValue 给的是每条 record **发生前**的整个 style 串，序列可精确重建。
      window.__ilMo = new MutationObserver((recs) => {
        if (!window.__ilOn) return;
        const t = T0 + performance.now();
        for (const rec of recs) {
          if (rec.attributeName !== 'style') continue;
          window.__ilDom.push([t, String(rec.oldValue == null ? '' : rec.oldValue)]);
        }
      });
      window.__ilMo.observe(row, { attributes: true, attributeFilter: ['style'],
                                   attributeOldValue: true });
      const tick = () => {
        if (!window.__ilOn) return;
        const cat = document.querySelector('#cat');
        const r = cat ? cat.getBoundingClientRect() : null;
        // [帧开始时刻, 猫帧内left, 该帧 rAF 里看到的 row.style.left]
        window.__ilFrame.push([T0 + performance.now(),
                               r ? Math.round(r.left * 10) / 10 : null,
                               row.style.left || '']);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 'ok'; })()`);
    const stopWatch = () => js(`(() => { window.__ilOn = 0;
      if (window.__ilMo) window.__ilMo.disconnect();
      const row = document.querySelector('#compact-row');
      return { dom: window.__ilDom || [], frame: window.__ilFrame || [],
               finalStyle: row ? String(row.getAttribute('style') || '') : '' }; })()`);

    // 从 style 串里抠出 left 值。oldValue 是整串，只比 left 这一项。
    const leftOf = (s) => { const m = /(?:^|;)\s*left\s*:\s*([^;]+)/.exec(String(s || '')); return m ? m[1].trim() : ''; };

    // ── 分析：把三串时间戳合成一条轴，看 [T_dom, T_sb] 之间夹了几帧 ──
    const analyze = (w, sb, label) => {
      const dom = (w && w.dom || []);
      const frames = (w && w.frame || []);
      if (!frames.length) return { label, err: 'no frames' };
      const t0 = frames[0][0];
      const rel = (t) => Math.round((t - t0) * 100) / 100;

      // 重建序列：第 i 条 record 的 oldValue = 第 i 次写入**前**的状态，
      // 写入**后**的状态 = 第 i+1 条的 oldValue（最后一条用 finalStyle）。
      // 只留 left 真的变了的那些。
      const changes = [];
      for (let i = 0; i < dom.length; i++) {
        const from = leftOf(dom[i][1]);
        const to = leftOf(i + 1 < dom.length ? dom[i + 1][1] : (w.finalStyle || ''));
        if (from === to) continue;
        changes.push({ t: dom[i][0], from: from || '(空)', to: to || '(空)' });
      }
      // 只留真的动了 x 的 setBounds
      const moves = sb.filter((s) => s.before !== s.after);

      const events = [];
      for (const c of changes) events.push({ rel: rel(c.t), kind: 'DOM', d: c.from + '→' + c.to });
      for (const m of moves) events.push({ rel: rel(m.t), kind: 'setBounds',
        d: m.before + '→' + m.after, durMs: Math.round((m.tEnd - m.t) * 100) / 100, site: m.site });
      events.sort((a, b) => a.rel - b.rel);

      // 配对：每个 DOM 变更配它**之后最近**的 move（没有就配之前最近的，并标 reversed）
      const pairs = [];
      for (const c of changes) {
        let m = moves.find((x) => x.t >= c.t);
        let reversed = false;
        if (!m) { const before = moves.filter((x) => x.t < c.t); m = before[before.length - 1]; reversed = !!m; }
        if (!m) { pairs.push({ dom: rel(c.t), change: c.from + '→' + c.to, sb: null, err: '没有配对的帧移' }); continue; }
        const lo = Math.min(c.t, m.t), hi = Math.max(c.t, m.t);
        const caught = frames.filter((f) => f[0] > lo && f[0] < hi);
        pairs.push({
          dom: rel(c.t), change: c.from + '→' + c.to,
          sb: rel(m.t), sbMove: m.before + '→' + m.after, reversed,
          gapMs: Math.round((m.t - c.t) * 100) / 100,
          framesInGap: caught.length,
          gapFrames: caught.slice(0, 6).map((f) => ({ rel: rel(f[0]), catLeft: f[1], styleLeft: f[2] })),
        });
      }
      return { label, totalFrames: frames.length,
               spanMs: Math.round(frames[frames.length - 1][0] - t0),
               domWrites: dom.length, changes: changes.length, moves: moves.length,
               events: events.slice(0, 14), pairs };
    };

    log({ ev: 'focus', gotFocus: await grabFocus() });

    const results = {};
    const TARGETS = [
      { id: 'P', desc: '.peek 齐右缘', mode: 'peek', at: () => wa.x + wa.width - 60 },
      { id: 'A', desc: '.ask 齐右缘',  mode: 'ask',  at: () => wa.x + wa.width - 60 },
      { id: 'M', desc: '.ask 齐左缘',  mode: 'ask',  at: () => wa.x - 60 },
      { id: 'C', desc: '.ask 居中对照', mode: 'ask', at: () => wa.x + Math.round(wa.width / 2) },
    ];

    for (const T of TARGETS) {
      await reset(); await sleep(350);
      seed(T.mode === 'ask' ? 'ask' : 'peek', T.id);
      await sleep(400);
      await placeCat(T.at());
      await sleep(600);
      const rest = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        return { catLeft: Math.round(r.left * 10) / 10, applied: ap, frameW: window.innerWidth }; })()`);
      const restB = win.getBounds();

      // 开窗
      await startWatch(); await sleep(150);
      const mk0 = sbLog.length;
      if (T.mode === 'ask') { await js('(()=>{try{hideAsk()}catch(e){} return 1})()'); await sleep(80);
                              await forceShow(); }
      else { await clickCat(); }
      await sleep(1100);
      const wO = await stopWatch();
      const openA = analyze(wO, sbLog.slice(mk0), T.id + '/open');
      const openSnap = await js(`(() => { let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        return { applied: ap, styleLeft: document.querySelector('#compact-row').style.left || '' }; })()`);

      // 关窗
      await startWatch(); await sleep(150);
      const mk1 = sbLog.length;
      await reset();
      await sleep(1000);
      const wC = await stopWatch();
      const closeA = analyze(wC, sbLog.slice(mk1), T.id + '/close');

      results[T.id] = { desc: T.desc, rest: { ...rest, frameX: restB.x }, openSnap, openA, closeA };
      log({ ev: 'target', id: T.id, desc: T.desc, rest: results[T.id].rest, openSnap });
      log({ ev: 'open', id: T.id, a: openA });
      log({ ev: 'close', id: T.id, a: closeA });
      await reset(); await sleep(400);
    }

    log({ ev: 'errs', errs: await js('(window.__ilErrs || []).slice(-6)') });

    const verdict = [];
    for (const id of Object.keys(results)) {
      const r = results[id];
      verdict.push('— ' + id + ' ' + r.desc + '（静息 catLeft=' + r.rest.catLeft
        + ' frameX=' + r.rest.frameX + ' applied=' + r.rest.applied
        + ' → 开窗 applied=' + r.openSnap.applied + '）');
      for (const A of [r.openA, r.closeA]) {
        if (A.err) { verdict.push('   ' + A.label + ': ⚠️ ' + A.err); continue; }
        if (!A.changes) { verdict.push('   · ' + A.label + '：猫帧内偏移没变过（' + A.moves + ' 次帧移）→ 无缝可夹'); continue; }
        for (const p of A.pairs) {
          if (p.err) { verdict.push('   ⚠️ ' + A.label + ' ' + p.change + '：' + p.err); continue; }
          const tag = p.framesInGap > 0 ? '★★ 夹到帧' : '✓ 没夹到帧';
          verdict.push('   ' + tag + ' ' + A.label + '  DOM ' + p.change + ' @' + p.dom
            + 'ms → setBounds ' + p.sbMove + ' @' + p.sb + 'ms  间隙 ' + p.gapMs
            + 'ms' + (p.reversed ? '(反序)' : '') + '，其间提交 ' + p.framesInGap + ' 帧');
        }
      }
    }
    log({ ev: 'SUMMARY', verdict });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_INTERLEAVE')) runProbeInterleave();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_INTERLEAVE')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js。先提交或 stash：")
        print(dirty)
        return 1

    msrc = open(MAIN, encoding="utf-8").read()
    for needle in (TRIGGER, DOCK):
        n = msrc.count(needle)
        if n != 1:
            print("ABORT: main.js 锚点命中 %d 次（要求 1 次）:\n%s" % (n, needle))
            return 1

    shutil.copy(MAIN, BAK_MAIN)
    try:
        open(MAIN, "w", encoding="utf-8").write(
            msrc.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误:\n%s" % chk.stderr)
            return 1
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_INTERLEAVE": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 300s")
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass
            out = ""
        finally:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                pass

        for line in (out or "").splitlines():
            if "PROBE_INTERLEAVE" in line:
                print(line)
    finally:
        shutil.copy(BAK_MAIN, MAIN)
        rc = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True).returncode
        print("restored main.js, node --check rc=%d" % rc)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)


if __name__ == "__main__":
    raise SystemExit(main())
