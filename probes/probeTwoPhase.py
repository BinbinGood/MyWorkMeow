#!/usr/bin/env python3
# 探针 #18：贴边时开/关弹窗，猫在**屏幕**上有没有横向瞬移（两进程非原子提交）。
#
# ── 为什么要重做：#16 的量法不可信，我却拿它排除了这条假设 ────────────────
# #16 量猫的屏幕位置用的是渲染端的 `window.screenX + rect.left`，报 0 帧抖动，
# 我就把「两进程非原子提交」划掉了。**那个量法本身就循环论证**：
#   - window.screenX 是渲染端读到的窗口位置，Chromium 在渲染端缓存/异步更新它；
#   - 要验证的恰恰是「帧原点和帧内偏移不同步」；
#   - 拿渲染端读到的原点去验证原点同步性 = 用嫌疑人的证词给嫌疑人作证。
# 用户实测反馈（2026-09-19）：**开窗和关窗都抖**，只在左右贴边。开窗 catShift
# 0→±50、关窗 ±50→0，方向相反、症状对称 —— 完全符合这条被我错误排除的机制。
#
# ── 干净量法：两个进程各自记账，事后按同源时间轴拼 ──────────────────────
#   渲染端 rAF 每帧记：(t_render, 猫在**帧内**的 left)     ← rect.left，不碰 screenX
#   主进程     每帧记：(t_main,   win.getBounds().x)       ← 帧原点的权威来源
#   两边时间戳都用 performance.timeOrigin + performance.now() 化到同一条 epoch 轴。
#   事后：猫屏幕x(t) = 帧原点(t) + 猫帧内left(t)   ← 对每个渲染帧，取**不晚于它**的
#                                                    最近一次主进程原点观测
#   判据：静息基线 x0；任一帧 |x - x0| > TH 即 CONFIRMED，记帧数与幅度。
#
#   ★ 为什么这样就问得出问题：如果渲染端已经写了 left(+50)、主进程还没 setBounds，
#     那一帧的 (原点旧, 帧内新) 组合算出来就是 x0+50 —— 正是用户看到的横移。
#     反之若两者同帧提交，任何 t 上两项都配对，x 恒等于 x0。
#
#   ⚠️ 主进程侧采样频率是这个量法的精度上限。用 setInterval(0)（实测 ~1ms）
#     密采 getBounds，比一帧(8.2ms)细一个数量级，够分辨「半帧级」的错配。
#     同时记录每次 setBounds 的调用时刻（patch 一层 wrapper），这样不止能说
#     「抖了」，还能说「抖在 DOM 写入与 setBounds 之间的那一段」。
#
# ── 靶位 ──────────────────────────────────────────────────────────────────
#   P  .peek 贴右缘（catShift 预期 +30）
#   A  .ask  贴右缘（+50）
#   M  .ask  贴左缘（-50）
#   C  .ask  居中对照（catShift 恒 0 → 必须干净；用户说只在贴边出现）
#   每靶分别测「开窗」和「关窗」两段 —— 用户说两边都抖。
#
# ⚠️ 只临时改写 main.js（探针入口 + 不隐藏 dock + setBounds 记账 wrapper），
#    **renderer/pet.js 零注入**（跑前自证 git diff 为空）。跑完自动恢复。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeTwoPhase.bak"

