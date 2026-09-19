# WorkMeow 硬约束与踩坑记录

> 与 `H1-H2-bug-fix-handoff.md` 配套。**动手改任何代码之前先读这一份。**
> 这里的每一条都是前几轮实际踩出来的，不是预防性清单。

---

## 一、用户的安全 / 操作约束（逐字保留，不得自行放宽）

> 「我要下班了，你处理玩，不用推送，本地修改就行。**需要权限自己通过**，我没法给你了」

→ **只做本地修改与本地提交，绝不 `git push`。** 权限提示自行通过。

> 「说中文，我看不懂」

→ **所有面向用户的输出必须是中文**（曾违反过一次，开场两段写了英文）。

> 「先列计划，分析清楚，再开始修复。**之前这个问题改好多次，还没彻底解决**」

→ 动手前先出计划。

> 「静态推理这次不算数 —— 前几轮都是推理过了、实测才发现没解决」

→ 关键判断必须有真机 probe 数据支撑。

### 不许动的进程

| 进程 | PID |
|---|---|
| 用户自己的 `npm start`（WorkMeow） | **97572 / 97578 / 97579 / 97635** |
| Orca | 866 |
| CorpLink | 47509 |
| VSCode | 87533 / 87598 |

后四个也是 Electron，`pkill -f electron` 会连它们一起杀。探针一律用 `start_new_session=True` + `killpg(os.getpgid(proc.pid))` 只杀自己那一组，跑完主动 `ps` 复查有没有残留窗口（曾有 PID 60362 的残留窗口被用户看到）。

### git

- 仓库：`/Users/gaobinbin/Downloads/codes/WorkMeow`，分支 `fresh-main`
- `origin` = `git@github.com:BinbinGood/MyWorkMeow.git`
- `upstream` = `https://github.com/vista-zhangg/WorkMeow.git`
- **绝不合并 `upstream/main`** —— 无共同祖先，一合就是 `76 files changed, 5507 deletions`，会抹掉全部 macOS 工作
- 退路：`git reset --hard de42083`

⚠️ 环境提示里说「非 git 仓库」指的是 primary working directory `/Users/gaobinbin`，**WorkMeow 本身是 git 仓库**。

### 测试

```
HOME=/tmp/wm-test-home npm test
```

**必须带 `HOME=`**：`test/opencode-plugin.js:50-51` 只重定向 `USERPROFILE`，mac 上会写进真实 `~/.workmeow`。

---

## 二、★ 已被证伪的 14 条结论（不要再重走）

1. **「E2/H1 剩余抖动的成因是帧宽变化（静息 ↔ 520）」** —— **两次**被自己的数据证伪。根因：`restingFrameWidth()`（`renderer/pet.js:864-870`）是 `Math.min(900, Math.max(POPUP_W, …))`，**有 520 下限**，连 0 会话时帧宽也是 520。不要再传播。
2. 「`peekSessions()` 把注入的会话过滤掉了」—— 错。
3. 「`setPetSize` IPC 有去重」—— 错，去重在 `applyPetSize` 内部的 `same()`。
4. 「高度和 y 被拆成两笔事务」/「合成器还持有旧表面并裁掉顶部」—— 已证伪。
5. 「`renderPeek()` 的 `peekList.innerHTML=''` 整体重建会重播动画」—— 已证伪。
6. 「AppKit `constrainFrameRect:toScreen:` 仍在钳帧」—— `probeClamp` + `probeNoBlur` **双重**证伪（2ms 轮询 6 轮零变化 + A/B 12 例 `frameChanges:0`）。
7. 「`closePeek()` 的 `resetPetSize()` 触发真 resize 导致闪帧」—— 证伪，帧本来就 520×744，`same()` 直接 return。
8. 「`blurPet()` 不能删，因为它是 F4 帧钳制的触发源」—— 探针 #7 证伪。修掉 F4 的是 `enableLargerThanScreen: true`；`blurPet` 现在只剩「归还焦点」一重职责。
9. **「rAF 全程无掉帧 ⇒ 合成层没问题」** —— 证伪。rAF 对 `visibilityState` 引起的合成中断**结构性地盲**（见下方盲区 A）。
10. 「`backgroundThrottling` 线索既未证实也未排除」—— 探针 #9 **证实了它**。
11. **「封顶之后 320/340 宽的弹窗在猫的任何位置都不会被裁 —— 逐 1px 全扫已验」**（原写在 `renderer/pet.js:687-688`）—— **错，这就是 H2 的根因**。全扫验的是「不出**屏幕**」，而真正裁内容的是 `renderer/pet.css:3-7` 的 `html,body{overflow:hidden}`，它裁的是**窗口帧**。同一盲区的另一种表述在 `renderer/pet.css:393`：「位移只对 ≤320 宽的弹窗成立」—— 320 宽也超 4px。两处已随 `43ec5f6` 修正。
    **教训**：「已验（逐 1px 全扫）」这种口径最容易骗人 —— 扫得再密也只覆盖它当初断言的那个边界。看到这类注释要先问**它断言的是哪个边界**。
