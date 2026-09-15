<div align="center">
  <img src="assets/salary-cat.png" width="112" alt="月薪喵头像">
  <h1>打工喵（WorkMeow）</h1>
  <p><strong>让一只喵替你盯住所有正在工作的 AI 编程助手。</strong></p>
  <p>实时聚合 Claude Code、Codex、TRAE、WorkBuddy 与 opencode 的状态、提醒、权限请求和 token 用量。</p>

  <p>
    <a href="README.md">简体中文</a> ·
    <a href="README_EN.md">English</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20x64-555" alt="macOS and Windows x64">
    <img src="https://img.shields.io/badge/version-1.7.6-F6A04A" alt="Version 1.7.6">
    <a href="LICENSE"><img src="https://img.shields.io/badge/code%20license-MIT-2EA44F" alt="MIT License"></a>
  </p>
</div>

> [!IMPORTANT]
> **这是 [vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow) 的 macOS 移植分支，在本仓库独立维护。**
>
> 上游原项目仅支持 Windows x64。本分支让它能在 macOS 上运行，范围限定为 **Claude Code 与 WorkBuddy 的状态监控与用量统计**：
>
> - ✅ macOS 上跑源码即可监控 Claude Code（EPT CLI、VS Code 扩展、cc-connect 等客户端都走同一份 `~/.claude/settings.json`，装一次 hook 全覆盖）
> - ✅ WorkBuddy 已在本机做完实测：hook 契约与内核逐字段对齐（离线驱动 5/5 事件全通），用量字段也确实可读（本机实测今日 2152 万 token、累计 2.48 亿）
> - ➖ Codex / TRAE / opencode 未做 mac 适配，代码保持上游原样
> - ➖ 打包发版、自动更新、SSH 远程监控均未做；mac 上请用源码启动
>
> Windows 侧的行为保持与上游一致（命令生成按平台分派，未改动 Windows 分支）。

产品名称和所有对外发布物统一使用 **打工喵（WorkMeow）**。

## 它能做什么

当多个 Agent 同时工作时，频繁切换窗口查看状态很容易打断思路。WorkMeow 把本机上的会话汇聚为一个常驻桌面的小窗口：忙时开工、需要你时举手、结束时提醒，还能在统一面板中查看用量与上下文。

- **一只喵，五个 Agent**：统一监控 Claude Code、Codex、TRAE、WorkBuddy 和 opencode。
- **状态一眼可见**：工作、思考、并行、清理、等待授权、等待回复、完成、出错、摸鱼与睡眠；后台任务或定时唤醒未结束时保持运行，不提前报完成。
- **表情自由定制**：集中查看每个状态的全部 GIF，可新增轮换、替换或移出选中项，也可一键恢复默认。
- **原生权限卡（Claude Code 与 WorkBuddy）**：请求授权或需要你选择（AskUserQuestion）时，直接在桌宠上允许 / 拒绝 / 作答，不必切回终端或 WorkBuddy 窗口。两家共用同一条阻塞式 `PermissionRequest` 通道；「永久允许」只会出现在真能落盘规则的一方（Claude Code）身上。
- **统一用量面板**：聚合 token、缓存读写、上下文窗口、模型、每日趋势与 API 公价折算。
- **托盘按接入的 Agent 展示，不再预设 Codex**：菜单顶部只列**本机实际接入且用过**的 Agent（最多三个，按今日用量排序），每行给出今日 Token · 费用，WorkBuddy 还额外给出**积分**（今日消耗 · 剩余）。Codex 额度块只在检测到 Codex 且额度可用时才出现；一个都没接入时显示一行提示。
- **无需打开 Codex 即可查额度**：装了 Codex 时自动发现桌面 Codex 自带的 CLI；缺失窗口明确显示 `--`，无需手动配置。
- **接入自检与修复**：在设置中核对五个 Agent 的 Hook、插件或只读监听状态，可一键修复或卸载 WorkMeow 接入。
- **一键隐私模式**：右键打工喵通过 ON/OFF 快速切换，也可在设置中控制；隐藏敏感明细但保留必要状态和用量。
- **本地优先**：会话与统计数据留在本机；公共价格由 models.dev 提供，订阅额度由 Codex 自己认证并读取。
- **轻量桌面交互**：拖动、贴边、工作速览、行动中心、系统托盘、开机启动（Windows / macOS）和下班彩蛋。

