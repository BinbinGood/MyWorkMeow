# 在本地开发和制作打工喵（WorkMeow）安装包

本文说明如何进行源码开发、测试打工喵（WorkMeow），并制作本地安装包：Windows 上的 EXE 安装器，以及 macOS（Apple Silicon）上的 DMG。源码/npm 命令仅供开发者和贡献者使用，不是 Release 面向用户的安装方式。

## 支持范围

可打包的平台是 **Windows x64** 与 **macOS arm64（Apple Silicon）**。会话窗口聚焦是 Windows 专属能力，支持 Windows Terminal、cmd、PowerShell 和 VS Code 等常见窗口。

打工喵至少需要用户安装并使用过以下一个 agent：

- [Claude Code](https://claude.com/claude-code)
- [OpenAI Codex](https://github.com/openai/codex)
- TRAE
- WorkBuddy
- [opencode](https://opencode.ai/)

## 首次启动后

- 打工喵会把本项目需要的 Claude Code / TRAE / WorkBuddy hooks 和 opencode 插件**合并/安装**，不会覆盖已有配置；
- Codex 不安装 hooks，只读监听 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`；
- 新开的 Claude Code / Codex / TRAE / WorkBuddy / opencode 会话会出现在桌宠的会话列表中；
- 配置、位置和用量历史保存在 `~/.workmeow/`；界面固定为中文；
- 托盘菜单中的设置可以配置开机自动启动和下班彩蛋时间，默认时间为 10:55 和 16:55；

如果只使用 Codex，不希望安装 Claude hooks，可以按下方 PowerShell 示例设置 `WORKMEOW_NO_HOOKS` 后启动。

## 从源码部署

### 准备环境

- Windows x64，或 macOS 11+（Apple Silicon）；
- [Git](https://git-scm.com/)；
- Node.js 22.12 或更高版本（与 Electron 43 的开发依赖要求一致）；
- Claude Code 和/或 OpenAI Codex。

检查环境：

```powershell
git --version
node --version
npm --version
```

### 获取依赖并启动

```powershell
git clone https://github.com/vista-zhangg/WorkMeow.git
cd WorkMeow
npm ci
npm test
npm start
```

计划发布地址为 <https://github.com/vista-zhangg/WorkMeow>（仓库创建后生效），上游源码地址为 <https://github.com/myunwang/LLMPET>。

### 发布前许可证与素材检查

- 上游代码采用 MIT License；公开发布时必须保留根目录 [`LICENSE`](../LICENSE) 中的 `myunwang` 原始版权声明和完整许可文本；
- `assets/cat/` 中的 GIF 素材来自抖音博主 **@月薪喵** 的原创“月薪喵”表情系列；发布时必须保留 [`CREDITS.md`](../assets/cat/CREDITS.md) 中的来源与署名；
- GIF 不纳入项目 MIT 许可，第三方转载或移作其他项目仍需另行取得原作者许可；
- 删除上游 `.git` 历史并建立独立仓库不违反 MIT，但不能删除上游版权声明，也不能把上游代码表述为完全原创。

- `npm ci` 按 `package-lock.json` 安装锁定版本，适合可复现部署；
- `npm test` 运行项目的无头回归测试；
- `npm start` 通过脱离终端的启动器运行桌宠；调试时使用 `npm run start:console` 让 Electron 留在当前终端。

只验证界面、不修改 Claude Code 配置：

```powershell
$env:WORKMEOW_NO_HOOKS='1'
npm start
```

完全禁止可选的价格表联网请求：

```powershell
$env:WORKMEOW_NO_NET='1'
npm start
```

### 网络较慢时

Windows PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
```

如果打包阶段也无法连接 GitHub 的 Electron/7-Zip 发行地址：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run package:win
```

## 制作本地安装包

先执行：

```powershell
npm ci
npm test
```

### Windows EXE 安装包

在 Windows x64 环境中运行：

```powershell
npm run package:win
```

产物位于 `dist/`，包括 NSIS `.exe` 安装包、自动更新元数据和 `SHA256SUMS.txt`。构建中间目录与调试配置会在成功打包后自动清理。Release 仅发布 EXE 安装器；不提供 ZIP 便携包。

### macOS DMG（Apple Silicon）

**出正式版本不需要在本地打包**：推一个 `v*` 标签，`.github/workflows/release-mac.yml` 会在 GitHub 的 Apple Silicon runner 上跑 `npm ci` → `npm test` → `npm run package:mac`，然后把 DMG 连同放行说明发成一个 Release。详见[发布手册](RELEASE.md)。下面这条命令用于本地验证或自用。

在 macOS（Apple Silicon）上运行：

```bash
npm run package:mac
```

这一条命令包含三段：`electron-builder --mac --arm64` 出包 → `scripts/finalize-dist-mac.js` 收尾 → `scripts/verify-dist-mac.js` 校验。校验会挂载 DMG，检查里面真正要交付的那个 `.app`（签名是 ad-hoc、entitlements 含 `disable-library-validation`、`CFBundleShortVersionString` 与 `package.json` 一致、sharp 的 `.node` 与 libvips dylib 并列存在），任何一项不过就非零退出。**所以出新版本只需改版本号 → `npm test` → `npm run package:mac`，不需要人工逐项核对产物。**

产物是 `dist/WorkMeow-<version>-macOS-arm64.dmg` 和 `SHA256SUMS.txt` 两个文件；中间目录 `dist/mac-arm64/` 会被 finalize 清掉。mac 侧**不生成**自动更新元数据（没有 `latest-mac.yml`、没有 `.blockmap`）——`backend/updater.js` 对任何非 win32 平台直接返回 `unsupported`，写了等于对外宣告一个不能用的更新通道。

`npm run icns:build` 只在**更换图标源图**时需要手动跑一次：`assets/salary-cat.icns` 已随仓库入库，日常打包不碰它。

几个必须知道的限制：

- **仅 arm64。** `build.electronDist` 指向本机 arm64-only 的 `node_modules/electron/dist`，**Intel Mac 装不上**。
- **ad-hoc 签名、未公证。** 本机没有 Apple 开发者证书（`security find-identity -v -p codesigning` → `0 valid identities found`），所以只能 ad-hoc 签名，无法公证。接收者从网络/微信/邮件拿到 DMG 会带 `com.apple.quarantine`，首次启动被 Gatekeeper 拦下，需要按下面「交付给别人时一并说明」放行一次。这是证书问题，不是配置问题。
- 构建期会出现一条告警：`ad-hoc signing with hardenedRuntime enabled requires the com.apple.security.cs.disable-library-validation entitlement`。**这是误报**——它只看 `isHardenedRuntimeEnabledForSigning`，从不读实际解析出的 entitlements 文件。权限确实在，`verify-dist-mac.js` 会用 `codesign -d --entitlements -` 做运行时确认。
- **`dist/` 是两个平台共用的**：任一 finalize 都会删掉对方的产物。实践上不冲突（macOS 上造不出 NSIS 安装器），但要同时留着两个平台的包时，先把一边挪出 `dist/`。
- 首次构建 DMG 会从 `electron-userland/electron-builder-binaries` 下载 `dmgbuild-bundle-arm64-*.tar.gz`（约 23 MB），之后走 `~/Library/Caches/electron-builder` 缓存。网络不通时用 `ELECTRON_BUILDER_BINARIES_MIRROR`（见上面「网络较慢时」）。因为 `.icns` 已入库，`icons` 工具链**不会**被下载。

#### 交付给别人时一并说明

**要求**：Apple Silicon（M1 或更新），macOS 11+。**此包不支持 Intel Mac。**

1. 双击 `.dmg`，把 `WorkMeow.app` 拖进「应用程序」。
2. 双击启动 —— macOS 会拦下，大意是「Apple 无法验证「打工喵」是否包含恶意软件」。
3. 打开「**系统设置 → 隐私与安全性**」，滚到「安全性」一段，找到关于 `WorkMeow` 的那行，点「**仍要打开**」，用触控 ID 或密码认证。
4. 再次启动，在最后的确认框里点「**打开**」。之后每次启动都正常。

**右键→打开这个老办法已失效**：macOS 15 (Sequoia) 及以后，右键→打开不再为未公证 app 提供绕过路径，系统设置是唯一 GUI 路径。按对方系统版本给说明，别假设老手势还在。

终端替代（便捷手段，非主路径；作用是清掉下载隔离标记，所以 Gatekeeper 不再问）：

```bash
xattr -dr com.apple.quarantine /Applications/WorkMeow.app
```

**必须先拖进「应用程序」再启动，不要直接在 DMG 里双击。** 带隔离标记的 app 在原地启动会触发 macOS 的 App Translocation：系统把它映射到一个 `/private/var/folders/.../AppTranslocation/` 下的临时只读路径再运行，而打工喵装 hook 时写的是**自己当前的可执行文件路径** —— 于是 `~/.claude/settings.json` 里会留下一串重启后就失效的临时路径。本机实测过这个现象。已经踩了的话，在设置里重新点一次「接入自检 / 修复」即可改回正确路径。

**明确做不到的**：无公证（每个接收者都要放行一次，**每个新版本也要重新放行一次**）；仅 arm64；Retina 图标偏软（源图只有 512×512）；mac 无自动更新，新版本靠重新给一个 DMG。

#### 从源码启动迁到已安装的 `.app`

源码自启走的是 `~/Library/LaunchAgents/io.github.vista-zhangg.workmeow.plist`，而打包态用的是 Electron 原生登录项（「系统设置 → 通用 → 登录项」）。**换用 `.app` 之后那个 dev plist 不会自动删**，登录时可能两个都起。检查并清掉：

```bash
ls ~/Library/LaunchAgents/ | grep workmeow
rm ~/Library/LaunchAgents/io.github.vista-zhangg.workmeow.plist   # 确认不再用源码自启后
```

## 卸载

先从打工喵托盘选择“卸载已安装的钩子和插件”，或在源码目录运行：

```powershell
npm run uninstall:hooks
```

然后退出打工喵。`~/.workmeow/` 是用户配置与用量历史目录；只有在确认不再需要这些数据时才手动删除。

## 常见问题

### 桌宠没有显示会话

1. 确认至少有一个已接入的 agent（Claude Code / Codex / TRAE / WorkBuddy / opencode）运行过一次；
2. 启动打工喵后新建一个 agent 会话；
3. Claude Code 用户可退出并重新打开打工喵，让 hooks 重新对账；
4. Codex 用户确认 `~/.codex/sessions/` 下存在当前会话的 rollout 文件。
