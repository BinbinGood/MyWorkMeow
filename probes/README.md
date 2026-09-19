# 真机探针索引（16 份）

> 配套 `../CONSTRAINTS.md` 与 `../H1-H2-bug-fix-handoff.md`。
> 这些脚本**会临时改写 `WorkMeow/main.js`**（有的还改 `renderer/pet.js` 或 `preload.js`），
> 靠 `finally` 里的 `shutil.copy(BAK, MAIN)` + `node --check` 还原。**中途 Ctrl-C 也会走 finally。**
> 跑之前确认工作区干净（`git status --short`），跑完确认输出了 `restored main.js` 且 `git status` 仍干净。

---

## 一览

| # | 脚本 | 字节 | 靶 | 结论 |
|---|---|---|---|---|
| 1 | `probeEdge.py` | 13264 | 弹窗在屏幕边缘的实际坐标 | ★ **H2 的判定性证据**（靶 A 五个位置的 `clipLeft`/`clipRight`） |
| 2 | `probeFlash.py` | 10199 | 关气泡瞬间是否有 `setBounds`/`blur` 尖峰 | 零调用；`iw/ih/catPos/opacity` 逐帧恒定。**盲区：blur 只记到 1 次** |
| 3 | `probeClamp.py` | 11910 | AppKit 是否在钳帧 | **排除**（2ms 高频轮询 `getBounds`，6 轮零变化） |
| 4 | `probeFocus.py` | 11928 | 补 #2 的失焦盲区（点击前先 `win.focus()`）+ 硬断言 | 抓到 5/6 轮 peek 没真打开 → 促成 `FATAL`/`INVALID` 自查机制 |
| 5 | `probeDesync.py` | 8462 | 穿透态 desync | **失败**（hook 冻结对象 + 合成事件失焦，两个坑一起踩） |
| 6 | `probeSync.py` | 9615 | 穿透态 desync（改用 patch `pet.js` 暴露 `window.__MI`） | ★ **H1 根因 B 的判定性证据** |
| 7 | `probeNoBlur.py` | 9690 | `blurPet` 是否还承担 F4 帧钳制 | ★ **A/B 12 例证明已解耦**（两组全 `frameChanges: 0`） |
| 8 | `probeThrottle.py` | 9487 | `backgroundThrottling` | A 组 3/3 `INVALID`（拿不到窗口焦点），但**意外抓到 A/B 的 `visibilitychange` 差异** → 直接催生 #9 |
| 9 | `probeVis.py` | 11340 | 沿用户真实点击路径记 `visibilitychange` | ★★★ **H1 根因 A 的判定性证据**（A/B 各 4 轮 × 左右键 = 16 例） |
| 10 | `probeAsk.py` | 23853 | `.ask` 真打开后在左右缘的 `clip` | ★ 结清 H2 两笔欠账：帧裁 **24px 逐位吻合**；修后残留 20px 是**出屏** |
| 11 | `probeShadow.py` | 28568 | 弹窗 `box-shadow` 的实际外扩量 | ★ `getBoundingClientRect` **不含**阴影，只能 `capturePage`→`getBitmap` 逐列扫 alpha |
| 12 | `probeShadow2.py` | 21002 | 用户最初想的修法（阴影 offset-x 往内挪） | **`CONFIRMED_NOOP`** —— 那条路走不通，实测 `.peek` 21.5 / `.ask` 21 |
| 13 | `probeFrameShift.py` | 24120 | 「帧移」这条路几何上成不成立 | ★ 成立，但当时靠探针强行 `setBounds`，不是产品路径 |
| 14 | `probeRealPath.py` | 32106 | 候选修法走**产品**链路（注入版） | ★ 主体成立 + **抓到真缺陷**：关窗后 `catShift` 残留 30/50/−50px 不归零 |
| 14b | `probeRealPath2.py` | 35535 | 补去重第三项后的注入版，四靶 | ★★ 四靶全 `CONFIRMED`；**开窗 200 帧 + 关窗 278 帧零跳帧**；阴影常数不变性实测 |
| 15 | `probeShipped.py` | 30272 | ★ 验**已落地**的产品代码（渲染端零注入） | ★★★ **H3 的结案证据**，四靶全 `CONFIRMED`，见文末 |