PROBE = r"""
// ==== PROBE_TWOPHASE (临时) ====
function runProbeTwoPhase() {
  const log = (o) => console.log('PROBE_TWOPHASE ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const TH = 1.0;            // 屏幕横移门槛 px（用户说「小范围」；1px 已经能看见）
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    try { clearInterval(statsTimer); statsTimer = null; log({ ev: 'killStatsTimer', ok: true }); }
    catch (e) { log({ ev: 'killStatsTimer', err: String(e) }); }

    // 主进程与渲染端化到同一条 epoch 轴。主进程这边用 performance（Node 也有）。
    const { performance: perf } = require('perf_hooks');
    const mNow = () => perf.timeOrigin + perf.now();

    // ── setBounds 记账 wrapper：记下每次帧原点变更的**时刻**和新旧 x ──
    // 不改变行为，只旁路记录。抖动窗口 = [DOM 写入, 这一刻] 之间。
    const sbLog = [];
    if (!win.__sbHooked) {
      win.__sbHooked = 1;
      const orig = win.setBounds.bind(win);
      win.setBounds = function (b, ...rest) {
        let before = null; try { before = orig.call ? win.getBounds().x : null; } catch {}
        const t0 = mNow();
        const r = orig(b, ...rest);
        let after = null; try { after = win.getBounds().x; } catch {}
        sbLog.push({ t: t0, tEnd: mNow(), reqX: b && b.x, before, after });
        return r;
      };
    }

    // ── 主进程侧密采帧原点 ──
    let originLog = [];
    let originTimer = null;
    const startOrigin = () => {
      originLog = [];
      const tick = () => { try { const b = win.getBounds(); originLog.push([mNow(), b.x, b.width]); } catch {} };
      tick();
      originTimer = setInterval(tick, 0);   // 实测 ~1ms，比一帧细一个数量级
    };
    const stopOrigin = () => { if (originTimer) clearInterval(originTimer); originTimer = null; return originLog; };

    await js(`(() => { window.__probeErrs = window.__probeErrs || [];
      if (!window.__probeHooked) { window.__probeHooked = 1;
        window.addEventListener('error', (e) => window.__probeErrs.push(
          String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
        window.addEventListener('unhandledrejection', (e) => window.__probeErrs.push(
          'reject: ' + String(e.reason && e.reason.stack || e.reason)));
      } return { hooked: 1 }; })()`);
    const errs = () => js('(window.__probeErrs || []).slice(-8)');

    // ── 产品符号门（确认测的是落地版）──
    const pre = await js(`(() => { const r = {};
      r.popupShiftPlan = typeof popupShiftPlan === 'function';
      r.applyCatShift = typeof applyCatShift === 'function';
      try { r.appliedCatShift = appliedCatShift; } catch (e) { r.appliedCatShift = 'unreachable'; }
      r.catInCompactRow = !!(document.querySelector('#compact-row')
                             && document.querySelector('#compact-row').contains(document.getElementById('cat')));
      return r; })()`);
    log({ ev: 'pre', pre });
    if (!(pre && pre.popupShiftPlan && pre.applyCatShift)) log({ FATAL: '产品符号门没过', pre });

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
        snap.sessions = [mk('ask-' + uid, 'waiting', {
          choice: {
            question: '贴边开关弹窗时,猫在屏幕上会不会横向瞬移?这条问题要够长,好让 .ask 撑到 340px 上限。',
            options: [{ id: 'yes', label: '不移' }, { id: 'no', label: '移了' }],
          },
        })];
        snap.workingCount = 0; snap.thinkingCount = 0; snap.waitingCount = 1; snap.needsinputCount = 1;
      } else {
        snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
        snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      }
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

    const forceShow = () => js(`(() => {
      try {
        const items = (lastStats && lastStats.sessions || []).map((x) => x.choice).filter(Boolean);
        if (!items.length) return 'no choice in lastStats';
        answered.clear(); askQueue = items; askIdx = 0; lastAskSig = '';
        showAskPanel(); return 'ok';
      } catch (e) { return 'forceShow threw: ' + String(e.stack || e); }
    })()`);

    const placeCat = async (catScreenX) => {
      const b = win.getBounds();
      const inset = (b.width - 120) / 2;
      win.setBounds({ x: Math.round(catScreenX - inset),
                      y: Math.round(wa.y + wa.height / 2 - 150),
                      width: b.width, height: b.height });
      const st = stOf(); if (st) applyPetSize(st, null);
      await sleep(400);
      return win.getBounds();
    };

    const cbox = () => js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`);
    const clickCat = async (button) => { const b = await cbox();
      if (!b || b.cx == null) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: b.cx, y: b.cy }); await sleep(25);
      wc.sendInputEvent({ type: 'mouseDown', x: b.cx, y: b.cy, button, clickCount: 1 }); await sleep(35);
      wc.sendInputEvent({ type: 'mouseUp', x: b.cx, y: b.cy, button, clickCount: 1 }); return true; };
    const reset = () => js(`(() => { try{closeRadial()}catch(e){} try{closePeek()}catch(e){}
      try{hideAsk()}catch(e){} return 1; })()`);

    // ── 渲染端逐帧记「猫在帧内的 left」+ 同源时间戳。**不碰 window.screenX** ──
    const startWatch = () => js(`(() => {
      window.__tp = []; window.__tpOn = 1;
      const T0 = performance.timeOrigin;
      const tick = () => {
        if (!window.__tpOn) return;
        const cat = document.querySelector('#cat');
        if (cat) {
          const r = cat.getBoundingClientRect();
          let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
          // [t(epoch), 猫帧内left, 猫宽, appliedCatShift, innerWidth]
          window.__tp.push([T0 + performance.now(),
                            Math.round(r.left * 10) / 10,
                            Math.round(r.width * 10) / 10,
                            ap, window.innerWidth]);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 1; })()`);
    const stopWatch = () => js(`(() => { window.__tpOn = 0; return window.__tp || []; })()`);

    // ── 拼接：对每个渲染帧，取不晚于它的最近一次主进程原点观测 ──
    const join = (frames, origins, label, sbSlice) => {
      if (!Array.isArray(frames) || !frames.length) return { label, err: 'no frames' };
      if (!Array.isArray(origins) || !origins.length) return { label, err: 'no origins' };
      const rows = [];
      let oi = 0;
      for (const f of frames) {
        const t = f[0];
        while (oi + 1 < origins.length && origins[oi + 1][0] <= t) oi++;
        // 落在第一次观测之前的帧丢掉（没有对应的原点，拼不了）
        if (origins[oi][0] > t) continue;
        rows.push({ t, frameX: origins[oi][1], frameW: origins[oi][2],
                    localLeft: f[1], catW: f[2], applied: f[3], innerW: f[4],
                    screenX: Math.round((origins[oi][1] + f[1]) * 10) / 10,
                    lagMs: Math.round((t - origins[oi][0]) * 100) / 100 });
      }
      if (!rows.length) return { label, err: 'join empty' };
      // 基线取**众数**而不是首帧：首帧可能正好落在瞬移里。
      const cnt = new Map();
      for (const r of rows) cnt.set(r.screenX, (cnt.get(r.screenX) || 0) + 1);
      let base = rows[0].screenX, bestN = -1;
      for (const [v, n] of cnt) if (n > bestN) { bestN = n; base = v; }
      let bad = 0, maxDev = 0; const samples = [];
      for (const r of rows) {
        const dev = Math.round((r.screenX - base) * 10) / 10;
        if (Math.abs(dev) > TH) {
          bad++;
          if (Math.abs(dev) > Math.abs(maxDev)) maxDev = dev;
          if (samples.length < 10) samples.push({
            dtMs: Math.round(r.t - rows[0].t), dev, screenX: r.screenX,
            frameX: r.frameX, localLeft: r.localLeft, applied: r.applied, lagMs: r.lagMs });
        }
      }
      return { label, frames: rows.length,
               spanMs: Math.round(rows[rows.length - 1].t - rows[0].t),
               baseScreenX: base, baseFrames: bestN,
               distinctScreenX: [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
               badFrames: bad, maxDevPx: maxDev, samples,
               setBounds: sbSlice.map((s) => ({ dtMs: Math.round(s.t - rows[0].t),
                                                durMs: Math.round((s.tEnd - s.t) * 100) / 100,
                                                reqX: s.reqX, before: s.before, after: s.after })) };
    };

    log({ ev: 'focus', gotFocus: await grabFocus() });

    const results = {};
    const TARGETS = [
      { id: 'P', desc: '.peek 贴右缘', mode: 'peek', at: () => wa.x + wa.width - 60, predicted: 30 },
      { id: 'A', desc: '.ask 贴右缘',  mode: 'ask',  at: () => wa.x + wa.width - 60, predicted: 50 },
      { id: 'M', desc: '.ask 贴左缘',  mode: 'ask',  at: () => wa.x + 60,            predicted: -50 },
      { id: 'C', desc: '.ask 居中对照', mode: 'ask', at: () => wa.x + Math.round(wa.width / 2), predicted: 0 },
    ];

    for (const T of TARGETS) {
      await reset(); await sleep(350);
      seed(T.mode === 'ask' ? 'ask' : 'peek', T.id);
      await sleep(400);
      await placeCat(T.at());
      await sleep(500);

      const rest = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        return { localLeft: Math.round(r.left * 10) / 10, applied: ap,
                 frameW: window.innerWidth }; })()`);
      const restB = win.getBounds();

      // ── 开窗段 ──
      startOrigin(); await startWatch(); await sleep(120);
      const sbMark0 = sbLog.length;
      if (T.mode === 'ask') { await js('(()=>{try{hideAsk()}catch(e){} return 1})()'); await sleep(60);
                              await forceShow(); }
      else { await clickCat('left'); }
      await sleep(1100);
      const framesO = await stopWatch(); const originsO = stopOrigin();
      const sbO = sbLog.slice(sbMark0);
      const openA = join(framesO, originsO, T.id + '/open', sbO);

      const openSnap = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        return { localLeft: Math.round(r.left * 10) / 10, applied: ap }; })()`);
      const openB = win.getBounds();

      // ── 关窗段 ──
      startOrigin(); await startWatch(); await sleep(120);
      const sbMark1 = sbLog.length;
      await reset();
      await sleep(900);
      const framesC = await stopWatch(); const originsC = stopOrigin();
      const sbC = sbLog.slice(sbMark1);
      const closeA = join(framesC, originsC, T.id + '/close', sbC);

      const postSnap = await js(`(() => { const r = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = null; }
        return { localLeft: Math.round(r.left * 10) / 10, applied: ap }; })()`);
      const postB = win.getBounds();

      results[T.id] = { desc: T.desc, predicted: T.predicted,
        rest: { ...rest, frameX: restB.x, screenX: restB.x + rest.localLeft },
        open: { ...openSnap, frameX: openB.x, screenX: openB.x + openSnap.localLeft },
        post: { ...postSnap, frameX: postB.x, screenX: postB.x + postSnap.localLeft },
        openA, closeA };
      log({ ev: 'target', id: T.id, r: results[T.id] });
      await reset(); await sleep(400);
    }

    log({ ev: 'errs', errs: await errs() });

    // ── 判决 ──
    const verdict = [];
    for (const id of Object.keys(results)) {
      const r = results[id];
      verdict.push('— ' + id + ' ' + r.desc + '（catShift 预期 ' + r.predicted
        + '，实测 open.applied=' + r.open.applied + '）');
      verdict.push('   三态猫屏幕x: 静息 ' + r.rest.screenX + ' → 开 ' + r.open.screenX
        + ' → 关后 ' + r.post.screenX
        + '  (帧原点 ' + r.rest.frameX + '/' + r.open.frameX + '/' + r.post.frameX + ')');
      for (const A of [r.openA, r.closeA]) {
        if (A.err) { verdict.push('   ' + A.label + ': ⚠️ ' + A.err); continue; }
        if (A.badFrames > 0) {
          verdict.push('   ★★ ' + A.label + ' 横移 CONFIRMED：' + A.badFrames + '/' + A.frames
            + ' 帧，最大 ' + A.maxDevPx + 'px（基线 ' + A.baseScreenX + '，占 ' + A.baseFrames + ' 帧）');
        } else {
          verdict.push('   ✓ ' + A.label + ' 干净：0/' + A.frames + ' 帧偏离（基线 '
            + A.baseScreenX + '）');
        }
      }
    }
    log({ ev: 'SUMMARY', verdict });
    for (const id of Object.keys(results)) {
      log({ ev: 'detail', id, openA: results[id].openA, closeA: results[id].closeA });
    }
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_TWOPHASE')) runProbeTwoPhase();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_TWOPHASE')) app.dock.hide(); } catch {}"


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
            print("ABORT: main.js 里的锚点命中 %d 次（要求恰好 1 次）:\n%s" % (n, needle))
            return 1

    shutil.copy(MAIN, BAK_MAIN)
    try:
        open(MAIN, "w", encoding="utf-8").write(
            msrc.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误 main.js:\n%s" % chk.stderr)
            return 1
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过，这一轮测的就不是产品行为了")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_TWOPHASE": "1", "HOME": "/tmp/wm-probe-home",
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
            if "PROBE_TWOPHASE" in line:
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
