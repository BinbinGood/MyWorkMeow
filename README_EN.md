<div align="center">
  <img src="assets/salary-cat.png" width="112" alt="WorkMeow salary-cat avatar">
  <h1>WorkMeow</h1>
  <p><strong>One cat keeping an eye on every AI coding agent at work.</strong></p>
  <p>Live status, notifications, permission requests, and unified token usage for Claude Code, Codex, TRAE, WorkBuddy, and opencode.</p>

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
> **This is a macOS port of [vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow), maintained independently in this repository.**
>
> The upstream project supports Windows x64 only. This fork makes it run on macOS, scoped to **status monitoring and token metering for Claude Code and WorkBuddy**:
>
> - ✅ Claude Code monitoring works on macOS from source (EPT CLI, the VS Code extension, cc-connect and friends all read the same `~/.claude/settings.json`, so one hook install covers every client)
> - ✅ WorkBuddy is verified on macOS: the hook contract matches the agent kernel field by field (5/5 events delivered in an offline harness) and the usage fields are readable (248M tokens over 2563 rounds on this machine)
> - ➖ Codex / TRAE / opencode are untouched — no macOS adaptation
> - ➖ No packaging, auto-update, or SSH remote monitoring; run from source on macOS
>
> Windows behavior is unchanged from upstream (command generation branches per platform; the Windows branch was not modified). The application UI is Simplified Chinese.

## What it does

Switching between several agent windows just to check progress is distracting. WorkMeow turns local agent activity into one small desktop companion: it works when your agents work, asks for attention when they need you, celebrates completed turns, and presents usage in one place.