★ = 结论仍在被引用，不要删。

---

## 关键结论逐条

### #1 `probeEdge.py` —— H2

靶 A 真机输出（与算术逐位吻合）：

```
左缘   catX=0    frameX=-200 frameW=520 popShift=104px  peek L=204 R=524 clipRight=4
左缘+4 catX=4    frameX=-196 frameW=520 popShift=100px  peek L=200 R=520 无裁切
中间   catX=840  frameX=640  frameW=520 popShift=0px    peek L=100 R=420 无裁切
右缘-4 catX=1556 frameX=1356 frameW=520 popShift=-100px peek L=0   R=320 无裁切
右缘   catX=1560 frameX=1360 frameW=520 popShift=-104px peek L=-4  R=316 clipLeft=4
```

`peekScroll.overflowX = 0` → 被裁的是**弹窗整体**，不是内部内容。
~~**欠账**：`ask` 全程 `hidden`，算术预测的 24px **从未真机实测**。~~ → 已由 **#10 `probeAsk.py`** 结清，见下。

顺带证伪：帧宽恒 520（连 0 会话时也是）—— `restingFrameWidth()` 的 `Math.max(POPUP_W, …)` 下限就是 520。

### #10 `probeAsk.py` —— H2 的两笔欠账,全部结清

fix(a)（`43ec5f6`）之后的真机测量。`workArea {x:0,y:30,width:1680,height:956}`，`gotFocus: true`。
`clip*` 量的是**帧**（`innerWidth`），`offScreen*` 量的是**屏幕**（`workArea`）—— H2 的整个判断建立在「裁的是帧不是屏幕」上，所以必须分开报。

```
peek @ 左缘  猫x=0    帧x=-200 popShift=100px  L=200 R=520  clip 0/0  screen 0..320     clean
peek @ 中间  猫x=840  帧x=640  popShift=0px    L=100 R=420  clip 0/0  screen 740..1060  clean
peek @ 右缘  猫x=1560 帧x=1360 popShift=-100px L=0   R=320  clip 0/0  screen 1360..1680 clean
ask  @ 左缘  猫x=0    帧x=-200 popShift=90px   L=180 R=520  clip 0/0  screen -20..320   OFF_SCREEN 20px
ask  @ 中间  猫x=840  帧x=640  popShift=0px    L=90  R=430  clip 0/0  screen 730..1070  clean
ask  @ 右缘  猫x=1560 帧x=1360 popShift=-90px  L=0   R=340  clip 0/0  screen 1360..1700 OFF_SCREEN 20px
```

**欠账 1（修前 `.ask` 到底被帧裁多少？算术预测 24px）—— A/B 实测，逐位吻合。**
fix(a) 已在树里，没法跑旧代码，所以在渲染端把 `window.PetGeometry.capsuleShift` 包一层、**剥掉 `frameWidth` 入参**（等价修前），同一轮、同一位置、同一个 `.ask`，A/B 只差这一个参数：

```
左缘  修前 popShift=114px  L=204 R=544  clipRight=24   修后 popShift=90px  L=180 R=520  clip 0/0
右缘  修前 popShift=-114px L=-24 R=316  clipLeft =24   修后 popShift=-90px L=0   R=340  clip 0/0
```

24px 这个纯推的数**实测确认**：`(340-120)/2+4 = 114` vs 帧内余量 `(520-340)/2 = 90`，差 24。裁的方向也确认 —— 猫在**左**缘时裁**右**边（`clipRight=24`），猫在**右**缘时裁**左**边（`clipLeft=24`），正是用户说的「不是靠近屏幕边缘不完整，而是另一边」。

**欠账 2（修后残留 20px 是出屏还是仍被帧裁？）→ 出屏。**
`clipLeft = clipRight = 0`、`offScreen = 20`。弹窗在自己那个 520 帧里**完整**，只是探到屏幕外 20px —— 任何窗口程序贴屏幕缘时的常规表现。

**⇒ 结论：不动 `POPUP_W`。** 抬到 568 要连带改 `catInset` 200→220 加一大票钉死的数，只为把「贴死缘时探出屏幕 20px」变成 0 —— 代价远大于收益，且那 20px 不造成「消息不完整」。`43ec5f6` 的提交说明里已记「暂不动」。