## 真实状态示例

<table>
  <tr>
    <td align="center"><img src="assets/cat/cat-working.gif" width="132" alt="工作中"><br><strong>工作中</strong><br><sub>工具正在执行</sub></td>
    <td align="center"><img src="assets/cat/cat-thinking.gif" width="132" alt="思考中"><br><strong>思考中</strong><br><sub>模型正在推理</sub></td>
    <td align="center"><img src="assets/cat/cat-juggling.gif" width="132" alt="并行任务"><br><strong>并行任务</strong><br><sub>多条任务同时进行</sub></td>
    <td align="center"><img src="assets/cat/cat-waiting.gif" width="132" alt="等待授权"><br><strong>等待授权</strong><br><sub>需要你的决定</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cat/cat-happy.gif" width="132" alt="任务完成"><br><strong>任务完成</strong><br><sub>一轮工作已结束</sub></td>
    <td align="center"><img src="assets/cat/cat-error.gif" width="132" alt="执行出错"><br><strong>执行出错</strong><br><sub>会话需要关注</sub></td>
    <td align="center"><img src="assets/cat/cat-loafing.gif" width="132" alt="工具间隙"><br><strong>工具间隙</strong><br><sub>等待下一步事件</sub></td>
    <td align="center"><img src="assets/cat/cat-sleeping.gif" width="132" alt="休息中"><br><strong>休息中</strong><br><sub>当前没有活跃任务</sub></td>
  </tr>
</table>

> GIF 素材及以该角色为参考生成的静态头像来自抖音博主 @月薪喵 的原创“月薪喵”形象。相关素材版权不包含在本项目 MIT License 中；完整来源与版权说明见 [素材署名](assets/cat/CREDITS.md)。

## 自定义状态表情

在任务栏托盘打开“设置”，切换到“喵咪表情”，即可看到工作、反馈和闲时全部状态。选择状态后可以：

- “新增”保留当前表情，把新 GIF 加入随机轮换；
- 在播放列表中选中任意默认或自定义 GIF 后，可单独替换或移出；内置文件不会删除，自定义原始文件也不受影响；
- 每个状态至少保留一个表情；“恢复默认”会撤销该状态的全部调整。

导入流程会把 GIF 统一适配为桌宠使用的 120 × 120 画布，并尽量移除与主体分离的纯色背景。透明背景会原样保留；复杂背景不会强行抠图，以免破坏主体，设置页会给出提示。支持最大 12 MB、2048 × 2048、180 帧、60 秒的 GIF，每个状态最多保存 20 个自定义表情。

WorkMeow 只把处理后的副本保存在当前用户的 `~/.workmeow/pet-assets`，不会修改或删除原始文件。设置保存后会立即同步到正在显示的桌宠，无需重启。用户自行导入的素材及其使用授权由用户负责。

## 支持矩阵

| Agent | 接入方式 | 是否修改外部配置 | 桌宠内授权 | macOS |
| --- | --- | --- | --- | --- |
| Claude Code | `hook/workmeow-hook.js` 生命周期 hook、transcript、进程信息 | 合并安装/卸载 WorkMeow hook，不覆盖已有 hook | 支持 | ✅ 已实测 |
| Codex | 增量读取本机 rollout JSONL；官方 App Server 订阅额度通知 | 不修改 Codex 配置、不读取凭据文件 | 只读提醒 | ➖ 未适配 |
| TRAE | 读取本机 IDE 日志与进程信息 | 仅在检测到 TRAE 后合并安装 hook | 只读提醒 | ➖ 未适配 |
| WorkBuddy | hook、transcript、用量与 credit 字段 | 仅在检测到 WorkBuddy 后合并安装 hook（含阻塞式 `PermissionRequest`） | 支持（授权 + 选择题） | ✅ 状态 + 用量 + 积分已实测；授权通道桌宠侧已实测 |
| opencode | 官方插件机制、事件与用量文件 | 安装/卸载一个独立插件文件 | 只读提醒 | ➖ 未适配 |

