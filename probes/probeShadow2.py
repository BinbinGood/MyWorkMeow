#!/usr/bin/env python3
# 探针 #12：H3 修法定案 —— 「阴影跟着弹窗内缩」到底有没有用?
#
# 背景:探针 #11 已实测确认 H3(弹窗贴帧缘时那一侧阴影整块没了),
# 且实测阴影外扩量 .peek = 21.5px / .ask = 21px(我静态按 blur/2 估的 13/12 错了 65%)。
# 用户 2026-09-18 选的修法是「阴影跟着弹窗内缩」:把 box-shadow 的 offset-x 往内推,
# 盒子与正文一px不动,几何代价为零。
#
# ⚠️ 但动手前我重算了一遍几何,怀疑这条在贴边位是**空操作**:
#   外阴影只画在 border-box **之外**,盒子底下那部分被剪掉。猫贴右缘时 boxL=0:
#     盒子      帧 [0, 320]
#     内推 21.5 后阴影矩形 帧 [21.5, 341.5] → 模糊后约 [0, 363]
#     其中 [0, 320] 整段压在盒子底下被剪 → 左侧可见阴影**仍是 0**
#     右侧 21.5 → 43,可是帧 320..520 = 屏幕 1680..1880,**在屏幕外**
#   ⇒ 用户屏幕上一个像素都不会变。
#   根子:贴边时「盒子左边的空间」与「帧外的空间」是**同一块地**,阴影怎么挪都变不出来。
#
# 按 CONSTRAINTS §一「静态推理不算数」,本探针就是来把上面这段推理**证实或证伪**的。
#
# ★ 设计要点:必须有阳性对照
#   如果只量「贴边 + 内推 → leftInk 0」,分不清两种情况:
#     (a) 机制确实无效(我的推理对)
#     (b) 我的 style 覆盖根本没生效(探针 bug,同 CONSTRAINTS §三「量错了条件」)
#   → 靶 B 先在**猫居中**时做同样的 offset-x 覆盖。居中时 boxL=100,左边有 100px 帧内空地,
#     若覆盖生效,leftInk 应从 21.5 **掉到 0**(阴影被推走)、rightInk 涨到 ~43。
#     这同时也直接演示了机制的性质:内推阴影是**毁掉近侧阴影**,不是保住它。
#
# 靶位(全部用 .peek,320 宽,阴影 0 9px 26px rgba(120,60,35,.30) @ pet.css:265):
#   A 贴右缘 / 原样                    → 复现基线,预期 L=0   R=21.5
#   B 猫居中 / offset-x = +21.5   [阳性对照] 预期 L=0   R≈43   ← 证明覆盖生效
#   C 贴右缘 / offset-x = +21.5        → 预期 L=0(空操作)      ← 核心判据
#   D 贴右缘 / 宽 298 + shift -89      → 预期 L≈21.5 且 boxR 仍=320(不多出屏)
#
# 靶 D 是用户没看过的第三条路「贴边时弹窗变窄」:
#   盒子坐帧 [22, 320],右缘仍贴屏幕缘(帧 320 = 屏幕 1680),左侧腾 22px 给阴影。
#   298 宽居中在 520 帧里 = [111, 409],要落到 [22, 320] 则 shift = 22 - 111 = -89。
#   代价是贴边时文字回流变窄,**出屏零增加**。
#
# 判读表:
#   C 的 leftInk = 0        → 用户选的修法是空操作,必须换路(靶 D 或加宽帧)
#   C 的 leftInk ≈ 21.5     → 我的推理错了,按用户原选的修法做
#   B 的 leftInk 没有变化    → 探针 bug(覆盖没生效),整组数据作废,不许下结论
#
# ⚠️ 本探针会临时改写 main.js,跑之前 worktree 必须干净(跑完自动恢复 + node --check)。

import os, shutil, subprocess, signal, json

REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK = "/tmp/main.js.probeShadow2.bak"