**探针自身的三个坑（复用前先看）**：
1. **主进程 4s 心跳会冲掉灌的快照**。`main.js:1245 setInterval(emitStats, 4000)`，真实快照里没有带 `choice` 的会话 → `applyStats` → `refreshAsk` → `hideAsk()`，在两次测量之间把 `#ask` 关掉。探针开头 `clearInterval(statsTimer)`。
2. **CSP 挡 `eval`**，读不到顶层 `let/const`（`actionPopOpen` / `answered` / `lastAskSig` 全回 `'<不可见>'`）。但注入代码里**直接写标识符**（`applyStats` / `refreshAsk` / `showAskPanel`）是普通引用、不走 `eval`，能正常解析 —— 别为了诊断去动 CSP。
3. **`reset()` 不触发位移重算**。第一版探针 `ask` 三轮的 `--pop-shift` 全读到上一轮 右缘 的 `-100px`，连「中间」也是。窗口挪了之后必须显式 `applyPopupShift(...)` 再量，否则量到的是陈值。

顺带一条：`#ask` 走 `applyStats(快照)` 全链路就能开（`openedAt: L1`），不需要 radial 入口 —— 只要会话 `state` 为 `waiting`/`needsinput`、带 `choice`、`choice` 有非空 `options` 或 `allowInput`。第一版探针失败纯粹是被上面第 1 条的心跳冲掉了，不是 `refreshAsk` 的门槛。

### #6 `probeSync.py` —— desync

```
Round1 onCat                  渲染 false / 主 false  ignore(false)      同步
Round1 onTransparent          渲染 true  / 主 true   ignore(true)       同步
Round1 afterRealBlur          渲染 true  / 主 false  [[3358,0]]         ← 主进程单方面复位
Round1 moveAgainOnTransparent 渲染 true  / 主 false  []                 ← 渲染端 SKIP 吞掉
heartbeat10s idle1            渲染 true  / 主 false  [[7357,0]]
rlog: [[8032,1,"SKIP"],[8232,1,"SKIP"]]
```

Round 0 / Round 2 没复现 —— `win.blur()` 在窗口已失焦时是空操作（`osDuringBlur: []`）。这解释了用户说的「**可能**会卡住」。

### #7 `probeNoBlur.py` —— `blurPet` 解耦

patch `preload.js` 把 `blurPet` 换成空实现做 B 组（左缘/右缘 × 3 轮 × 2 组）：

| 组 | `win.blur()` 实调 | `blurSkipped` | 帧变化 | drift |
|---|---|---|---|---|
| A_withBlur | 6 轮全 `1` | `0` | **0/6** | 全 0 |
| B_noBlur | 6 轮全 `0` | 递增 1→6 | **0/6** | 全 0 |

帧全程 `{x:-200 或 1360, y:242, w:520, h:744}`，2ms 轮询 177–851 个样本，`frameChanges: 0`。

### #9 `probeVis.py` —— H1 根因 A

```
A_default:    {left:{rounds:3,hidden:0,visChanges:6}, right:{rounds:4,hidden:0,visChanges:0}}
B_noThrottle: {left:{rounds:4,hidden:0,visChanges:0}, right:{rounds:4,hidden:0,visChanges:0}}
```

A 组左键每轮同一序列（取自 round3）：
```
events:[[27.9,"focus"],[833.1,"blur"],[833.1,"blur"],[835,"vis:hidden"],[835.5,"vis:visible"]]
```

全部 16 例：`frames:121-122`、`hiddenFrames:0`、`hiddenRuns:[]`、`gaps50:[]`、`imgW:[120]`、`gotFocus:true`。

**`hiddenFrames:0` 与 `visChangeCount:2` 并存不是矛盾** —— 见 `../CONSTRAINTS.md` 盲区 A。

---

## 可复用骨架

### Python 外壳（#4 与 #2 完全同构，直接抄）