首次启动只接入当前用户已经使用过的工具，不会为未检测到的 Agent 凭空创建配置目录。Codex 始终只读，不安装 hook。

## 安装与运行

### macOS（本分支）

本分支未做打包，请用源码启动：

```bash
git clone https://github.com/BinbinGood/MyWorkMeow.git
cd MyWorkMeow
npm install
npm start          # 脱离终端启动，关掉终端后桌宠继续运行
```

`npm start` 会立刻返回。想停掉桌宠：点菜单栏的猫图标退出，或 `pkill -f "MyWorkMeow/node_modules/electron"`。

启动后在设置里点「接入自检 / 修复」即可把 hook 装进 `~/.claude/settings.json`（**合并写入，不会动你已有的 hook**）。之后在任意 Claude Code 客户端里干活，猫就会跟着变状态。

#### 开机自动启动（macOS）

设置 → 启动设置里的开关，在 macOS 上分两条路，按是否打包自动选择：

- **已打包的 `.app`**：用 Electron 原生的登录项，条目会出现在「系统设置 → 通用 → 登录项」，你可以自己看到、自己关掉。
- **源码启动（开发态）**：写一个 LaunchAgent 到 `~/Library/LaunchAgents/io.github.vista-zhangg.workmeow.plist`，把 `[Electron 可执行文件, 项目路径]` 显式写进 `ProgramArguments`。

开发态必须走第二条路，因为 `app.setLoginItemSettings` 的 `path` / `args` 在 macOS 上**不生效**（Electron 官方类型定义标注为 win32 only）：注册过去开机拉起的是一个不带参数的 Electron，本项目代码根本不会加载 —— 开关看着生效、实际无效，比灰掉更糟。

几个可能问到的点：

- LaunchAgent 不进「登录项」列表，这是正常现象，不影响功能；要确认的话看那个 plist 在不在。
- 修改在下一次登录时生效；条目写进去后**不会**立刻拉起一次。
- 项目挪过位置或重装过 `node_modules` 之后，plist 里记的路径就对不上了，设置页会提示「路径已变化，请关闭后再开启一次」。
- 关闭开关 = 删掉那个 plist，不碰系统目录，也不需要 `sudo`。
- macOS 13+ 走打包态时可能出现「待批准」，需要在系统设置里放行，设置页会明确提示。

### Windows