- **One cat, five agents** — Claude Code, Codex, TRAE, WorkBuddy, and opencode.
- **Status at a glance** — working, thinking, parallel tasks, compaction, permission waits, user input, completion, errors, breaks, and sleep; background tasks and scheduled wakeups stay active until they actually clear.
- **Custom expressions** — browse every state GIF, add rotating variants, replace or remove a selected item, or restore defaults.
- **Native permission cards** — allow, deny, or permanently allow supported Claude Code requests from the pet.
- **Unified usage view** — tokens, cache reads and writes, context windows, models, daily trends, and API-price estimates.
- **Check Codex quota without opening Codex** — when Codex is installed, startup automatically discovers the native Codex Desktop CLI. Missing windows stay `--`, with no manual setup required.
- **The tray shows the agents you actually use, not Codex by default** — the top of the menu lists only agents detected on this machine that have produced usage (up to three, ordered by today's tokens), each with today's tokens / rounds; WorkBuddy additionally reports **credits** (today + lifetime). The tray is an overview only — no estimated cost and no context water level. The Codex quota block appears only when Codex is present and its quota is available; with nothing connected the menu shows a single hint line.
- **Integration health and repair** — verify all five agents, then repair or remove WorkMeow-managed integrations from Settings.
- **One-click privacy mode** — right-click the cat to toggle the compact ON/OFF control, or use Settings, while keeping essential state and usage visible.
- **Local-first operation** — conversations and usage stay on the machine; models.dev supplies public pricing while Codex authenticates and reads its own subscription quota.
- **Desktop-friendly controls** — drag, edge snapping, work peek, action center, system tray, auto-start (Windows / macOS), and scheduled break animations.

## Real state examples

<table>
  <tr>
    <td align="center"><img src="assets/cat/cat-working.gif" width="132" alt="Working"><br><strong>Working</strong><br><sub>A tool is running</sub></td>
    <td align="center"><img src="assets/cat/cat-thinking.gif" width="132" alt="Thinking"><br><strong>Thinking</strong><br><sub>The model is reasoning</sub></td>
    <td align="center"><img src="assets/cat/cat-juggling.gif" width="132" alt="Parallel tasks"><br><strong>Parallel</strong><br><sub>Several tasks are active</sub></td>
    <td align="center"><img src="assets/cat/cat-waiting.gif" width="132" alt="Permission required"><br><strong>Permission</strong><br><sub>Your decision is required</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/cat/cat-happy.gif" width="132" alt="Completed"><br><strong>Completed</strong><br><sub>A turn has finished</sub></td>
    <td align="center"><img src="assets/cat/cat-error.gif" width="132" alt="Error"><br><strong>Error</strong><br><sub>A session needs attention</sub></td>
    <td align="center"><img src="assets/cat/cat-loafing.gif" width="132" alt="Between tools"><br><strong>Between tools</strong><br><sub>Waiting for the next event</sub></td>
    <td align="center"><img src="assets/cat/cat-sleeping.gif" width="132" alt="Resting"><br><strong>Resting</strong><br><sub>No active task</sub></td>
  </tr>
</table>

> The GIF artwork and the generated static avatar derived from that character come from the original “月薪喵” series by Douyin creator **@月薪喵**. These assets are not covered by the project’s MIT License. See [asset credits and copyright information](assets/cat/CREDITS.md).

## Custom state expressions

Open Settings from the system tray and select **Cat expressions** to browse every work, feedback, and ambient state. For the selected state you can:

- keep the current expressions and **add a rotating variant**;
- select any built-in or custom GIF in the playlist and replace or remove only that item; built-in files and imported source files are never deleted;
- keep at least one GIF per state, or restore all of the state's built-in defaults at once.

Imports are fitted to WorkMeow's 120 × 120 pet canvas. Transparent backgrounds are preserved, while a detached solid-color border is removed when it can be detected safely. Complex backgrounds are kept to avoid damaging the subject, with a warning shown in Settings. Limits are 12 MB, 2048 × 2048, 180 frames, and 60 seconds per GIF; each state accepts up to 20 custom expressions.

WorkMeow stores only a processed copy under `~/.workmeow/pet-assets` for the current user. It never changes or deletes the source file, and saved expressions update the visible pet immediately without a restart. Users are responsible for the rights to assets they import.

## Support matrix

| Agent | Integration | External configuration | In-pet approval | macOS |
| --- | --- | --- | --- | --- |
| Claude Code | Lifecycle hooks, transcript, and process data | Merge-safe WorkMeow hook install/uninstall | Supported | ✅ Verified |
| Codex | Incremental local rollout JSONL reader; official App Server quota notifications | Does not modify Codex configuration or read credential files | Read-only alerts | ➖ Not ported |
| TRAE | Local IDE logs and process data | Installs a merge-safe hook only when TRAE is detected | Read-only alerts | ➖ Not ported |
| WorkBuddy | Hooks, transcripts, usage and credit fields | Installs a merge-safe hook only when WorkBuddy is detected | Read-only alerts | ✅ Status + usage + credits verified |
| opencode | Official plugin mechanism, events, and usage file | Installs/removes one standalone plugin file | Read-only alerts | ➖ Not ported |

On first launch, WorkMeow only integrates with tools already used by the current account. It does not create configuration folders for undetected agents. Codex is always read-only and requires no hook.

## Install and run

### macOS (this fork)

No packaged build; run from source:

```bash
git clone https://github.com/BinbinGood/MyWorkMeow.git
cd MyWorkMeow
npm install
npm start          # detaches from the terminal — the pet survives closing it
```

`npm start` returns immediately. To stop the pet: quit from the menu-bar cat icon, or `pkill -f "MyWorkMeow/node_modules/electron"`.

Once running, open Settings and hit the integration self-check / repair to install the hook into `~/.claude/settings.json` and `~/.workbuddy/settings.json` (**merged in — your existing hooks are left alone**).

#### Launch at login (macOS)

The Settings → Startup toggle uses one of two paths, chosen automatically:

- **Packaged `.app`** — Electron's native login item, so the entry shows up under System Settings → General → Login Items where you can see and toggle it yourself.
- **From source (development)** — a LaunchAgent written to `~/Library/LaunchAgents/io.github.vista-zhangg.workmeow.plist`, with `[Electron executable, project path]` written explicitly into `ProgramArguments`.

Development has to use the second path because `app.setLoginItemSettings` ignores `path` / `args` on macOS (Electron's type definitions mark them win32-only). Registering through the native API in dev would launch a bare Electron with no arguments — the switch would look enabled while doing nothing, which is worse than being greyed out.

Worth knowing:

- A LaunchAgent does **not** appear in the Login Items list. That is expected and harmless; check that the plist exists instead.
- Changes take effect at the next login, and enabling never launches the app immediately.
- If the project moves or `node_modules` is reinstalled, the recorded path goes stale and Settings says so — toggle it off and on again.
- Disabling simply deletes the plist. Nothing outside `~/Library/LaunchAgents/` is touched and no `sudo` is needed.
- On macOS 13+ the packaged path may report "requires approval", which Settings surfaces explicitly.

### Verified on macOS (2026-09-15)

| Path | Status | Evidence |
| --- | --- | --- |
| Status tracking | ✅ works | WorkBuddy's hook engine lives in the agent kernel (`app.asar.unpacked/cli/dist/codebuddy.js`), not in the Electron shell. All 15 events this fork subscribes to are supported, and every payload field (`session_id`, `transcript_path`, `cwd`, `tool_name`, `prompt`, `notification_type`, `stop_hook_active`) matches. Driven offline with a stub server and real payloads: 5/5 events delivered, state mapping correct. |
| Token usage | ✅ works | WorkBuddy transcript rows are `type:"function_call"` / `type:"message"` — there is **no** `role:"assistant"` row. Usage lives in `providerData.usage` (`inputTokens`, `outputTokens`, `totalTokens`, `inputTokensDetails.cached_tokens`, `outputTokensDetails.reasoning_tokens`). After fixing row detection: 248M tokens / 2563 rounds across 27 sessions on this machine. |
| Credits | ✅ works | The "credits" shown in the WorkBuddy client are `usage.cost.amount`, accumulated per request id into `session_usage.credit_json` (per the kernel's `sqlite-conversation-usage-port.ts`). Transcripts carry the same number as `providerData.rawUsage.credit`, which also has a timestamp — so credits can be bucketed per local day. Machine-checked against the database: 1728.7 vs 1692.5 lifetime, the gap being soft-deleted sessions. |

Two macOS environment traps that look like broken code (both handled in code here):

1. **Inherited `ELECTRON_RUN_AS_NODE=1`** — the WorkBuddy / Claude Code CLIs run the Electron kernel as Node, so every child process inherits the variable and Electron silently degrades to plain Node (`require('electron')` returns a path string, `app` is undefined), crashing on startup. `backend/electron-bootstrap.js` detects this before Electron loads and relaunches with a clean environment; `start-detached.js` strips the variable as well.
2. **Sandboxed `rename` returns EPERM** — under an inherited sandbox profile the tmp+rename atomic write into `~/.workmeow/` is refused. `hook-runtime` now degrades to an overwrite, and hook installation is wrapped so a failure only costs state tracking instead of crashing the pet.

Note that point 2 cannot be disproved with a plain `mv` in a shell: an interactive shell runs through the authorization channel while the GUI child inherits the restricted profile, so the two can legitimately disagree.

### Windows

Windows behavior matches upstream. Download `WorkMeow-<version>-Windows-x64.exe` from [upstream Releases](https://github.com/vista-zhangg/WorkMeow/releases); this fork does not publish Windows installers.

### Development and contribution

Source startup, testing, and local packaging commands are for developers and contributors only; see the [local development and packaging guide](docs/LOCAL_DEPLOYMENT.md).

## Developer commands

Developer `npm` commands, regression tests, and the EXE packaging flow are documented in the [local development and packaging guide](docs/LOCAL_DEPLOYMENT.md).

## Data and privacy

- Configuration, runtime tokens, pricing cache, and usage ledgers live in `~/.workmeow/`.
- Claude Code, Codex, TRAE, WorkBuddy, and opencode session data is read and processed locally.
- The local HTTP service binds to loopback only, and write endpoints require a fresh per-run token.
- models.dev synchronization downloads a public price list only; transcripts, rollouts, permission contents, and usage statistics are not uploaded.
- Codex quota uses one long-lived `codex app-server --stdio` connection. WorkMeow confirms the current account with `account/read` before reading quota and listening for updates. Codex owns authentication and upstream requests; WorkMeow does not read the contents of `~/.codex/auth.json` or call ChatGPT web endpoints. With file auth, replacing `auth.json` triggers an immediate reconnect. Keyring, auto, and ephemeral auth have no watchable file-event contract, so account changes converge through App Server account notifications, periodic `account/read`, and scheduled connection recycling. The UI therefore represents the account visible to WorkMeow's own App Server connection; it does not promise that a non-file auth switch in another process is detected immediately by the file watcher.
- Privacy mode from the cat menu or Settings masks on-screen details only; local monitoring and usage accounting continue, and pending items return when it is disabled.
- Displayed cost is an estimate based on public API prices, not a subscription bill or a provider’s final invoice.

See [Privacy and data boundaries](docs/PRIVACY.md) for the complete bilingual policy.

## How it works

```text
Claude hooks ─────┐
Codex rollouts ───┼──> local server / watchers ──> adapter / core ──> pet + details panel
TRAE logs ────────┤                                      └────────> unified usage ledger
WorkBuddy ────────┤
opencode plugin ──┘
Codex App Server ─────> tray context menu (5h / 7d) + low-quota bubble
```

The main process owns watcher lifecycles, the tray, and windows. The backend state machine aggregates concurrent sessions. Renderers only receive a reduced status and event protocol. State vocabulary and priority are defined once in [`shared/states.js`](shared/states.js).

## Documentation

- [Chinese user guide](docs/介绍.md)
- [Chinese local deployment and packaging guide](docs/LOCAL_DEPLOYMENT.md)
- [State machine and rendering specification](STATES.md)
- [Privacy and data boundaries — bilingual](docs/PRIVACY.md)
- [Contributing guide — bilingual](CONTRIBUTING.md)
- [Security policy — bilingual](SECURITY.md)

## Origin and licensing

This repository is built on [LLMPET](https://github.com/myunwang/LLMPET), reworked through [vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow) — a **three-layer derivative**, credited in full:

- **Original project**: [LLMPET](https://github.com/myunwang/LLMPET)
- **Direct upstream**: [vista-zhangg/WorkMeow](https://github.com/vista-zhangg/WorkMeow) v1.7.6 — extends the original project with multi-agent integrations, unified usage reporting, Windows desktop behavior, and project structure. The vast majority of the code here comes from upstream.
- **What this fork adds**: the macOS port (hook command generation, process-chain resolution, Dock/icon handling, ask-dialog style fixes, Electron startup self-healing, sandbox-tolerant atomic writes), scoped to Claude Code + WorkBuddy status monitoring and token metering, plus the WorkBuddy usage-row detection fix. See the initial commit message and later commits for details.

Upstream is kept as the `upstream` remote, so you can diff or pull at any time:

```bash
git remote -v                        # origin = this fork, upstream = vista-zhangg/WorkMeow
git fetch upstream
git log upstream/main --oneline
```

### License

- Source code is released under the [MIT License](LICENSE).
- The root license retains the original `Copyright (c) 2026 myunwang` notice.
- Modifications by upstream WorkMeow and by this fork remain copyright of their respective contributors.
- **The 月薪喵 GIFs and static derivative avatar retain the original character copyright of Douyin creator @月薪喵 and are NOT covered by the project's MIT License** — keep this in mind when redistributing.

## Contributing

This fork is maintained primarily for personal use. macOS-specific issues are welcome here; platform-independent features and bugs are better filed [upstream](https://github.com/vista-zhangg/WorkMeow), where they benefit more people.

---

<div align="center">
  <sub>macOS port · Local-first · One cat, all your agents.</sub>
</div>