```python
REPO = "/Users/gaobinbin/Downloads/codes/WorkMeow"
MAIN = os.path.join(REPO, "main.js")
BAK  = "/tmp/main.js.probeX.bak"
TRIGGER     = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_X')) runProbeX();\n"

def main():
    src = open(MAIN, encoding="utf-8").read()
    shutil.copy(MAIN, BAK)
    proc = None
    try:
        assert TRIGGER in src, "trigger anchor not found"
        open(MAIN, "w", encoding="utf-8").write(src.replace(TRIGGER, TRIGGER_NEW, 1) + "\n" + PROBE)
        subprocess.run(["node", "--check", MAIN], check=True)
        env = dict(os.environ)
        env.update({"WORKMEOW_PROBE_X": "1", "HOME": "/tmp/wm-probe-home",
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
            print("!!! TIMEOUT"); os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            blob, _ = proc.communicate()
        for line in (blob or "").splitlines():
            if "PROBE_X" in line: print(line)
        if "PROBE_X" not in (blob or ""):
            print("--- no probe output; tail ---"); print((blob or "")[-4000:])
    finally:
        if proc and proc.poll() is None:
            try: os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception: pass
        shutil.copy(BAK, MAIN)
        subprocess.run(["node", "--check", MAIN], check=True)
        print("restored main.js")
main()
```

⚠️ **Bash 工具自己传 `timeout` 参数**，不要在命令里写 `timeout 220 python3 …`（本机 zsh 无 `timeout`）。
⚠️ `start_new_session=True` + `killpg` 是硬要求 —— 见 `../CONSTRAINTS.md`「不许动的进程」。

### JS 侧零件

`stOf()` 取 petState：
```js
const stOf = () => [...petState.values()].find(s => s.win === win) || null;
```

★ `grabFocus()` —— 拿真窗口焦点的唯一有效解法（#9，16/16 成功）：
```js
const grabFocus = async () => {
  for (let i = 0; i < 8; i++) {
    try { app.focus({ steal: true }); } catch {}
    try { win.focus(); } catch {}
    await sleep(140);
    if (win.isFocused()) return true;
  }
  return win.isFocused();
};
```
同时要 patch 掉 dock 隐藏，否则 accessory app 拿不到焦点：
```
DOCK     = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_X')) app.dock.hide(); } catch {}"
```

`seed(n)` 注入假会话快照（**先 `clearInterval(statsTimer); statsTimer = null;`**，否则 4s 心跳冲掉）：
```js
const seed = (n) => {
  let snap; try { snap = buildStats('all'); } catch (e) { return false; }
  const now = Date.now();
  const all = [
    { sessionId:'p1', agent:'claude', project:'WorkMeow', state:'working',
      headless:false, updatedAt:now, startedAt:now-60000, tokens:12345, cost:0.12 },
    { sessionId:'p2', agent:'codex', project:'other', state:'waiting',
      headless:false, updatedAt:now, startedAt:now-120000, tokens:6789, cost:0.07 },
  ];
  snap.sessions = all.slice(0, n);
  snap.workingCount = n > 0 ? 1 : 0; snap.waitingCount = n > 1 ? 1 : 0;
  snap.idleMs = 1000; snap.today = { messages:42, tokens:19356, cost:0.2 };
  lastStats = snap; wc.send(IPC.PET_STATS, snap); return true; };
```

`placeCat()` —— 用 `origSetBounds` 绕过自己的打桩：
```js
const placeCat = async (catScreenX) => {
  const b = win.getBounds(); const inset = (b.width - 120) / 2;
  origSetBounds({ x: Math.round(catScreenX - inset), y: Math.round(wa.y + wa.height/2 - 150),
                  width: b.width, height: b.height });
  const st = stOf(); if (st) applyPetSize(st, null);
  await sleep(450); };
```

`clickCat()` —— #4 的版本（新探针请把 `win.focus()` 换成 `grabFocus()`）：
```js
const clickCat = async (button) => {
  try { win.focus(); } catch {}
  await sleep(120);
  const b = await catBox();
  wc.sendInputEvent({ type:'mouseMove', x:b.cx, y:b.cy }); await sleep(25);
  wc.sendInputEvent({ type:'mouseDown', x:b.cx, y:b.cy, button, clickCount:1 }); await sleep(35);
  wc.sendInputEvent({ type:'mouseUp', x:b.cx, y:b.cy, button, clickCount:1 }); };
```