PROBE = r"""
// ==== PROBE_SHADOW2 (临时) ====
function runProbeShadow2() {
  const log = (o) => console.log('PROBE_SHADOW2 ' + JSON.stringify(o));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const win = petWin;
    if (!win) { log({ FATAL: 'no petWin' }); app.exit(1); return; }
    const wc = win.webContents;
    const js = async (code) => { try { return await wc.executeJavaScript(code, true); } catch (e) { return { error: String(e) }; } };
    const wa = screen.getPrimaryDisplay().workArea;
    const stOf = () => [...petState.values()].find(s => s.win === win) || null;
    log({ ev: 'workArea', wa });

    // 探针 #10 踩过:4s 心跳(main.js setInterval(emitStats, 4000))会把假快照冲掉。
    try { clearInterval(statsTimer); statsTimer = null; log({ ev: 'killStatsTimer', ok: true }); }
    catch (e) { log({ ev: 'killStatsTimer', err: String(e) }); }

    await js(`(() => { window.__probeErrs = window.__probeErrs || [];
      if (!window.__probeHooked) { window.__probeHooked = 1;
        window.addEventListener('error', (e) => window.__probeErrs.push(
          String(e.message) + ' @ ' + e.filename + ':' + e.lineno));
        window.addEventListener('unhandledrejection', (e) => window.__probeErrs.push(
          'reject: ' + String(e.reason && e.reason.stack || e.reason)));
      } return { hooked: 1 }; })()`);
    const errs = () => js('(window.__probeErrs || []).slice(-6)');

    const grabFocus = async () => {
      for (let i = 0; i < 8; i++) {
        try { app.focus({ steal: true }); } catch {}
        try { win.focus(); } catch {}
        await sleep(140);
        if (win.isFocused()) return true;
      }
      return win.isFocused();
    };

    // seed:照抄探针 #11 的 peek 分支(每轮换新 sessionId,见 #11 的坑记录)
    const seed = (uid) => {
      let snap; try { snap = buildStats('all'); } catch (e) { return String(e); }
      const now = Date.now();
      const mk = (id, state, extra) => Object.assign({
        sessionId: id, agent: 'claude', project: 'WorkMeow', state,
        headless: false, updatedAt: now, startedAt: now - 60000, tokens: 12345, cost: 0.12,
      }, extra || {});
      snap.sessions = [mk('p-' + uid, 'working'), mk('q-' + uid, 'thinking', { project: 'other' })];
      snap.workingCount = 1; snap.thinkingCount = 1; snap.waitingCount = 0; snap.needsinputCount = 0;
      snap.idleMs = 1000;
      snap.today = { messages: 42, tokens: 19356, cost: 0.2 };
      lastStats = snap; wc.send(IPC.PET_STATS, snap);
      return 'ok';
    };

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

    // 探针 #10 踩过:reset() 不重算 --pop-shift,改完猫位置必须显式重算,否则量到陈值。
    const recalc = async () => {
      const fx = win.getBounds().x;
      return js(`(() => { try { applyPopupShift(${fx} + (window.innerWidth - 120) / 2, 120); return 1; }
                          catch (e) { return String(e); } })()`);
    };

    const boxOf = (sel) => js(`(() => { const n = document.querySelector('${sel}');
      if (!n) return 'missing';
      if (n.hidden || n.classList.contains('hidden')) return 'hidden';
      const r = n.getBoundingClientRect();
      return { L: Math.round(r.left * 10) / 10, R: Math.round(r.right * 10) / 10,
               T: Math.round(r.top * 10) / 10, B: Math.round(r.bottom * 10) / 10,
               w: Math.round(r.width * 10) / 10, innerW: window.innerWidth,
               shadow: getComputedStyle(n).boxShadow,
               popShift: getComputedStyle(document.querySelector('#stage'))
                           .getPropertyValue('--pop-shift').trim() }; })()`);

    // 覆盖 .peek 的 box-shadow offset-x（inline style,优先级高于 pet.css:265）
    // 回读 computed 值自查覆盖是否真落地 —— 不回读就无法区分「机制无效」与「覆盖失败」。
    const setShadowX = (dx) => js(`(() => {
      const n = document.querySelector('#peek');
      if (!n) return 'missing';
      n.style.boxShadow = '${dx}px 9px 26px rgba(120, 60, 35, 0.30)';
      return getComputedStyle(n).boxShadow;
    })()`);
    const clearShadowX = () => js(`(() => { const n = document.querySelector('#peek');
      if (n) n.style.boxShadow = ''; return 1; })()`);

    // 靶 D:变窄 + 重定位。宽 298 居中在 520 帧 = [111,409],要落到 [22,320] → shift -89
    const setNarrow = (w, shift) => js(`(() => {
      const n = document.querySelector('#peek');
      if (!n) return 'missing';
      n.style.width = '${w}px';
      document.querySelector('#stage').style.setProperty('--pop-shift', '${shift}px');
      return { w: getComputedStyle(n).width,
               shift: getComputedStyle(document.querySelector('#stage'))
                        .getPropertyValue('--pop-shift').trim() };
    })()`);
    const clearNarrow = () => js(`(() => { const n = document.querySelector('#peek');
      if (n) n.style.width = ''; return 1; })()`);

    // ════════════════════════════════════════════════════════════════════
    // 像素量法:capturePage → BGRA bitmap → 在弹窗竖直中心扫描线上数墨
    // ════════════════════════════════════════════════════════════════════
    // 逐字照抄探针 #11 的 inkScan（它两轮都 alphaTrustworthy:true、farAlpha:0，已验）。
    // ⚠️ rect 量不到阴影,只有像素能。scaleFactor=2 时 bitmap 是**物理像素**。
    const inkScan = async (box, label) => {
      if (typeof box !== 'object' || box === null) return { label, err: 'no box: ' + box };
      let img;
      try { img = await wc.capturePage(); } catch (e) { return { label, err: 'capture: ' + String(e) }; }
      const size = img.getSize();
      const bmp = img.getBitmap();          // BGRA,4 字节/像素
      const sf = Math.round((size.width / (await js('window.innerWidth'))) * 100) / 100;
      const W = size.width, H = size.height;
      const bytesPerRow = W * 4;
      const y = Math.round(((box.T + box.B) / 2) * sf);
      if (y < 0 || y >= H) return { label, err: 'scanline out of bitmap: y=' + y + ' H=' + H };
      const alphaAt = (x) => {
        if (x < 0 || x >= W) return -1;     // -1 = 出了 bitmap,区别于 0 = 透明
        return bmp[y * bytesPerRow + x * 4 + 3];
      };
      const TH = 3;
      const boxL = Math.round(box.L * sf), boxR = Math.round(box.R * sf);
      let leftInk = 0;
      for (let x = boxL - 1; x >= 0; x--) { if (alphaAt(x) > TH) leftInk++; else break; }
      let rightInk = 0;
      for (let x = boxR; x < W; x++) { if (alphaAt(x) > TH) rightInk++; else break; }
      // 动态远端采样自查(#11 第一版把它钉死在 x=2,贴边时正落在弹窗自己身上 → 误报)
      const farCandL = Math.max(0, boxL - 120);
      const farCandR = Math.min(W - 1, boxR + 120);
      const farX = (boxL - farCandL) >= (farCandR - boxR) ? farCandL : farCandR;
      const farA = alphaAt(farX);
      return {
        label, sf, bitmap: { W, H }, scanY: y,
        boxL_css: box.L, boxR_css: box.R, innerW_css: box.innerW,
        insideLeftAlpha: alphaAt(boxL + 2), insideRightAlpha: alphaAt(boxR - 3),
        farX, farAlpha: farA, alphaTrustworthy: farA <= TH,
        leftInk_px: leftInk, rightInk_px: rightInk,
        leftInk_css: Math.round((leftInk / sf) * 10) / 10,
        rightInk_css: Math.round((rightInk / sf) * 10) / 10,
      };
    };

    // ── 正式测量 ──
    const got = await grabFocus();
    log({ ev: 'focus', gotFocus: got });

    // README 记着的坑:第一轮状态可能反相,先预热一轮。
    await reset(); seed('warm'); await sleep(400);
    await placeCat(wa.x + Math.round(wa.width / 2));
    await clickCat('left'); await sleep(500); await reset(); await sleep(300);
    log({ ev: 'warmup', done: true });

    const RESULTS = {};
    let uid = 0;

    // 把 .peek 在指定位置打开,返回 box
    const openPeekAt = async (catX) => {
      await reset(); await sleep(200);
      seed('s' + (++uid)); await sleep(300);
      await placeCat(catX);
      await clickCat('left'); await sleep(600);
      await recalc(); await sleep(150);
      return boxOf('#peek');
    };

    const RIGHT = wa.x + wa.width - 120;
    const CENTER = wa.x + Math.round(wa.width / 2);
    const DX = 21.5;   // 实测的阴影外扩量(探针 #11:.peek = 21.5px)

    // ── 靶 A：贴右缘 / 原样 —— 复现基线 ──
    {
      const box = await openPeekAt(RIGHT);
      const ink = await inkScan(box, 'A/rightEdge/asis');
      RESULTS.A = { box, ink };
      log({ ev: 'target', id: 'A', desc: '贴右缘/原样', box, ink });
    }

    // ── 靶 B：猫居中 / offset-x 内推 —— ★阳性对照 ──
    // 居中时左侧有 100px 帧内空地。若覆盖生效,阴影被推走 → leftInk 21.5 → 0、rightInk → ~43。
    // 若 leftInk 没变化,说明覆盖没落地,C 的结论不成立,整组作废。
    {
      const box0 = await openPeekAt(CENTER);
      const ink0 = await inkScan(box0, 'B/center/before');
      const computed = await setShadowX(DX);
      await sleep(250);
      const box1 = await boxOf('#peek');
      const ink1 = await inkScan(box1, 'B/center/shadowX+' + DX);
      await clearShadowX();
      RESULTS.B = { box0, ink0, computed, box1, ink1 };
      log({ ev: 'target', id: 'B', desc: '居中/内推阴影[阳性对照]',
            computedShadow: computed, box0, ink0, box1, ink1 });
    }

    // ── 靶 C：贴右缘 / offset-x 内推 —— ★核心判据 ──
    {
      const box0 = await openPeekAt(RIGHT);
      const ink0 = await inkScan(box0, 'C/rightEdge/before');
      const computed = await setShadowX(DX);
      await sleep(250);
      const box1 = await boxOf('#peek');
      const ink1 = await inkScan(box1, 'C/rightEdge/shadowX+' + DX);
      await clearShadowX();
      RESULTS.C = { box0, ink0, computed, box1, ink1 };
      log({ ev: 'target', id: 'C', desc: '贴右缘/内推阴影[核心]',
            computedShadow: computed, box0, ink0, box1, ink1 });
    }

    // ── 靶 D：贴右缘 / 弹窗变窄 22px 并重定位 —— 用户没看过的第三条路 ──
    // 298 宽居中在 520 帧 = [111,409];要让盒子落到 [22,320](右缘仍贴屏幕缘)则 shift = -89。
    {
      const box0 = await openPeekAt(RIGHT);
      const ink0 = await inkScan(box0, 'D/rightEdge/before');
      const applied = await setNarrow(298, -89);
      await sleep(300);
      const box1 = await boxOf('#peek');
      const ink1 = await inkScan(box1, 'D/rightEdge/narrow298');
      const fb = win.getBounds();
      await clearNarrow();
      RESULTS.D = { box0, ink0, applied, box1, ink1,
                    // 盒子右缘的屏幕坐标:应当仍 = wa.x+wa.width(1680),即出屏零增加
                    screenR: box1 && box1.R != null ? Math.round(box1.R + fb.x) : null,
                    screenL: box1 && box1.L != null ? Math.round(box1.L + fb.x) : null,
                    frameX: fb.x, waRight: wa.x + wa.width };
      log({ ev: 'target', id: 'D', desc: '贴右缘/变窄298',
            applied, box0, ink0, box1, ink1,
            screenL: RESULTS.D.screenL, screenR: RESULTS.D.screenR,
            waRight: RESULTS.D.waRight });
    }

    log({ ev: 'errs', errs: await errs() });

    // ── SUMMARY ──
    const ib = (ink) => (!ink || ink.err) ? String(ink && ink.err || 'n/a')
      : { L: ink.leftInk_css, R: ink.rightInk_css, boxL: ink.boxL_css, boxR: ink.boxR_css,
          insideA: [ink.insideLeftAlpha, ink.insideRightAlpha], alphaOK: ink.alphaTrustworthy };
    log({ SUMMARY: {
      A_baseline_rightEdge: ib(RESULTS.A && RESULTS.A.ink),
      B_control_center: { before: ib(RESULTS.B && RESULTS.B.ink0),
                          after: ib(RESULTS.B && RESULTS.B.ink1),
                          computedShadow: RESULTS.B && RESULTS.B.computed },
      C_core_rightEdge: { before: ib(RESULTS.C && RESULTS.C.ink0),
                          after: ib(RESULTS.C && RESULTS.C.ink1),
                          computedShadow: RESULTS.C && RESULTS.C.computed },
      D_narrow_rightEdge: { before: ib(RESULTS.D && RESULTS.D.ink0),
                            after: ib(RESULTS.D && RESULTS.D.ink1),
                            applied: RESULTS.D && RESULTS.D.applied,
                            screenL: RESULTS.D && RESULTS.D.screenL,
                            screenR: RESULTS.D && RESULTS.D.screenR,
                            waRight: RESULTS.D && RESULTS.D.waRight },
      // 自动判读:把上面判读表的逻辑写死在探针里,免得看数时又靠脑补
      VERDICT: (() => {
        const b0 = RESULTS.B && RESULTS.B.ink0, b1 = RESULTS.B && RESULTS.B.ink1;
        const c0 = RESULTS.C && RESULTS.C.ink0, c1 = RESULTS.C && RESULTS.C.ink1;
        if (!b0 || !b1 || b0.err || b1.err) return 'INVALID: 阳性对照没量到';
        if (Math.abs(b0.leftInk_css - b1.leftInk_css) < 2)
          return 'INVALID: 阳性对照 leftInk 没变化(' + b0.leftInk_css + '→' + b1.leftInk_css
                 + '),覆盖可能没生效,不许拿 C 下结论';
        if (!c0 || !c1 || c0.err || c1.err) return 'INVALID: 核心靶没量到';
        if (c1.leftInk_css < 2)
          return 'CONFIRMED_NOOP: 内推阴影在贴边位是空操作(leftInk ' + c0.leftInk_css
                 + '→' + c1.leftInk_css + '),用户原选的修法无效,必须换路';
        return 'REFUTED: 内推阴影确实恢复了左侧阴影(leftInk ' + c0.leftInk_css
               + '→' + c1.leftInk_css + '),我的推理错了';
      })(),
    } });
    log({ ev: 'done' });
    app.exit(0);
  }, 3000);
}
// ==== /PROBE_SHADOW2 ====
"""