12. **「H2 修后残留的那 20px 是『出屏』而非『帧裁』，弹窗在自己的 520 帧里内容完整，属于预期」** —— **被用户的眼睛证伪**（这是我 H2 的结案结论，写在 `43ec5f6` 的注释和两份交接文档里）。
    用户原话两条：「气泡周围本来是有阴影的吧？如果喵靠在右边，**左边缘的阴影也没了**」「贴边那一测，如果出现有选项的弹窗，**贴边那一侧的圆弧都没了**」。
    错在三处：(a) 「出屏」和「被裁」在眼睛看来**一模一样**，这个二分对用户毫无意义；(b) 圆弧就长在那 20px 里；(c) 我 clamp 错了矩形 —— clamp 的是**盒子**，而 `box-shadow` 画在盒子**之外**，被 `html,body{overflow:hidden}` 整块吃掉，该 clamp 的是「盒子 + 阴影」。
    **教训**：别用「技术上属于哪一类」去替用户判断「看不看得见」。
13. **「帧宽 520 + 弹窗宽 340 + 猫可贴死屏幕缘，三者数学上不能同时满足 —— 只能二选一：出屏 20px 或被裁 20px」** —— **证伪**（H3，`2346b9a`）。这条「不可能三角」的隐含前提是**「帧原点只能是 猫x − 200」**。**帧可以动**：把总位移拆成「帧内挪弹窗（上限含阴影）+ 帧内挪猫（由主进程 `main.js:333` 的 `anchored` inset 反向帧移抵掉）」，实测出屏 **20 → 0**、两侧阴影各 21/21.5px 全在、猫的屏幕坐标一动不动、`POPUP_W` 一个字节没动。
    **教训**：碰到「不可能三角」先去找那个没说出口的固定量。我当时还据此给用户摆了一张三条路的**代价菜单**（变窄 / 内挪 / 加宽 `POPUP_W`），被用户顶回来：「我想要的是，一侧贴边，另一侧的阴影还存在。**这个不能做到么？**」—— 用户要结果，不要代价菜单。
14. **「注入版探针全绿 ⇒ 落地版也对」** —— 结构性不成立（不是被某次数据证伪，而是判据本身不覆盖）。#14/#14b 靠 `window.__PROBE_FIX_OFF` 切 A/B 比**差值**，差值绿只证明「算法对」，不证明落点、调用顺序、去重条件、归零路径落地时没走偏 —— 而 H3 途中**真的**在这些地方抓到过缺陷（关窗后 `catShift` 不归零，见 §十二）。
    → 修法：修法提交后必须再跑一轮**渲染端零注入 + 绝对判据**的探针（#15 `probeShipped.py`），并让探针自己 `git diff --stat -- renderer/pet.js` 自证。

---

## 三、★ 五个已知的探测盲区（探针设计时必须避开）

### 盲区 A：rAF 采样看不见 `visibilityState` 引起的合成中断

`visibilityState === 'hidden'` 时 Chromium 停止**向屏幕提交合成帧**，但主线程的 rAF 照跑、DOM API 全部正常。探针 #9 的数据就是铁证：`visChangeCount: 2` 而 `hiddenFrames: 0`、`gaps50: []`、122 帧/1965ms ≈ 16.1ms。

**前四轮探针（probeEdge / probeFlash / probeFocus / probeClamp）全部依赖 rAF 逐帧采样，所以全部对 H1 的真根因盲。**

→ 修法：直接记 `visibilitychange` 事件，不要只靠 rAF。

### 盲区 B：给 `win.setBounds` 打桩看不见 AppKit 层的钳帧

钳制发生在 AppKit 层，比 JS 层低一层，打桩零调用。
→ 修法：~2ms 高频轮询 `win.getBounds()`。

### 盲区 C：量错了元素

前三份探针量的全是 `#cat`（CSS 固定尺寸的容器 div），而真正显示画面的是 **`#cat-img`**（`renderer/pet.html:125-127`）。

同类盲区：`#stage.cat-hidden #cat { display: none }` 是通过**祖先** class 设的，而早期探针的 `rect()` helper 只检查 `#cat` 自己的 class。

### 盲区 D：`getBoundingClientRect` **不含 `box-shadow`**（2026-09-18，H3）

这是探针 #10 对 H3 结构性盲的原因 —— 它量的全是 `rect()`，而 H3 丢的恰好是盒子**之外**的那层墨迹。
→ 修法：`wc.capturePage()` → `img.getBitmap()`（BGRA，第 4 字节是 alpha），在弹窗竖直中心的扫描线上从盒子缘往外数连续非透明像素（阈值 3）。见 `probes/probeShadow.py` 的 `inkScan()`。
⚠️ 必须带 alpha 可信度自检（远端动态选点采样 `farAlpha`，应为 0 且 `alphaTrustworthy:true`），否则量到的可能是整屏不透明的假位图。
⚠️ **静态估值会错得很厉害**：我按 `blur/2` 估 `.peek` 是 13px，实测 **21.5px**（错 65%）。

### 盲区 E：`relative + left` vs `transform` —— 只有一个会撑宽祖先（2026-09-18，H3）