主进程侧打桩（含调用栈函数名提取，`setBounds` / `blur` / `evt:blur` / `evt:focus` / `evt:resize` / `evt:move`）：
```js
const origSetBounds = win.setBounds.bind(win);
win.setBounds = function (b, ...rest) {
  const st = new Error().stack.split('\n').slice(2, 5)
    .map(s => (s.match(/at ([\w.<>]+)/) || [,'?'])[1]).join('<');
  MAINLOG.push({ t: Date.now()-t0, op:'setBounds', b:{x:b.x,y:b.y,w:b.width,h:b.height}, st });
  return origSetBounds(b, ...rest); };
```

启动延迟统一 `setTimeout(async () => { … }, 4500)`，收尾 `setTimeout(() => { try { app.exit(0); } catch { process.exit(0); } }, 300)`。

---

## 写新探针前必看的坑

1. **★ rAF 采样对 `visibilityState` 引起的合成中断结构性地盲** —— 探针 #1/#2/#3/#4 全栽在这里。要查合成/闪烁，**直接记 `visibilitychange` 事件**。
2. **给 `win.setBounds` 打桩看不见 AppKit 钳帧** —— 改用 ~2ms 高频轮询 `getBounds()`。
3. **量错元素** —— 真正显示画面的是 `#cat-img`（`renderer/pet.html:125-127`），不是 `#cat`（CSS 固定尺寸的容器 div）。且 `#stage.cat-hidden #cat { display: none }` 是通过**祖先** class 设的，`rect()` helper 只查自身 class 会漏。
4. **`window.pet` 是 contextBridge 冻结对象，hook 不上**（赋值静默失败，探针 #5 就死在这）。
   - 读渲染端模块级变量 → 临时 patch `renderer/pet.js`（#6 这样暴露 `window.__MI`）
   - 换 `window.pet` 方法实现 → 临时 patch `preload.js`（#7 这样做 A/B）
5. **`sendInputEvent` 不给 NSWindow 焦点** → `w.blur()` 成空操作，测不出任何真失焦行为。必须用 `grabFocus()`。
6. **★「第一轮 peek 状态反相」已累计出现 3 次**（#4/#7/#9）：上一轮残留的 peek 打开态让第一次点击变成「关」，该轮数据作废。
   → 第一轮前多跑一次 reset + 更长 sleep，并加硬断言：
   ```js
   if (opened && opened.hidden) log({ ev:'FATAL', why:'peek 没打开，本轮数据作废', label, round, opened });
   ```
7. **`emitStats()` 是全 app 唯一真心跳**（`main.js:1219`，4s，带 `.unref()`）。
8. **中文注释里的全角括号是正常的** —— 自检别整文件查全角括号，只查具体笔误模式（如 `s.count('sleep（')`）。曾因 `await sleep（400);` 报错。
9. **`app.focus({steal:true})` 只许在探针里用**，绝不进产品代码。
10. **Quartz (pyobjc) 不可用** —— 没法走系统级事件注入。
11. 未深究的记账：#8 出现 `medianGap: 0.1–0.2ms` 而 max 17.7ms（300 帧/2490ms ≈ 8.3ms）→ 帧成簇产出，只在失焦态。成因未判定。
12. **★★ 注入版绿 ≠ 落地版绿。** #14 / #14b 是把候选修法**注入**渲染端跑的（`window.__PROBE_FIX_OFF` 切 A/B），量的是**差值**。差值绿只证明「这个算法对」，不证明「落地进产品代码的那份也对」—— 落点、调用顺序、去重条件、归零路径全都可能在落地时走偏。**修法一旦提交，必须再跑一轮「渲染端零注入」的绝对判据探针**（#15 `probeShipped.py` 就是为此而生）。别改写旧探针来做这件事：旧探针是上一轮的证据记录，要新建一份。
13. **★ 产品的顶层 `let`/`const`/`function` 可以直接用裸名读到**，不需要任何注入。`renderer/pet.js` 是普通 `<script>`（`pet.html:154`），顶层 `function` 落在全局对象上、顶层 `let/const` 落在全局声明式环境里，两者都能被 `wc.executeJavaScript` 里的**裸标识符引用**解析到（走的是普通引用，不是 `eval`，所以不撞 CSP —— 见 #10 坑 2）。#15 就是这样直接读产品的 `POPUP_SHADOW_SPREAD` / `appliedCatShift` 的。
   ⚠️ 要包 `try/catch`：符号不存在时抛的是 `ReferenceError`，而这恰好是「修法没落地」的判据。
