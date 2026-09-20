<!--
gh release create --notes-file 读这个文件，内容会放在自动生成的提交列表之前。
每次发版都贴同一份放行说明 —— 包是 ad-hoc 签名、未公证的，没有这段说明，
接收者拿到的就是一个双击打不开的文件。
改这里比改 workflow 安全，所以说明单独成文，不内联在 yml 里。
-->

## 安装（macOS）

**要求：Apple Silicon（M1 或更新），macOS 11+。此包不支持 Intel Mac。**

1. 双击 `.dmg`，把 `WorkMeow.app` **拖进「应用程序」**。
2. 双击启动 —— macOS 会拦下，提示「Apple 无法验证「打工喵」是否包含恶意软件」。
3. 打开「**系统设置 → 隐私与安全性**」，滚到「安全性」一段，找到关于 `WorkMeow` 的那行，点「**仍要打开**」，用触控 ID 或密码认证。
4. 再次启动，在确认框里点「**打开**」。之后每次启动都正常。

> **必须先拖进「应用程序」再启动，不要直接在 DMG 里双击。** 带隔离标记的 app 在原地启动会触发 macOS 的 App Translocation，系统把它映射到一个临时只读路径运行，而打工喵装 hook 时写的是自己当前的可执行文件路径 —— 于是配置里会留下一串重启后失效的临时路径。已经踩了的话，在设置里重新点一次「接入自检 / 修复」即可改回正确路径。

> **右键→打开这个老办法已失效**：macOS 15 (Sequoia) 及以后，右键→打开不再为未公证 app 提供绕过路径，系统设置是唯一 GUI 路径。

终端替代（作用是清掉下载隔离标记，所以 Gatekeeper 不再问）：

```bash
xattr -dr com.apple.quarantine /Applications/WorkMeow.app
```

## 明确的限制

- **未公证**（本项目没有 Apple 开发者证书），所以每个接收者都要放行一次，**每个新版本也要重新放行一次**。这是证书问题，不是配置问题。
- **仅 arm64**，Intel Mac 装不上。
- **mac 无自动更新通道**，新版本靠重新装一个 DMG。
- 校验完整性：下载 `SHA256SUMS.txt` 后 `shasum -c SHA256SUMS.txt`。

完整说明见[本地开发与打包手册](https://github.com/BinbinGood/MyWorkMeow/blob/main/docs/LOCAL_DEPLOYMENT.md)。