给元素加 `transform: translateX(204px)` 会把祖先的 `scrollWidth` 从 275 撑到 479（实测），
而 `position:relative + left:204px` 不会（弹窗期间 `#compact-row` 的 `scrollWidth` 恒 140/133/144，与静息态相同）。
桌宠这里很要命：撑宽祖先 → 喂回 `measuredRestingWidth` → 帧宽变化 → 抖动（2026-09-16 的教训同款）。
⚠️ 另外**不能用 `transform` 挪弹窗**：`.peek/.ask/.think` 的入场 keyframes 结尾是 `transform: none`，会把位移擦掉。
⚠️ 也不能用 `margin`：margin 挤压兄弟、参与布局，同样喂回 `measuredRestingWidth`。

---

## 四、探针方法论（可复用）

### ★ 拿到真窗口焦点的唯一有效解法

`sendInputEvent` 注入的是 Chromium 层合成事件，**不给 NSWindow 焦点** → `w.blur()` 成空操作 → 测不出任何真失焦行为。
`win.focus()` 对 accessory app **无效**，根因是 `app.dock.hide()`（`main.js:1991`）。单 patch 掉 `app.dock.hide()` 也不够（探针 #8 的 A 组 3/3 失败）。

**探针 #9 的解法，16/16 全部 `gotFocus:true`**：

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

同时要 patch 掉 dock 隐藏：
```
DOCK     = "      try { app.dock.hide(); } catch {}"
DOCK_NEW = "      try { if (!env.flag('PROBE_X')) app.dock.hide(); } catch {}"
```

⚠️ `app.focus({steal:true})` **只在探针里用**，绝不进产品代码。

### 启动骨架

```python
TRIGGER     = "    try { buildTray(); } catch {}\n    initUpdateService();\n"
TRIGGER_NEW = TRIGGER + "    if (env.flag('PROBE_X')) runProbeX();\n"

env.update({"WORKMEOW_PROBE_X":"1", "HOME":"/tmp/wm-probe-home",
            "WORKMEOW_NO_NET":"1", "WORKMEOW_ALLOW_MULTI":"1",
            "WORKMEOW_NO_HOOKS":"1", "WORKMEOW_NO_CODEX":"1",
            "WORKMEOW_NO_OPENCODE":"1", "WORKMEOW_NO_TRAE":"1"})

proc = subprocess.Popen(["npx","electron","."], cwd=REPO, env=env,
                        stdout=PIPE, stderr=STDOUT, text=True,
                        start_new_session=True)
# finally: killpg + shutil.copy(BAK, MAIN) + node --check + print("restored main.js")
```

- `env.flag(name)` = `process.env['WORKMEOW_' + name] === '1'`（`backend/env.js:28`）
- `LEGACY_ALIASES` 里没有 `NO_WORKBUDDY_WATCH` → 用 `WORKMEOW_NO_TRAE=1`
- 退出用 `app.exit(0)`，不要靠 `process.exit`

### 其他探针要点

- **`window.pet` 是 contextBridge 的冻结对象，hook 不上**（赋值静默失败）。
  - 要读渲染端模块级变量 → **临时 patch `renderer/pet.js`**（探针 #6 就是这样暴露 `window.__MI`）
  - 要换 `window.pet` 的方法实现 → **临时 patch `preload.js`**（探针 #7 就是这样做 A/B）
- **`emitStats()` 是全 app 唯一真心跳**（`statsTimer = setInterval(emitStats, 4000)`，`main.js:1219`，带 `.unref()`）。探针注入的假快照会被 4s 心跳冲掉 → 先 `clearInterval(statsTimer); statsTimer = null;`
- **页面 CSP 没有 `unsafe-eval`**（探针 #10 踩到）：`executeJavaScript` 里 `eval('someTopLevelLet')` 直接抛，所以**读不到渲染端的顶层 `let`/`const`**。但**直接写在注入代码里的标识符**能正常解析（同一个作用域链）→ 想读 `POPUP_W` 之类就直接写名字，不要包 `eval`。
  ⚠️ 不要为此放宽 CSP。
- **包 `window.applyStats` 拦不到任何东西**：`renderer/pet.js:2902` 的 `window.pet.onStats(applyStats)` 在页面加载时就把**原始引用**交出去了，之后改 `window.applyStats` 对已注册的回调无效。要看错误就装全局 `error` / `unhandledrejection` 桶 + 在注入代码里自己 try/catch。
- **`reset()` 不重算 `--pop-shift`**：探针里改完猫位置直接量，量到的是**陈值**。必须显式再调一次 `applyPopupShift(...)` 才是当前几何。
- **`#ask` 不必走 radial 入口**：`applyStats(假快照)` 全链路就能开（会话 `state` 为 `waiting`/`needsinput`、带 `choice`、`choice` 有非空 `options` 或 `allowInput`）。探针 #10 实测 `openedAt: L1`，三级升级里第一级就成功。
  ⚠️ 写多级升级时门要写对：`const open = (r) => r && r.hidden === false;` 然后 `if (!open(out.L1) && !open(out.L2))` —— 早期写成 `if (!out.L2 || …)` 会在 L1 已成功时照样跑 L3。