14. **★ 零注入要自证，不能靠嘴说。** #15 在 patch 完 `main.js` 之后立刻跑一次
    ```python
    diff = subprocess.run(["git","diff","--stat","--","renderer/pet.js"], cwd=REPO, ...).stdout.strip()
    if diff: print("ABORT: pet.js 被改过，这一轮就不是「验落地版」了"); return 1
    ```
    输出 `pet.js 零注入自证: (与 HEAD 逐字节相同 ✓)`。没有这一行的「落地版验证」不算验证。

---

## 探针 #10 的任务 —— 已完成（2026-09-18）

原任务（`../H1-H2-bug-fix-handoff.md`「执行顺序」第 1 步）：

- ~~把 `.ask` **真的打开**，量它在左右缘的 `clipLeft`/`clipRight` —— 验算术预测的 **24px**（H2 唯一的实测欠账）。~~ → **实测 24px，逐位吻合**（A/B：剥掉 `frameWidth` 等价修前）。
- ~~顺带验 H2 修法 (a) 之后那 20px 是**出屏**还是**仍被帧裁** —— 这一条直接决定要不要动 `POPUP_W`。~~ → **出屏**（`clip=0`，`offScreen=20`）→ **不动 `POPUP_W`**。

结果见上面「#10 `probeAsk.py`」一节。`.ask` 不必走 radial —— `applyStats(快照)` 全链路就能开（`openedAt: L1`）。

**H2 至此没有未实测的判断了。**

---

## 探针 #15 `probeShipped.py` —— 验**落地版**（2026-09-18）★★★

H3 的结案证据。**只临时改写 `main.js`**（探针入口 + 不隐藏 dock），`renderer/pet.js` **一个字节不动** ——
这一点由探针自己 `git diff --stat -- renderer/pet.js` 自证（见坑 14），不干净就直接 `ABORT`。

### 和 #14b 的判据差别（重要，不是退化）

#14b 靠 `window.__PROBE_FIX_OFF` 在同一进程里切「修前/修后」，比的是**差值**。产品代码里没有那个开关
（也不该有），所以本轮改成**绝对判据**，而且比 #14b 更严：

1. 近侧墨迹 ≥8px　2. 远侧墨迹 ≥8px
3. ★ **盒子 + 阴影整体在帧内** —— `[L-26, R+26] ⊂ [0, 520]`（H3 的判定性判据，#14b 没有这一条）
4. 出屏 == 0、帧裁 == 0
5. ★ 猫的屏幕 x 在「静息 → 弹窗 → 关窗」**三态恒等**（#14b 只比两个弹窗态）
6. ★ 不变式 `popShift - catShift ≡ ideal` 在真机上**现算现验**
7. 帧宽恒 520；开窗 / 关窗两段 rAF **零跳帧**；关窗后 `catShift` 归零

「修法是否真落地」用**产品符号**做门禁，探针里不出现任何 `PROBE_*`：

```js
r.popupShiftPlan = typeof popupShiftPlan === 'function';
r.applyCatShift  = typeof applyCatShift  === 'function';
try { r.POPUP_SHADOW_SPREAD = POPUP_SHADOW_SPREAD; } catch (e) { r.POPUP_SHADOW_SPREAD = 'unreachable'; }
try { r.appliedCatShift    = appliedCatShift;    } catch (e) { r.appliedCatShift    = 'unreachable'; }
```

实测 `{popupShiftPlan:true, applyCatShift:true, widestVisiblePopup:true, POPUP_SHADOW_SPREAD:26, appliedCatShift:0}`。

### 四靶实测（`errs: []`，全 `alphaTrustworthy: true`，`sf:2`，位图 1040×1488）