Windows 侧行为与上游一致，安装包请到[上游 Releases](https://github.com/vista-zhangg/WorkMeow/releases) 下载 `WorkMeow-<version>-Windows-x64.exe`。本分支不发布 Windows 安装包。

### 开发与贡献

源码启动、测试和本地打包命令请参阅[本地开发与打包手册](docs/LOCAL_DEPLOYMENT.md)。

## 开发者命令

开发者使用的 `npm` 命令、回归测试和 EXE 打包流程统一记录在[本地开发与打包手册](docs/LOCAL_DEPLOYMENT.md)中。

## 数据与隐私

- 配置、运行时令牌、价格缓存和用量台账保存在 `~/.workmeow/`。
- Claude Code、Codex、TRAE、WorkBuddy 与 opencode 的会话数据只在本机读取和处理。
- 本地 HTTP 服务只监听 loopback，写接口要求每次运行随机生成的令牌。
- models.dev 同步只下载公开价目表，不上传 transcript、rollout、权限内容或统计数据。
- Codex 额度通过一个长生命周期的 `codex app-server --stdio` 连接读取；WorkMeow 会先用 `account/read` 确认当前账户，再读取额度并监听更新。认证与上游请求均由 Codex 负责；WorkMeow 不读取 `~/.codex/auth.json` 的内容，也不访问 ChatGPT 网页接口。文件认证下，`auth.json` 被替换会触发立即重连；keyring / auto / ephemeral 没有可监听的文件事件，账户切换依赖 App Server 的账户通知、周期性 `account/read` 和定期重建连接收敛。因此界面表示的是 WorkMeow 自己这条 App Server 连接当前可见的账户，不承诺另一进程中的非文件认证切换能被文件 watcher 即时发现。
- 右键打工喵或在设置中开启「隐私模式」只会遮蔽屏幕展示；监控与用量统计继续在本机运行，关闭后未处理事项自动恢复。
- 面板费用是按公开 API 单价折算的估计值，不等同于订阅账单或厂商最终结算。

完整说明见 [隐私与数据边界](docs/PRIVACY.md)。

## 工作原理

```text
Claude hook ─────┐
Codex rollout ───┼──> local server / watcher ──> adapter / core ──> 桌宠 + 详情面板
TRAE 日志 ───────┤                                  └────────────> 统一用量台账
WorkBuddy ───────┤
opencode 插件 ───┘
Codex App Server ───────> 托盘右键菜单（5h / 7d）+ 临界额度气泡
```

主进程负责 watcher 生命周期、托盘和窗口；后端状态机聚合多会话；renderer 只接收收敛后的状态与事件协议。状态词汇和优先级由 [`shared/states.js`](shared/states.js) 统一定义。

## 文档

- [用户使用介绍](docs/介绍.md)
- [本地部署与打包](docs/LOCAL_DEPLOYMENT.md)
- [状态机与渲染规范](STATES.md)
- [隐私与数据边界（中英双语）](docs/PRIVACY.md)
- [贡献指南（中英双语）](CONTRIBUTING.md)
- [安全策略（中英双语）](SECURITY.md)

## 项目来源与许可证

本仓库基于 [LLMPET](https://github.com/myunwang/LLMPET) 二次开发（经 [vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow) 重构），是**三层衍生**关系，逐层署明：

- **原始项目**：[LLMPET](https://github.com/myunwang/LLMPET)
- **直接上游**：[vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow) v1.7.6 —— 在原始项目基础上扩展了多 Agent 接入、用量统计、Windows 桌面交互与工程结构。本仓库的绝大部分代码来自这里。
- **本仓库的改动**：macOS 移植（hook 命令生成、进程链解析、Dock/图标、弹窗样式修复、Electron 启动环境自愈、沙箱下的原子写降级），范围限定为 Claude Code + WorkBuddy 的状态监控与用量统计，并补上 WorkBuddy 用量行的识别修复。详见初始提交说明与后续提交。

上游仓库保留为 `upstream` 远端，可随时对比或拉取更新：

```bash
git remote -v                        # origin = 本仓库，upstream = vista-zhangg/WorkMeow
git fetch upstream                   # 拉取上游更新
git log upstream/main --oneline      # 查看上游进展
```

### 许可证

- 源代码依照 [MIT License](LICENSE) 发布；
- 根目录许可证保留最初的 `Copyright (c) 2026 myunwang`；
- 上游 WorkMeow 与本仓库的修改部分，版权归各自贡献者所有；
- **月薪喵 GIF 及其静态衍生头像的原角色版权归抖音博主 [@月薪喵](https://www.douyin.com/) 所有，不适用本项目的 MIT License** —— 二次分发时请注意这一点。

## 参与贡献

本仓库以自用维护为主。macOS 相关问题欢迎提 issue；如果是与平台无关的通用功能或缺陷，建议直接提到[上游仓库](https://github.com/vista-zhangg/WorkMeow)，受益面更大。

---

<div align="center">
  <sub>macOS port · Local-first · One cat, all your agents.</sub>
</div>