- **第一轮 peek 状态反相**（已累计出现 **3 次**：probeFocus / probeNoBlur / probeVis）：上一轮残留的 peek 打开态导致第一次点击变成「关」，该轮数据作废。→ 第一轮前多跑一次 reset + 更长 sleep，并加 `VERDICT:INVALID` 硬断言自查。
- **Quartz (pyobjc) 不可用**：`ModuleNotFoundError: No module named 'Quartz'`。
- 未深究的记账：探针 #8 出现 `medianGap: 0.1-0.2ms` 而 max 17.7ms（300 帧/2490ms ≈ 8.3ms）→ 帧成簇产出，只在失焦态出现。成因未判定。

### ★★ 修法验证分两轮：注入版 → 落地版（H3 立的规矩）

**注入版绿 ≠ 落地版绿。** 注入版（探针 #14/#14b）把候选修法写进渲染端、用 `window.__PROBE_FIX_OFF`
在同一进程里切 A/B，量的是**差值**。差值绿只证明「算法对」，不证明「提交进产品代码的那份对」——
落点、调用顺序、去重条件、归零路径全都可能在落地时走偏。H3 途中就真的这样抓到过缺陷（见 §十二）。

⇒ **修法一旦提交，必须再跑一轮「渲染端零注入」的绝对判据探针**（#15 `probeShipped.py` 是模板）。
三条要求：

1. **只许改 `main.js`**，`renderer/pet.js` 一个字节不动，而且要**自证**：
   ```python
   diff = subprocess.run(["git","diff","--stat","--","renderer/pet.js"], cwd=REPO, ...).stdout.strip()
   if diff: print("ABORT: pet.js 被改过，这一轮就不是「验落地版」了"); return 1
   ```
   没有 `pet.js 零注入自证:` 这一行的「落地版验证」不算验证。
2. **判据改成绝对值**，不比差值（差值判据在没有 A/B 开关的产品代码上根本没法跑）。
3. **用产品符号做门禁**，探针里不出现任何 `PROBE_*`。产品的顶层 `let`/`const`/`function`
   可以直接用**裸名**读到 —— `renderer/pet.js` 是普通 `<script>`（`pet.html:154`），顶层 `function`
   落在全局对象上、顶层 `let/const` 落在全局声明式环境里，两者都能被 `executeJavaScript` 里的
   裸标识符引用解析到（普通引用，不走 `eval`，所以不撞 CSP）：
   ```js
   r.popupShiftPlan = typeof popupShiftPlan === 'function';
   try { r.POPUP_SHADOW_SPREAD = POPUP_SHADOW_SPREAD; } catch (e) { r.POPUP_SHADOW_SPREAD = 'unreachable'; }
   ```
   ⚠️ 必须包 `try/catch`：符号不存在时抛 `ReferenceError`，**而这恰好就是「修法没落地」的判据**。

⚠️ 别改写旧探针来做这件事 —— 旧探针是上一轮的证据记录，要**新建**一份。

---

## 五、pin 清单（改动不得打破）

### G1 三道防线（`test/pet-edge-cycle.js:806-834`）

```js
assert(/function releaseClickThrough\(/.test(mainJsCode), …);
assert(/releaseClickThrough[\s\S]{0,200}setIgnoreMouseEvents\(false\)/.test(mainJsCode), …);
assert(/IPC\.PET_BLUR[\s\S]{0,400}?w\.blur\(\)[\s\S]{0,200}?releaseClickThrough/.test(mainJsCode), …);
assert(/win\.on\('blur',[\s\S]{0,120}?releaseClickThrough/.test(mainJsCode), …);
assert(/!st\.win\.isFocused\(\)\)\s*releaseClickThrough\(st\)/.test(mainJsCode), …);
assert(/if \(!st\.mouseIgnoring\) return false;/.test(mainJsCode), …);
assert(!/forward:true keeps mousemove flowing/.test(mainJs), …);
assert(/window\.addEventListener\('blur',[\s\S]{0,600}?askHover = false/.test(petJsCode), …);
assert(/window\.addEventListener\('blur',[\s\S]{0,600}?actionPopOpen\) closeActionPop\(\)/.test(petJsCode), …);
assert(/function closeActionPop\(\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(!actionPopOpen\) return;/.test(petJs), …);
assert(/if \(!quotaPopoverOpen\) return;/.test(petJsCode), …);
assert(/if \(!askActive && !peekOpen\) resetPetSize\(\);/.test(petJsCode), …);
```

### `HIT_SEL`（两条）

- `test/pet-insights.js:103-104` —— 钉字面量**前缀** `#cat,#stage.cat-hidden #chip,`
- `test/popup-style.js:122` —— `/const HIT_SEL = '[^']*#peek/` 要求它保持**单引号单行字符串**

### `POPUP_W`（两条硬 pin）

- `test/pet-edge-cycle.js:789` —— `/const POPUP_W = 520;/`
- `test/popup-style.js:34` —— "popup measurement width must remain stable"

### BrowserWindow 字面量（`test/popup-style.js:189-195`）

```js
const petWin = main.match(/const win = new BrowserWindow\(\{[\s\S]*?\n  \}\);/)?.[0] || '';
assert(/transparent:\s*true/.test(petWin) && /backgroundColor:\s*'#00000000'/.test(petWin), …);
assert(/enableLargerThanScreen:\s*true/.test(petWin), …);
```

