# WorkMeow 发布手册（Windows EXE / macOS DMG）

这份手册用于发布新版本：Windows x64 的 EXE 安装版，以及 macOS arm64 的 DMG。Release 只提供安装器；源码/npm 部署和 ZIP 免安装运行不属于用户支持的安装方式。目标是只执行一次完整测试和一次本地打包，并让脚本自动完成旧产物清理与校验。

## 固定流程

1. 确认工作区内容属于同一个版本，确定新版本号。
2. 同时更新 `package.json` 与 `package-lock.json` 顶部两处版本号。
3. 运行 `npm test`。
4. 按目标平台跑打包命令：
   - Windows：`npm run package:win` —— 只构建 NSIS EXE，随后清理旧 `dist`、生成 SHA-256，并执行独立产物校验。
   - macOS：`npm run package:mac` —— 只构建 arm64 DMG，随后 `finalize-dist-mac.js` 清理旧 `dist` 并生成 SHA-256，`verify-dist-mac.js` 挂载 DMG 校验里面的 `.app`（ad-hoc 签名、entitlements、版本号、sharp 原生库）。
   - **`dist/` 是两个平台共用的**：任一 finalize 都会删掉对方的产物。要同时留着两个平台的包，先把一边挪出 `dist/`。
5. 确认 `git diff --check` 和 `git status --short`，按明确路径暂存并提交。
6. 先推送当前分支，再创建并推送同版本标签，例如 `v1.5.4`。
7. 本分支已移除全部 GitHub Actions workflow，标签不会触发任何自动构建或自动发布。两个平台的产物都是第 4 步产出的本地文件；需要 Release 的话手动上传 `dist` 里的文件。

本地包的 `latest.yml` 和 `SHA256SUMS.txt` 是自洽的，不要发布后再回下载 Release 覆盖 `dist` —— 那会重复传输约 100 MB 数据，并可能把完整本地文件先截断为下载占位文件。

## 正常产物

完整 Windows 发布后，`dist` 必须只包含以下四个文件：

- `WorkMeow-<version>-Windows-x64.exe`
- `WorkMeow-<version>-Windows-x64.exe.blockmap`
- `latest.yml`
- `SHA256SUMS.txt`

`scripts/finalize-dist.js` 只有在新产物全部存在后才删除旧文件。`scripts/verify-dist.js` 随后检查文件集合、空文件、SHA-256、更新版本、EXE 文件名和大小。也可以单独运行 `npm run verify:dist`。

完整 macOS 发布后，`dist` 必须只包含以下两个文件：

- `WorkMeow-<version>-macOS-arm64.dmg`
- `SHA256SUMS.txt`

**mac 侧没有 `latest.yml`、没有 `.blockmap`**：`build.dmg.writeUpdateInfo` 为 `false`，因为 `backend/updater.js` 对任何非 win32 平台直接返回 `unsupported` —— mac 本就没有自动更新通道，写了等于对外宣告一个不能用的更新通道。中间目录 `dist/mac-arm64/` 会被 finalize 清掉。单独校验用 `npm run verify:dist:mac`。

**DMG 是 ad-hoc 签名、未公证的**（本机没有 Apple 开发者证书），所以每次交付都要一并给出 Gatekeeper 放行说明，见[本地开发与打包手册](LOCAL_DEPLOYMENT.md)里的「交付给别人时一并说明」。而且**每个新版本接收者都要重新放行一次**。DMG 仅支持 Apple Silicon。

## 等待还是故障

- 停在 `building target=nsis` 且存在 `makensis.exe`：正常。等待安装器和 `.blockmap` 完成。
- 出现 `downloading electron` 或下载到 100% 后长时间无活动：检查 `build.electronDist` 是否仍为 `node_modules/electron/dist`。本项目应复用 `npm ci` 已安装的 Electron，不应再次联网下载同一运行时。
- 缺少 `latest.yml` 或 `.exe.blockmap`：检查 `build.publish` 和 GitHub 发布配置，不要绕过 `finalize-dist` 的失败。
- mac 侧卡在 `Timeout awaiting 'request'`：首次构建 DMG 要下载约 23 MB 的 `dmgbuild-bundle-arm64-*.tar.gz`。用 `ELECTRON_BUILDER_BINARIES_MIRROR` 换源重试；成功后缓存在 `~/Library/Caches/electron-builder`，之后不再联网。
- mac 侧那条 `ad-hoc signing with hardenedRuntime enabled requires the com.apple.security.cs.disable-library-validation entitlement` 告警是**误报**，权限确实在，`verify-dist-mac.js` 会做运行时确认。不要为它去建 `build/` 目录 —— 那反而会遮蔽 app-builder-lib 自带的 entitlements 模板。
- 标签与版本号不一致：标签必须严格等于 `v` 加 `package.json` 版本号。已无 CI 做这项校验，推标签前自己核对。

只有在超过十分钟、相关压缩/安装器子进程不存在、CPU 与磁盘均无活动时，才把打包视为卡死。中止前先保留旧 `dist`；发布脚本本身会在新产物齐全后再做换代清理。

## 减少自动化输出

自动化执行时只保留测试最终结论、打包阶段变化和失败日志。Release 成功后只核对资产列表与远端校验结果，无需再回下载大文件。