TRIGGER = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_SHADOW2')) runProbeShadow2();\n"
DOCK = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_SHADOW2')) app.dock.hide(); } catch {}"


def main():
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if dirty:
        print("ABORT: worktree 不干净，探针会改写 main.js。先提交或 stash：")
        print(dirty)
        return 1

    src = open(MAIN, encoding="utf-8").read()
    for needle in (TRIGGER, DOCK):
        if needle not in src:
            print("ABORT: 找不到锚点:\n" + needle)
            return 1
    shutil.copy(MAIN, BAK)
    try:
        patched = src.replace(TRIGGER, TRIGGER_NEW).replace(DOCK, DOCK_NEW) + PROBE
        open(MAIN, "w", encoding="utf-8").write(patched)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        if chk.returncode != 0:
            print("ABORT: patch 后语法错误:\n" + chk.stderr)
            return 1

        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_SHADOW2": "1", "HOME": "/tmp/wm-probe-home",
                    "WORKMEOW_NO_NET": "1", "WORKMEOW_ALLOW_MULTI": "1",
                    "WORKMEOW_NO_HOOKS": "1", "WORKMEOW_NO_CODEX": "1",
                    "WORKMEOW_NO_OPENCODE": "1", "WORKMEOW_NO_TRAE": "1"})
        proc = subprocess.Popen(["npx", "electron", "."], cwd=REPO, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, start_new_session=True)
        try:
            out, _ = proc.communicate(timeout=200)
        except subprocess.TimeoutExpired:
            print("TIMEOUT 200s")
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
            if "PROBE_SHADOW2" in line:
                print(line)
    finally:
        shutil.copy(BAK, MAIN)
        chk = subprocess.run(["node", "--check", MAIN], capture_output=True, text=True)
        print("restored main.js, node --check rc=%d" % chk.returncode)
        left = subprocess.run(["git", "status", "--porcelain"], cwd=REPO,
                              capture_output=True, text=True).stdout.strip()
        print("(worktree clean)" if not left else "⚠️ 残留改动:\n" + left)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