★ **已核实**：非贪婪终止锚是 **2 空格**缩进的 `\n  });`，而 `webPreferences` 的闭合是 **4 空格**的 `    },` —— 往 `webPreferences` 里加行**不会**提前终止匹配，三条断言全是正向，不受影响。

### 邻近性 pin（`test/pet-insights.js:137`）

```js
assert(/transparent:\s*true,[\s\S]{0,400}?backgroundColor:\s*'#00000000'/.test(…
```

★ **已核实**：`main.js` 里 `transparent: true,` 在 `:444`、`backgroundColor` 在 `:450`、`enableLargerThanScreen` 在 `:469`、`webPreferences {` 在 `:475` —— 400 字符窗口覆盖 `:444`–`:450`，加在 `webPreferences` 里落在窗口**之后**，无冲突。

### IPC 契约（`test/ipc-contract.js:1-29`）

逐条校验每个通道在 `main.js` / `preload.js` / `shared/ipc-channels.js` 三处一致。**新增通道必须同步四处**：`IPC` 常量 + `PUSH_CHANNELS`/`COMMAND_CHANNELS` + `preload.js` 的字面量副本 + `ipcRenderer.on` + `main.js` 里的 `IPC.KEY`。

### H1 / H2 新增的 pin（2026-09-18，`babae48` / `43ec5f6`）

| pin | 位置 | 钉的是 |
|---|---|---|
| petWin 必须有 `backgroundThrottling: false` | `test/popup-style.js` | H1 主修。注释里必须写实测口径（A/B × 左右键），不能写「按文档」 |
| `closePeek` 不许调 `blurPet` | `test/pet-edge-cycle.js` | H1 副修 (d)。peek 无输入框，F4 已由 `enableLargerThanScreen` 承担 |
| 弹窗帧内坐标必须落在 `[0, POPUP_W - popW]` | `test/pet-edge-cycle.js` | H2 修法 (a)。原来的全扫只查「不出**工作区**」，查不到帧裁 |
| `applyCapsuleShift` **禁止**传 `frameWidth` | `test/popup-style.js` | 挡住「顺手也给胶囊加上」。胶囊帧宽是变的 `restingFrameWidth()`，压这层会改「贴边留 4px」的观感，**必须先单独实测** |

配套的 `test/pet-geometry.js` 还有两条**省略参数**的断言，钉 `capsuleShift` 的 `frameWidth` 默认值必须是 `Infinity`：
变异测试（M5）证明**显式传 `Infinity` 的断言抓不到默认值被改**，必须真的省略这个入参才能抓到。

⚠️ `shared/pet-geometry.js` 里 `capsuleShift` 的**签名必须保持单行** —— `test/popup-style.js` 用
`/function capsuleShift\([\s\S]*?\n  \}/` 按文本提函数体，签名换行会让匹配错位。
同理 `/frame - width/`、`/frameWidth = Infinity/` 也是按**文本**匹配实现的，改写法前先看这几条。

### H3 新增的 pin（2026-09-18，`2346b9a`，**14 条逐条变异验红**）

**`test/popup-style.js`（按文本提函数体后正则断言）**

| pin | 行 | 钉的是 |
|---|---|---|
| `popupShiftPlan` 必须转发 `petWidth` | `:221-224`（与 `applyCapsuleShift` 同一个循环） | 封顶要跟着真实锚宽走 |
| `popupShiftPlan` **禁止**传 `frameWidth` | `:250-256` | ★ H2 正是传了它，把盒子钉在帧壁上 —— 「吃掉近侧阴影和贴边侧圆弧」的就是这一手。溢出该交给 `catShift` |
| `const POPUP_SHADOW_SPREAD = \d+;` 必须存在 | `:257-259` | 断言文字里写了实测口径（`.peek` 21.5 / `.ask` 21），理由是 `getBoundingClientRect` 不含阴影 |
| `tight` 必须**减**掉 `POPUP_SHADOW_SPREAD` | `:260-262` | 只按居中余量封顶 = 退回 H2 的 bug |
| `catShift: Math.round(popShift - ideal)` 字面量 | `:267-269` | 写死成减法，让不变式**在算术上不可能破**；独立重算会让两半漂移、猫跳 |
| `applyCatShift` 必须用 `position:relative` + `left` | `:290` | |
| `applyCatShift` **禁止** `margin` / `transform` | `:292` | `margin` 挤兄弟节点撑宽布局；`transform` 被 `.peek/.ask/.think` 入场 keyframes 的 `transform: none` 擦掉 |
| 归零时必须真的清掉属性（`: ''`） | `:296` | 只清 `left` 会留下 `position:relative` 停在那 |
| ★ `applyCatShift` 必须在 `anchoredLayoutPayload` 里、`measureEdgeRect` **之前** | `:303-306` | 顺序是有 pin 的（我先前以为只有注释）。`screenX` 的来源要求它在 `petGeometrySnapshot()` 之后 |
| `fitRestingFrame` 去重必须含 `appliedCatShift === 0) return;` | `:318` | ★ 见 §十二。少这一项 → 关窗后 `catShift` 不归零 |

**`test/pet-edge-cycle.js`（逐 1px 全扫，算术侧）**

