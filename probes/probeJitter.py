#!/usr/bin/env python3
# 探针 #16：关窗（和开窗）瞬间猫会不会**真的**在屏幕上横跳一下 —— 用户报的
# 「气泡关闭时喵小范围左右抖动」。目标是证实/证伪，不含任何候选修法。
#
# ── 为什么 #15 说「零跳帧」却还是抖 ──────────────────────────────────────
# #15 的 startWatch 采的是 `window.screenX + rect.left`（probeShipped.py:212）。
#   · rect.left        渲染进程自己的值，改完立刻生效
#   · window.screenX   **主进程推过来的缓存**，不是权威窗口位置
# 如果这两个值在渲染进程里是同一拍更新的，它们的**和**就永远恒定 —— 屏幕上猫
# 已经抖过一下了，探针却报 0 次跳变。和 H2 犯的是同一个错：在一个测不到真相的
# 坐标系里宣布结论（H2 扫的是弹窗屏幕坐标，真正在裁的是帧内坐标）。
# ⚠️ 所以本轮**不复用** #15 的 watch，换权威源：
#   · 帧位置  ← 主进程 win.getBounds().x（唯一权威）
#   · 猫帧内位置 ← 渲染端 rect.left
#   · 两侧各自打 **epoch 绝对时间戳**（performance.timeOrigin + performance.now()，
#     主/渲染两端都有、同一面墙钟），事后离线对齐
#
# ── 可见性的判据（不是「值变了」而是「画出来过」）────────────────────────
# 猫在屏幕上的位置 = frameX(t) + rectLeft(t)。两者由两个进程各自提交、无法原子。
# rAF 回调 ≈ 一次 paint，所以判据是：
#   在「rectLeft 已改」到「getBounds().x 已改」这段区间里，**有没有 rAF 采到样**？
#   有 → 那些帧真的画出去过 → 用户看得见。幅度 = |合成值 - 稳态值|。
# 另外用 MutationObserver 盯 #compact-row 的 style 属性，拿到比 rAF 更细的
# 「DOM 何时改的」时刻（只读观察，pet.js 一个字节不动）。
#
# 跳变门槛从 #15 的 2px 降到 **0.5px** —— 用户说的是「小范围」。
#
# ── 靶位 ──────────────────────────────────────────────────────────────────
#   P  .peek 贴右缘（预测幅度 catShift=+30）
#   A  .ask  贴右缘（预测 +50）
#   M  .ask  贴左缘（预测 -50）
#   C  .ask  居中对照（catShift 恒 0 → 预测幅度 0，用来排除「抖动本来就有」）
# 每靶开窗、关窗各测一段。
#
# ⚠️ 只临时改写 main.js（探针入口 + 不隐藏 dock），**pet.js 零注入**（跑前自证）。
#    跑前 worktree 必须干净，跑完自动恢复。

import os, shutil, subprocess, signal

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK_MAIN = "/tmp/main.js.probeJitter.bak"

# ════════════════════════════════════════════════════════════════════════════
# 打进 main.js 的测量探针（渲染端零注入）
# ════════════════════════════════════════════════════════════════════════════

