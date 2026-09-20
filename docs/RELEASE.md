# WorkMeow 发布手册（Windows EXE / macOS DMG）

这份手册用于发布新版本：Windows x64 的 EXE 安装版，以及 macOS arm64 的 DMG。Release 只提供安装器；源码/npm 部署和 ZIP 免安装运行不属于用户支持的安装方式。目标是只执行一次完整测试和一次本地打包，并让脚本自动完成旧产物清理与校验。

## 固定流程

1. 确认工作区内容属于同一个版本，确定新版本号。
2. 同时更新 `package.json` 与 `package-lock.json` 顶部两处版本号。
3. 运行 `npm test`。
4. 按目标平台跑打包命令：
   - Windows：`npm run package:win` —— 只构建 NSIS EXE，随后清理旧 `dist`、生成 SHA-256，并执行独立产物校验。
   - macOS：`npm run package:mac` —— 只构建 arm64 DMG，随后 `finalize-dist-mac.js` 清理旧 `dist`，`verify-dist-mac.js` 挂载 DMG 校验里面的 `.app`（ad-hoc 签名、entitlements、版本号、sharp 原生库）。
   - **`dist/` 是两个平台共用的**：任一 finalize 都会删掉对方的产物。要同时留着两个平台的包，先把一边挪出 `dist/`。
5. 确认 `git diff --check` 和 `git status --short`，按明确路径暂存并提交。
6. 先推送当前分支，再创建并推送同版本标签，例如 `v1.5.4`。
7. **macOS：推标签就够了。** `.github/workflows/release-mac.yml` 在 `v*` 标签上跑 `npm ci` → `npm test` → `npm run package:mac`，然后把 DMG 作为唯一附件创建 Release（说明文案取自 `.github/release-notes-mac.md`；想在 Release 里写本版改了什么，发布后在网页上补一段即可）。所以 mac 侧不需要本地打包，第 4 步的 `package:mac` 只在你想先本地验证时才跑。**Windows：没有自动化**，产物是第 4 步的本地文件，需要 Release 的话手动上传 `dist` 里的文件。

Windows 本地包的 `latest.yml` 和 `SHA256SUMS.txt` 是自洽的，不要发布后再回下载 Release 覆盖 `dist` —— 那会重复传输约 100 MB 数据，并可能把完整本地文件先截断为下载占位文件。

## macOS 自动发版（唯一的 workflow）

```bash
npm version patch          # 同步改 package.json 与 package-lock.json 并打好 v* 标签
git push && git push --tags
```

推上去约十分钟后，Release 页面会出现 `WorkMeow-<version>-macOS-arm64.dmg`，只此一个附件。把 Release 链接发给别人即可，不需要自己传 115 MB 的文件。

关于这条流水线要知道的几件事：

- **只有 `v*` 标签会触发。** 刻意不挂 `on.push.branches` —— 每次提交都打一个 115 MB 的包是纯浪费，构建失败邮件也会多到没人看。发版是主动动作，标签就是那个动作的信号。改 README 错别字不会打包。
- **想验证 workflow 本身**，用 Actions 页面的「Run workflow」（`workflow_dispatch`）：跑完整构建与校验，但**不创建 Release**，产物作为 artifact 留 7 天。不必为了测流水线烧掉一个版本号。
- **坏包到不了 Release。** `npm run package:mac` 里的 `verify-dist-mac.js` 会挂载 DMG 校验 ad-hoc 签名、entitlements、`CFBundleShortVersionString` 与 sharp 原生库，任何一项不过就非零退出，后面的 `gh release create` 根本不执行。
- **`runs-on` 必须是 `macos-latest`**（Apple Silicon）。换成 Intel runner 会静默产出一个本项目不支持的 x64 包。
- **CI 同样没有 Apple 证书**，所以自动打的包依然是 ad-hoc 签名、未公证。**CI 不解决 Gatekeeper 问题**，放行说明每次都要给 —— 这也是它固定写在 `.github/release-notes-mac.md` 里、由 workflow 自动贴进每个 Release 的原因。
- **Release 正文的结构固定为「本次更新 + 折叠的安装说明」**（`test/branding.js` 里有断言钉住顺序）。放行说明每个版本都一样，所以折进 `<details>`；正文第一屏留给这一版的功能点改动。**每次发版只需要重写 `.github/release-notes-mac.md` 的第一节**，安装那段不要动。
- **Windows 侧没有自动化**，`package:win` 仍然只能在 Windows 机器上手动跑。