| pin | 行 | 钉的是 |
|---|---|---|
| 不变式 `popShift − catShift === ideal`（±0.5） | `:488-489` | ★ **这条抓到了我写在三处注释里的 `+`/`−` 号错误** —— 不是推理抓到的 |
| 帧移必须抵掉 `catShift`：`winX + catInset + catShift === catX` | `:494-496` | 「整套修法的地基」。破了它猫就跟着弹窗跑 |
| 「盒 + 阴影」必须整体落在 `[0, POPUP_W]` | `:530-533` | H3 的判定性判据 |
| 复刻 `popupShiftPlan` 的 `POPUP_SHADOW_SPREAD = 26` | `:463`、`:475` | 算术侧的独立副本；改产品常数要同步改这里，否则全扫用旧值 |

### 无 pin 保护的（可安全改）

- 弹窗宽度 **340 / 320** —— 只在注释和 `test/pet-edge-cycle.js:451` 的 `POPUPS` fixture 里出现，无硬断言

~~渲染端 `renderer/pet.js:3461` 的 `if (on === mouseIgnoring) return;`~~ —— **已于 `babae48`（H1 副修 (b)）删除**，
去重挪到主进程 `SET_IGNORE_MOUSE` handler。⚠️ 见下方 §十一 的初始值坑。

---

## 六、写 pin / 改测试的纪律

1. **变异测试**：pin 写完必须**逐条拆掉修法**验证它会红。没验红的 pin 不算 pin。
2. **提 CSS 块不要用正则** —— 必须用括号计数。曾因 `[\s\S]*?\n\}` 在单行 keyframes 写法下吃到后面别的规则的 `}`，误报 `@keyframes thinkIn must not animate transform`。
3. **`test/popup-style.js:26` 的 `codeOnly()`** 按**行首**判注释，刻意**不**按 `//` 位置切 —— 行尾注释里的内容仍会被 pin 看见。
4. **`\b` 边界会把 `margin-top` 误当 `top`** → 用 `!/[;{\s]top:/`。
5. **无头测试跑不出穿透/布局行为**：`test/dom-stub.js:145 elementFromPoint: () => null`、`:199 addEventListener: () => {}`。穿透与真实几何只能靠真机探针。

---

## 七、环境坑

- **本机 zsh 没有 `timeout` 命令** → 给 Bash 工具本身传 `timeout` 参数，不要写 `timeout 220 python3 …`
- **zsh glob 无匹配即报错**：`grep --include=*.js` 和 `ls assets/*.gif` 都会 `no matches found` → 加引号，或改用 `find . -name "*.gif" -not -path "./node_modules/*"`
- GIF 实际在 **`assets/cat/`**，不在 `assets/` 根下。28 个，最大 `cat-loafing-5.gif` = 339912 bytes
- **`Write` 一个已存在的文件前必须先 `Read`**（否则 "File has not been read yet"）
- **Edit 的 `old_string` 跨多行时必须逐行核对**被替换文本里的每一行（尤其注释）都在 `new_string` 里出现过 —— 曾吃掉一行既存注释
- **中文注释里有全角括号是正常的** → 探针脚本自检不能整文件查全角括号，只能查具体笔误模式（如 `s.count('sleep（')`）。曾因 `await sleep（400);` 报错
- **全角/半角逗号不匹配**导致 `Edit` 连续失败两次

---

## 八、常量表

### `renderer/pet.js`

| 常量 | 值 |
|---|---|
| `POPUP_W` | 520 |
| `POPUP_BOTTOM` | 200 |
| `ASK_VIEWPORT_MAX_H` | 520 |
| `PET_FRAME_H` | 744 |
| `BASE_PET_FRAME_H` | 340 |
| `CAPSULE_FRAME_MIN_W` | 320 |
| `CAPSULE_FRAME_MAX_W` | 900 |
| `CAPSULE_FRAME_GUTTER` | 24 |
| `PEEK_AUTO_CLOSE_MS` | 8000 |
| `POOL_ROTATE_MS` | 60000 |
| **`POPUP_SHADOW_SPREAD`** | **26**（H3 新增，`:821`） |

H3（`2346b9a`）新增的符号，落点逐行：

| 符号 | 行 | 是什么 |
|---|---|---|
| `popupShiftPlan()` | `:693` | 把总位移拆成 `{popShift, catShift}` 的唯一算处 |
| `const tight = …` | `:751` | 帧内安全余量 `max(0, (POPUP_W − widest)/2 − POPUP_SHADOW_SPREAD)` |
| `widestVisiblePopup()` | `:765` | 抽出来的「当前可见弹窗里最宽的那个」。**无 pin**，但被探针 #15 当产品符号门禁读 |
| `applyPopupShift()` | `:778` | 写 `--pop-shift` |
| `applyCatShift()` | `:805-811` | 给 `#compact-row` 临时设 `position:relative` + `left` |
| `POPUP_SHADOW_SPREAD = 26` | `:821` | ⚠️ `test/pet-edge-cycle.js:463` 有一份**算术侧副本**，改这里要同步改那里 |
| `let appliedCatShift = 0` | `:825` | 当前已施加的偏移量。关窗归零的判据，也是 `fitRestingFrame` 去重第三项读的位 |
| 注入点 | `:604-605` | 在 `anchoredLayoutPayload` 里，`petGeometrySnapshot()` 之后、`measureEdgeRect()` 之前 |
| `fitRestingFrame` 去重第三项 | `:1008-1020` | `&& appliedCatShift === 0`。见 §十二 |