PROBE = r"""
// ==== PROBE_JITTER (临时) ====
function runProbeJitter() {
  const log = (o) => console.log('PROBE_JITTER ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const nowAbs = () => performance.timeOrigin + performance.now();   // epoch ms（主进程侧）
  const JUMP_TH = 0.5;          // ★ 门槛 0.5px（#15 用的 2px 会漏掉「小范围」抖动）
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // 4s 心跳会把假快照冲掉（#10 踩过）
    try { clearInterval(statsTimer); statsTimer = null; log({ ev: 'killStatsTimer', ok: true }); }
    catch (e) { log({ ev: 'killStatsTimer', err: String(e) }); }

    await js(`(() => { window.__probeErrs = window.__probeErrs || [];
      if (!window.__probeHooked) { window.__probeHooked = 1;
        window.addEventListener('error', (e) => window.__probeErrs.push(
          String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
        window.addEventListener('unhandledrejection', (e) => window.__probeErrs.push(
          'reject: ' + String(e.reason && e.reason.stack || e.reason)));
      } return { hooked: 1 }; })()`);
    const errs = () => js('(window.__probeErrs || []).slice(-8)');

    // ── 产品符号门（查的是产品符号，不是注入的）──
    const fixPresent = await js(`(() => { const r = {};
      r.popupShiftPlan = typeof popupShiftPlan === 'function';
      r.applyCatShift = typeof applyCatShift === 'function';
      try { r.POPUP_SHADOW_SPREAD = POPUP_SHADOW_SPREAD; } catch (e) { r.POPUP_SHADOW_SPREAD = 'unreachable'; }
      try { r.appliedCatShift = appliedCatShift; } catch (e) { r.appliedCatShift = 'unreachable'; }
      return r; })()`);
    log({ ev: 'fixPresent', fixPresent });
    const shipOK = fixPresent && fixPresent.popupShiftPlan && fixPresent.applyCatShift
      && fixPresent.appliedCatShift === 0;
    if (!shipOK) log({ FATAL: '产品符号门没过，判据会失效', fixPresent });

    // ── ★ 两端墙钟一致性自检：不一致的话整套离线对齐就是废的 ──
    {
      const t0 = nowAbs();
      const tr = await js('performance.timeOrigin + performance.now()');
      const t1 = nowAbs();
      const skew = (typeof tr === 'number') ? Math.round((tr - (t0 + t1) / 2) * 100) / 100 : 'n/a';
      log({ ev: 'clockSkew', mainMid: Math.round((t0 + t1) / 2), renderer: Math.round(tr),
            skewMs: skew, ipcRoundTripMs: Math.round((t1 - t0) * 100) / 100,
            note: '|skew| 应远小于一帧(16.7ms)，否则对齐不可信' });
    }

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
            question: '关窗瞬间猫会不会横跳?帧内挪 left 和主进程挪 setBounds 是两个进程、无法原子提交。这条问题要够长,好让 .ask 撑到 340px 上限。',
            options: [{ id: 'yes', label: '不抖' }, { id: 'no', label: '抖' }],
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
        answered.clear();
        askQueue = items; askIdx = 0; lastAskSig = '';
        showAskPanel();
        return 'ok';
      } catch (e) { return 'forceShow threw: ' + String(e.stack || e); }
    })()`);

    // 摆猫。必须在 catShift 已归零时调用（#14 的假跳变教训）
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

    const cleanState = async () => {
      const r = await js(`(() => { const cr = document.querySelector('#compact-row');
        const cs = getComputedStyle(cr);
        const c = document.querySelector('#cat').getBoundingClientRect();
        let ap; try { ap = appliedCatShift; } catch (e) { ap = 'unreachable'; }
        return { pos: cs.position, left: cs.left, rectLeft: Math.round(c.left * 10) / 10,
                 innerW: window.innerWidth, applied: ap }; })()`);
      const fb = win.getBounds();
      const zero = r && (r.left === 'auto' || r.left === '0px') && r.applied === 0;
      return Object.assign({}, r, { frameX: fb.x, frameW: fb.width,
                                    catScreenL: r && r.rectLeft != null ? Math.round(r.rectLeft + fb.x) : null,
                                    zero: !!zero });
    };

    // ════════════════════════════════════════════════════════════════════
    // ★ 本探针的核心：双端采样 + 离线对齐
    //   主进程侧：setInterval(1ms) 轮询 win.getBounds().x，**只在变化时记点**
    //             （变化点的时间戳才是要的东西；恒定段不必占输出）
    //   渲染端  ：rAF 记 [t_abs, rect.left]，rAF ≈ 一次 paint，所以「有没有采到样」
    //             就等于「有没有画出去过」
    //   另加    ：MutationObserver 盯 #compact-row 的 style 属性，拿比 rAF 更细的
    //             DOM 改动时刻
    // ════════════════════════════════════════════════════════════════════
    let boundsSamples = null, boundsTimer = null, boundsPolls = 0;
    const startBoundsWatch = () => {
      boundsSamples = []; boundsPolls = 0;
      const b0 = win.getBounds();
      boundsSamples.push([nowAbs(), b0.x, 'init']);
      boundsTimer = setInterval(() => {
        boundsPolls++;
        let b; try { b = win.getBounds(); } catch { return; }
        const last = boundsSamples[boundsSamples.length - 1];
        if (!last || last[1] !== b.x) boundsSamples.push([nowAbs(), b.x, 'change']);
      }, 1);
    };
    const stopBoundsWatch = () => {
      if (boundsTimer) { clearInterval(boundsTimer); boundsTimer = null; }
      const bs = boundsSamples || [];
      boundsSamples = null;
      return { polls: boundsPolls, changes: bs.length - 1, samples: bs };
    };

    const startRenderWatch = () => js(`(() => {
      window.__jTrace = []; window.__jMut = []; window.__jWatch = 1;
      const T0 = performance.timeOrigin;
      const cr = document.querySelector('#compact-row');
      if (window.__jObs) { try { window.__jObs.disconnect(); } catch (e) {} }
      window.__jObs = new MutationObserver(() => {
        const cs = getComputedStyle(cr);
        window.__jMut.push([T0 + performance.now(), cs.position, cs.left]);
      });
      window.__jObs.observe(cr, { attributes: true, attributeFilter: ['style'] });
      const cat = document.querySelector('#cat');
      const tick = () => {
        if (!window.__jWatch) return;
        const r = cat.getBoundingClientRect();
        window.__jTrace.push([
          T0 + performance.now(),
          Math.round(r.left * 10) / 10,
          Math.round(window.screenX),        // ★ #15 用的那个骗人的值，本轮当被告一起记
          window.innerWidth,
        ]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 1;
    })()`);
    const stopRenderWatch = () => js(`(() => {
      window.__jWatch = 0;
      if (window.__jObs) { try { window.__jObs.disconnect(); } catch (e) {} }
      return { trace: window.__jTrace || [], mut: window.__jMut || [] };
    })()`);

    // ── 离线对齐：把两条时间线合成「猫的真实屏幕 x」──
    const fuse = (rw, bw, label) => {
      const tr = (rw && rw.trace) || [];
      const bs = (bw && bw.samples) || [];
      if (!tr.length) return { label, err: 'no renderer frames' };
      if (!bs.length) return { label, err: 'no bounds samples' };
      const frameXAt = (t) => {
        let x = bs[0][1];
        for (let i = 0; i < bs.length; i++) { if (bs[i][0] <= t) x = bs[i][1]; else break; }
        return x;
      };
      // 每一帧的合成屏幕 x = 该时刻权威帧位置 + 猫的帧内位置
      const fused = tr.map((s) => [s[0], Math.round((frameXAt(s[0]) + s[1]) * 10) / 10,
                                   s[1], frameXAt(s[0]), s[2]]);
      // 稳态 = 最后一帧（此时两个进程都已提交完毕）
      const steady = fused[fused.length - 1][1];
      let maxDev = 0, badFrames = [];
      for (const f of fused) {
        const dev = Math.round((f[1] - steady) * 10) / 10;
        if (Math.abs(dev) > JUMP_TH) {
          maxDev = Math.abs(dev) > Math.abs(maxDev) ? dev : maxDev;
          if (badFrames.length < 14) badFrames.push({ dtMs: Math.round(f[0] - fused[0][0]),
            catScreenX: f[1], dev, rectLeft: f[2], frameX: f[3], staleScreenX: f[4] });
        }
      }
      const nBad = fused.filter((f) => Math.abs(f[1] - steady) > JUMP_TH).length;
      // ★ #15 的口径复现：window.screenX + rect.left，看它报几次跳变
      const stale = tr.map((s) => Math.round((s[2] + s[1]) * 10) / 10);
      let staleJumps = 0;
      for (let i = 1; i < stale.length; i++) if (Math.abs(stale[i] - stale[i - 1]) > 2) staleJumps++;
      let staleJumpsFine = 0;
      for (let i = 1; i < stale.length; i++) if (Math.abs(stale[i] - stale[i - 1]) > JUMP_TH) staleJumpsFine++;
      // window.screenX 相对权威帧位置的滞后：不一致的帧数
      const staleMismatch = fused.filter((f) => Math.abs(f[4] - f[3]) > 0.5).length;
      return {
        label, frames: fused.length, spanMs: Math.round(fused[fused.length - 1][0] - fused[0][0]),
        steadyCatScreenX: steady,
        badFrameCount: nBad, maxDevPx: maxDev, badFrames,
        boundsChanges: bw.changes, boundsPolls: bw.polls,
        boundsSamples: bs.map((s) => [Math.round(s[0] - fused[0][0]), s[1], s[2]]),
        mut: (rw.mut || []).map((m) => [Math.round(m[0] - fused[0][0]), m[1], m[2]]),
        // #15 口径的复现结果 —— 用来验「#15 为什么报 0」
        staleCaliber: { jumpsAt2px: staleJumps, jumpsAt0_5px: staleJumpsFine,
                        screenXMismatchFrames: staleMismatch },
      };
    };

    // ── 正式测量 ──
    log({ ev: 'focus', gotFocus: await grabFocus() });
    await reset(); seed('peek', 'warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(500);
    log({ ev: 'warmup', done: true, clean: await cleanState() });

    const RIGHT = wa.x + wa.width - 120;
    const LEFT = wa.x;
    const MID = wa.x + Math.round(wa.width / 2) - 60;
    const RESULTS = {};
    let uid = 0;

    const openAt = async (mode) => {
      const s = seed(mode, 's' + (++uid)); await sleep(350);
      if (mode === 'ask') { const r = await forceShow(); await sleep(700); return r; }
      await clickCat('left'); await sleep(700); return s;
    };

    const runTarget = async (id, mode, sel, catX, desc, predicted) => {
      await reset(); await sleep(600);
      await placeCat(catX);
      const pre = await cleanState();

      // ── 开窗段 ──
      startBoundsWatch(); await startRenderWatch();
      const seeded = await openAt(mode);
      const rwO = await stopRenderWatch(); const bwO = stopBoundsWatch();
      const openFuse = fuse(rwO, bwO, id + '/open');

      const mid = await js(`(() => { const n = document.querySelector('${sel}');
        const vis = n && !n.hidden && !n.classList.contains('hidden');
        let ap; try { ap = appliedCatShift; } catch (e) { ap = 'unreachable'; }
        return { popupVisible: !!vis, applied: ap,
                 popShift: getComputedStyle(document.querySelector('#stage'))
                             .getPropertyValue('--pop-shift').trim() }; })()`);

      // ── ★ 关窗段（用户报的抖动就在这里）──
      startBoundsWatch(); await startRenderWatch();
      await reset();
      await sleep(900);                       // 留足 rAF + IPC + setBounds
      const rwC = await stopRenderWatch(); const bwC = stopBoundsWatch();
      const closeFuse = fuse(rwC, bwC, id + '/close');

      const post = await cleanState();
      RESULTS[id] = { desc, predicted, pre, seeded, mid, openFuse, closeFuse, post };
      log({ ev: 'target', id, desc, predicted, pre, mid, post,
            open: openFuse, close: closeFuse });
    };

    await runTarget('P', 'peek', '#peek', RIGHT, '.peek 贴右缘', 30);
    await runTarget('A', 'ask', '#ask', RIGHT, '.ask 贴右缘', 50);
    await runTarget('M', 'ask', '#ask', LEFT, '.ask 贴左缘（镜像）', -50);
    await runTarget('C', 'ask', '#ask', MID, '.ask 居中对照（catShift 应恒 0）', 0);

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const verdict = [];
    if (!shipOK) verdict.push('★ PRE: 产品符号门没过');
    const brief = (f) => (!f || f.err) ? String(f && f.err || 'n/a')
      : { frames: f.frames, spanMs: f.spanMs, bad: f.badFrameCount, maxDev: f.maxDevPx,
          steady: f.steadyCatScreenX, bChanges: f.boundsChanges,
          stale: f.staleCaliber };
    for (const id of ['P', 'A', 'M', 'C']) {
      const r = RESULTS[id];
      if (!r) { verdict.push(id + ': MISSING'); continue; }
      if (!r.pre || !r.pre.zero) {
        verdict.push(id + ': INVALID 开跑前 catShift 非零 ' + JSON.stringify(r.pre)); continue; }
      if (!r.mid || !r.mid.popupVisible) {
        verdict.push(id + ': INVALID 弹窗没开出来 ' + JSON.stringify(r.mid)); continue; }
      if (r.mid.applied !== r.predicted) {
        verdict.push(id + ': ⚠️ catShift 实测 ' + r.mid.applied + ' ≠ 预测 ' + r.predicted); }
      for (const [seg, f] of [['开窗', r.openFuse], ['关窗', r.closeFuse]]) {
        if (!f || f.err) { verdict.push(id + '/' + seg + ': 无数据 ' + (f && f.err)); continue; }
        if (f.badFrameCount > 0) {
          verdict.push('★★ ' + id + '/' + seg + ' 抖动 CONFIRMED：' + f.badFrameCount
            + ' 帧偏离稳态，最大 ' + f.maxDevPx + 'px'
            + '（#15 口径@2px 只报 ' + f.staleCaliber.jumpsAt2px + ' 次）');
        } else {
          verdict.push(id + '/' + seg + ': 无抖动（' + f.frames + ' 帧全在 ±'
            + JUMP_TH + 'px 内）');
        }
      }
      if (!r.post || !r.post.zero) verdict.push(id + ': ⚠️ 关窗后 catShift 没归零 '
        + JSON.stringify(r.post));
    }
    log({ ev: 'SUMMARY', S: {
      P: RESULTS.P && { pred: RESULTS.P.predicted, applied: RESULTS.P.mid && RESULTS.P.mid.applied,
                        open: brief(RESULTS.P.openFuse), close: brief(RESULTS.P.closeFuse) },
      A: RESULTS.A && { pred: RESULTS.A.predicted, applied: RESULTS.A.mid && RESULTS.A.mid.applied,
                        open: brief(RESULTS.A.openFuse), close: brief(RESULTS.A.closeFuse) },
      M: RESULTS.M && { pred: RESULTS.M.predicted, applied: RESULTS.M.mid && RESULTS.M.mid.applied,
                        open: brief(RESULTS.M.openFuse), close: brief(RESULTS.M.closeFuse) },
      C: RESULTS.C && { pred: RESULTS.C.predicted, applied: RESULTS.C.mid && RESULTS.C.mid.applied,
                        open: brief(RESULTS.C.openFuse), close: brief(RESULTS.C.closeFuse) },
      VERDICT: verdict,
    } });
    // 关窗段的逐帧明细单独打（最有价值的证据，别被 SUMMARY 截断）
    for (const id of ['P', 'A', 'M', 'C']) {
      const r = RESULTS[id]; if (!r || !r.closeFuse || r.closeFuse.err) continue;
      log({ ev: 'closeDetail', id, badFrames: r.closeFuse.badFrames,
            boundsSamples: r.closeFuse.boundsSamples, mut: r.closeFuse.mut });
    }
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_JITTER ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_JITTER')) runProbeJitter();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_JITTER')) app.dock.hide(); } catch {}"


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
        # ★ 渲染端零注入自证：pet.js 必须和 HEAD 逐字节相同
        diff = subprocess.run(["git", "diff", "--stat", "--", "renderer/pet.js"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("pet.js 零注入自证: %s" % (diff or "(与 HEAD 逐字节相同 ✓)"))
        if diff:
            print("ABORT: pet.js 被改过，这一轮测的就不是产品行为了")
            return 1
        print("patched main.js, node --check 通过")

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_JITTER": "1", "HOME": "/tmp/wm-probe-home",
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
            if "PROBE_JITTER" in line:
                print(line)
    finally:
        shutil.copy(BAK_MAIN, MAIN)
        rc = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True).returncode
        print("restored main.js, node --check rc=%d" % rc)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