## 正常产物

完整 Windows 发布后，`dist` 必须只包含以下四个文件：

- `WorkMeow-<version>-Windows-x64.exe`
- `WorkMeow-<version>-Windows-x64.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

`scripts/finalize-dist.js` 只有在新产物全部存在后才删除旧文件。`scripts/verify-dist.js` 随后检查文件集合、空文件、SHA-256、更新版本、EXE 文件名和大小。也可以单独运行 `npm run verify:dist`。

完整 macOS 发布后，`dist` 必须只包含一个文件：

- `WorkMeow-<version>-macOS-arm64.dmg`

**mac 侧没有 `latest.yml`、没有 `.blockmap`、也没有 `SHA256SUMS.txt`**：前两个是因为 `build.dmg.writeUpdateInfo` 为 `false`（mac 不接 electron-updater，只做「查版本 + 引导去下载」，见 `backend/updater.js` 的 mac 分支）；校验和文件是刻意去掉的 —— 它和 DMG 在同一次构建里由同一份字节生成，本地只能抓住那几秒内的磁盘损坏，而 `hdiutil verify` 已经在校验镜像自带的 checksum。中间目录 `dist/mac-arm64/` 会被 finalize 清掉。单独校验用 `npm run verify:dist:mac`。

**DMG 是 ad-hoc 签名、未公证的**（本机没有 Apple 开发者证书），所以每次交付都要一并给出 Gatekeeper 放行说明，见[本地开发与打包手册](LOCAL_DEPLOYMENT.md)里的「交付给别人时一并说明」。而且**每个新版本接收者都要重新放行一次**。DMG 仅支持 Apple Silicon。

## 等待还是故障

- 停在 `building target=nsis` 且存在 `makensis.exe`：正常。等待安装器和 `.blockmap` 完成。
- 出现 `downloading electron` 或下载到 100% 后长时间无活动：检查 `build.electronDist` 是否仍为 `node_modules/electron/dist`。本项目应复用 `npm ci` 已安装的 Electron，不应再次联网下载同一运行时。
- 缺少 `latest.yml` 或 `.exe.blockmap`：检查 `build.publish` 和 GitHub 发布配置，不要绕过 `finalize-dist` 的失败。
- mac 侧卡在 `Timeout awaiting 'request'`：首次构建 DMG 要下载约 23 MB 的 `dmgbuild-bundle-arm64-*.tar.gz`。用 `ELECTRON_BUILDER_BINARIES_MIRROR` 换源重试；成功后缓存在 `~/Library/Caches/electron-builder`，之后不再联网。
- mac 侧那条 `ad-hoc signing with hardenedRuntime enabled requires the com.apple.security.cs.disable-library-validation entitlement` 告警是**误报**，权限确实在，`verify-dist-mac.js` 会做运行时确认。不要为它去建 `build/` 目录 —— 那反而会遮蔽 app-builder-lib 自带的 entitlements 模板。
- 标签与版本号不一致：标签必须严格等于 `v` 加 `package.json` 版本号。mac 的 release workflow 第一步就校验这一项并直接失败（在 `npm ci` 之前，不浪费时间）；Windows 侧没有自动化，推标签前自己核对。

只有在超过十分钟、相关压缩/安装器子进程不存在、CPU 与磁盘均无活动时，才把打包视为卡死。中止前先保留旧 `dist`；发布脚本本身会在新产物齐全后再做换代清理。

## 减少自动化输出

自动化执行时只保留测试最终结论、打包阶段变化和失败日志。Release 成功后只核对资产列表与远端校验结果，无需再回下载大文件。