★ **26 这个值只决定「总位移怎么分」，不决定「总共挪多少」** —— 实测 SHADOW=24 → `popShift −66`、
SHADOW=26 → `−64`，盒子两次都落在 `[1336,1676]`，逐位相同（探针 #15）。
⇒ 以后改 `.bubble`/`.think`/`.action-pop` 的阴影样式，**不必回来重算这个常数**，
也不必去补测它们的外扩量。

### ★ 弹窗 `box-shadow` 的实测外扩量（只能像素量，见 §三 盲区 D）

| 弹窗 | `box-shadow` | 我按 `blur/2` 静态估 | **实测** |
|---|---|---|---|
| `.peek` | `0 9px 26px` @`pet.css:265` | 13px | **21.5px** |
| `.ask` | `0 8px 24px` @`pet.css:115` | 12px | **21px** |

静态估值错了 **65%**。`POPUP_SHADOW_SPREAD = 26` 是按实测的 21.5 往上取整留余量。

### `main.js`

| 常量 | 值 |
|---|---|
| `PET_BODY_W` | 120 |
| `PET_BODY_H` | 120 |
| `PET_FRAME_H` | 744 |
| `RESTING_BELOW_RESERVE` | 28 |

### 弹窗宽度（`renderer/pet.css`）

| 选择器 | 行 | 宽 |
|---|---|---|
| `.ask` | `:103` | `min(340px, calc(100vw - 24px))` |
| `.peek` | `:259` | `min(320px, calc(100vw - 24px))` |
| `.action-pop` | `:396` | `min(496px, calc(100vw - 24px))` |

⚠️ `test/pet-edge-cycle.js:53` 的 `BASE_FRAME_H = 340` 是**帧高**，与弹窗宽的 340 无关，别混。

### 真机环境

`screen.getPrimaryDisplay().workArea` = `{x: 0, y: 30, width: 1680, height: 956}`
⚠️ 此前算术里用过的 1512×900 是**错的**。

Electron 43.4.0。**全 app 零 `appendSwitch`、零 `backgroundThrottling`** —— 三处 `webPreferences`（`main.js:475` petWin / `:539` / `:588`）全用默认值。

---

## 九、`blurPet` 的 4 个调用点（H1 副修 (d) 要动的那个在这里）

`preload.js:88-89`：`blurPet: () => ipcRenderer.send(IPC.PET_BLUR),`

| 调用点 | 行 | 有输入框？ | 备注 |
|---|---|---|---|
| `hideAsk()` | `:1316` | **有**（`#ask-text`） | **不许删** |
| `closeActionPop()` | `:1451` | 无 | 有守卫 |
| `closePeek()` | `:1732` | **无** | ★ H1 副修 (d) 要删的就是这个 |
| `closeQuotaPopover()` | `:2634` | 无 | 三重守卫 |

⚠️ **`#peek` 没有任何输入框** —— 实测只有 `#ask` 有 textarea。`closePeek()` 调 `blurPet()` 调的是一个跟 peek 无关的东西。

`main.js` 侧：
- `:1486-1489` `ipcMain.on(IPC.PET_BLUR, (e) => { … w.blur(); releaseClickThrough(st); });`
- `:501` `win.on('blur', () => { releaseClickThrough(st); });`（在 BrowserWindow 字面量**之外**，满足 `test/popup-style.js` 的正则约束）

---

## 十、已修完的 bug（供回归复验对照）

| 编号 | 已修 | 提交 |
|---|---|---|
| E1 / E3 / E4 / F1 / F2 / F4 | 是，**已推远端** | — |
| G1（多次开关气泡后猫点不动） | 是，本地 | `e8f6a50` |
| E2（气泡关闭时往上消失再出现） | 是，本地 | `de42083` |
| **H1**（左键关气泡时猫消失再出现） | **是，本地** | `babae48` |
| **H2**（猫在屏幕边缘时气泡被裁「另一边」） | **是，本地**（修法 (a)；(b) 实测定案不做） | `43ec5f6` + 文档回写 `b27f610` |
| **H3**（贴边那一侧的阴影/圆弧没了，H2 自带的回归） | **是，本地**，已在**落地版**上实测结案 | `2346b9a` + 注释同步 `3383e40` |

H1 / H2 / H3 都**未推送**（用户要求「不用推送，本地修改就行」）。剩下只欠用户手动验证 7 条，见
`H1-H2-bug-fix-handoff.md` 的「手动验证」一节（第 4 条已改写成覆盖**阴影 + 贴边侧圆弧**）。

### H3 的回归基线（探针 #15 `probeShipped.py`，渲染端零注入，`errs: []`）

将来任何改动碰到弹窗位移/帧原点/阴影，用这四行对照：