| 靶 | 近侧墨迹 | 远侧 | 出屏 | 帧裁 | 盒子屏幕 | frameX | 帧内「盒+阴影」 | plan（现算） | 猫三态 | 开/关跳帧 | 关窗后 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P `.peek` 贴右 | **21.5** | 21.5 | 0 | 0 | [1356,1676] | 1330 | **[0,372]** ⊂ [0,520] | ideal −104 / popShift −74 / catShift 30 / **残差 0** | 恒 1560 | 0/71, 0/54 | `left:auto`、`applied:0`、frameX→1360 |
| A `.ask` 贴右 | **21** | 21 | 0 | 0 | [1336,1676] | 1310 | **[0,392]** | ideal −114 / −64 / 50 / **0** | 恒 1560 | 0/66, 0/110 | 同上 |
| M `.ask` 贴左 | **21** | 21 | 0 | 0 | [4,344] | −150 | **[128,520]** | ideal 114 / 64 / −50 / **0** | 恒 0 | 0/66, 0/110 | 同上，frameX→−200 |
| R 静息 | — | — | — | — | — | 恒 1360 | — | `catShift` 恒 0 | 恒 1560 | 0/61 | `applied:0` |

**这些数字与 #14b 的注入版逐位相同** —— 这正是重跑的意义：落地没走偏。

### 三条可复用零件（#15 新增）

**(1) H3 的判定性测量** —— 把阴影外扩算进帧内坐标，直接判它在不在 `[0, 帧宽]`：
```js
shadowInFrameL: Math.round((box.L - SHADOW) * 10) / 10,
shadowInFrameR: Math.round((box.R + SHADOW) * 10) / 10,
```

**(2) 不变式现算现验** —— 弹窗开着时用猫的**真实屏幕 x** 重新推一遍 `ideal`，和实际的
`--pop-shift` / `appliedCatShift` 对账。⚠️ 是 `popShift - catShift`，不是 `+`（这个号曾写错三处注释，
是 `test/pet-edge-cycle.js` 抓出来的，不是推理出来的）：
```js
const ideal = g.capsuleShift({ petCenterX: catScreenL + 60, capsuleWidth: box.w, workArea: wa, petWidth: 120 });
const popShift = parseFloat(getComputedStyle(stage).getPropertyValue('--pop-shift')) || 0;
let cs; try { cs = appliedCatShift; } catch (e) { cs = null; }
return { ideal, popShift, catShift: cs, residual: Math.round((popShift - cs - ideal) * 10) / 10 };
```

**(3) 猫三态恒等断言** —— 静息基线要在开窗**之前**取，关窗后再比一次：
```js
const restCat = r.pre2.catScreenL;
if (Math.abs(s.catScreenL - restCat) > 2) bad.push('★猫开窗时动了:静息 ' + restCat + ' → 弹窗 ' + s.catScreenL);
if (r.post && Math.abs(r.post.catScreenL - restCat) > 2) bad.push('★猫关窗后偏了:→ ' + r.post.catScreenL);
```

### 顺带确认的两件事

- **`relative + left` 不会把祖先撑宽**：弹窗期间 `#compact-row` 的 `scrollWidth` 是 140/133/144，
  和静息态一样。对照组：早期探针里改成 `transform` 时，shift=204 能把祖先从 275 撑到 479。
  ⇒ `catShift` 不会喂回 `measuredRestingWidth`，不需要额外防护。
- **`POPUP_SHADOW_SPREAD` 只决定「怎么分」，不决定「总共挪多少」**：SHADOW=24 → `popShift −66`，
  SHADOW=26 → `−64`，盒子两次都落在 `[1336,1676]`，逐位相同。⇒ 以后改 `.bubble`/`.think`/`.action-pop`
  的阴影样式，不必回来重算这个常数。

### 收尾输出（判据齐全时应该长这样）

```
pet.js 零注入自证: (与 HEAD 逐字节相同 ✓)
patched main.js, node --check 通过
...
restored main.js, node --check rc=0
(worktree clean)
```
跑完 `ps` 确认只剩用户自己的进程（本轮：Orca 866 / CorpLink 47509 / VSCode 87533、87598），无残留 electron。