| 靶 | 近侧墨迹 | 远侧 | 出屏 | 帧裁 | 帧内「盒+阴影」 | plan（现算） | 猫三态 | 开/关跳帧 |
|---|---|---|---|---|---|---|---|---|
| `.peek` 贴右 | **21.5** | 21.5 | **0** | 0 | **[0,372]** ⊂ [0,520] | ideal −104 / pop −74 / cat 30 / **残差 0** | 恒 1560 | 0/71, 0/54 |
| `.ask` 贴右 | **21** | 21 | **0** | 0 | **[0,392]** | −114 / −64 / 50 / **0** | 恒 1560 | 0/66, 0/110 |
| `.ask` 贴左 | **21** | 21 | **0** | 0 | **[128,520]** | 114 / 64 / −50 / **0** | 恒 0 | 0/66, 0/110 |
| 静息 | — | — | — | — | — | `catShift` 恒 0 | 恒 1560 | 0/61 |

帧宽恒 520；关窗后 `left:"auto"` / `appliedCatShift:0`。
**修前对照**（探针 #10/#11）：近侧墨迹 `.peek` **0**、`.ask` **0**；`.ask` 出屏 **20**。
`POPUP_W` 依然 520、`catInset` 200 没碰、贴边 4px 屏幕留白没丢 —— **几何代价为零**。

F4 的修法要点：`enableLargerThanScreen: true`（macOS 会在 blur 时把离屏的 frame 钳回工作区，而 `closePeek()` 会 blur —— 这就是猫往屏幕中间跑的原因）。注释里写清依据是**实测**：2 屏 × 左右缘 × 离缘 {0,40,199}px × 4 轮，关 = 48 例里 46 例漂移，开 = 48/48 零漂移。

---

## 十一、★ `st.mouseIgnoring` 的初始值是谎（H1 途中发现，交接文档原先没记）

`main.js` 里 `st.mouseIgnoring` 的**初始值写成 `true`，而 OS 侧实际是 `false`** —— 从没人发现，是因为
`SET_IGNORE_MOUSE` handler 原先**没有任何去重**，谎值不产生后果。

H1 副修 (b)（删渲染端守卫 + 主进程补去重）一旦只做「补去重」而不同时修这个初始值，后果是：
渲染端启动时那**唯一一次** `setIgnoreMouseEvents(true)` 派发会被去重当成重复调用吞掉
→ 整个 **520×744 的透明帧全程拦截点击** → 桌面完全点不动。

**这是比原 bug 严重得多的回归。去重和初始值必须在同一笔改里。** 已随 `babae48` 一并修掉。

同类风险的判据：**任何给 IPC handler 加去重的改动，都要先核对那个状态位的初始值与 OS 真实态是否一致。**
`releaseClickThrough` 里的 `if (!st.mouseIgnoring) return false;` 是 pin（`test/pet-edge-cycle.js:826`），
它读的是同一个位 —— 初始值改动必须同时确认不破坏这条 pin 的语义。

---

## 十二、★ H3 的落地缺陷：关窗后 `catShift` 不归零（探针 #14 抓的，不是推出来的）

这是 §二 第 14 条（「注入版绿 ⇒ 落地版也对」被证伪）指向的实例。

### 缺陷链

```
closePeek / hideAsk
  → resetPetSize()
    → fitRestingFrame(false)
      → 静息帧宽 = max(520, ceil(133 + 24)) = 520   ← 和弹窗宽**一样**
      → 高也没变
      → 去重命中、**早退**
      → setRequestedPetSize 不调
      → anchoredLayoutPayload 不跑
      → applyCatShift 没机会被调成 0
      → 猫带着 30 / 50 / −50px 的帧内偏移留在那
```

根子是「去重比的两项（宽、高）恰好都没变，而第三个状态（`appliedCatShift`）没人比」。
**修法**：给 `fitRestingFrame` 的去重加第三项 `&& appliedCatShift === 0`（`renderer/pet.js:1008-1020`，
pin 在 `test/popup-style.js:318`）。

### 为什么这不只是「看着歪」—— 会被持久化

| 位置 | 代码 | 后果 |
|---|---|---|
| `main.js:398` `restoreWindowOrigin` | `inset` 写死 `(width − 120) / 2 = 200` | 不查锚点，按 200 反算原点 |
| `main.js:1570` `keepCatOnScreen` | 同样写死 200 | 同上 |
| `main.js:534-538` `persistPos` | 只在 `st.customSize.mode === 'popup'` 期间早退 | **关窗后**下一个 `'moved'` 事件就把偏了 50px 的帧原点**写进磁盘** |

对比：正常路径上 `main.js:333`
`const inset = anchored ? anchor.screenX - anchored.x : (width - PET_BODY_W) / 2;`
是**读锚点**的，所以弹窗期间一切正常 —— 偏差只在「锚点没了、而偏移还在」的那个窗口期爆出来。
这也是 H3 一行主进程代码都没改的原因：正常路径本来就对。

### 教训（方法论，不只是这个 bug）

1. **去重条件的完备性 = 它比过的状态的完备性。** 加一个新的可变状态，就要去数所有「比旧值决定跳过」的地方。
   这与 §十一（`st.mouseIgnoring` 初始值是谎）是同一类病：**状态位与它的守卫脱节**。
2. 这个缺陷是**注入版探针（#14）跑出来的**，不是审代码看出来的 —— 而且是在「算法本身全绿」之后才暴露的。
   ⇒ 「主体判据全绿」不等于「可以提交」，**归零/收尾路径要单独设靶**。

