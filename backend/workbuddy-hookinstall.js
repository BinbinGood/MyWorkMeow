'use strict';

// Merge-safe WorkBuddy hook installer.
//
// Writes lifecycle hooks into ~/.workbuddy/settings.json (same `hooks` shape as
// Claude Code). WorkBuddy's hook vocabulary is a SUPERSET of Claude Code's. We
// subscribe to ElicitationResult on top of the shared set because it is
// WorkBuddy's only explicit "the user answered, the wait is over" signal —
// without it the cat keeps asking for a reply until the next tool call happens
// to land.
//
// 2026-09-15 更正：这里原先是 `withPermission: false`，注释还写着「WorkBuddy
// does NOT use the blocking PermissionRequest hook」。**那是错的**，已实测核对到
// 代码级：
//   • cli/dist/codebuddy.js 的 HookEvent 枚举里有 PERMISSION_REQUEST
//     ("PermissionRequest")；executePermissionRequestHooks() 把
//     `{session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input,
//       tool_use_id, permission_suggestions}` POST 出去，再读回
//     `hookSpecificOutput.decision`，只认 behavior 为 allow / deny 的决策。
//   • 触发点在 checkPermission → switch(behavior) 的 `default:` 分支
//     → dispatchPermissionRequestHook()，也就是「权限对话框本来要弹」那一刻。
//     拿到 allow 就 cachePreToolUseResult({allowed:true, modifiedInput: decision.updatedInput})；
//     deny 就 cache {allowed:false, message}；**拿不到决策则原样往下走**，宿主自己弹框。
//     所以它不会劫持掉宿主本来的权限系统，兜底也是安全的。
//   • http 类型 hook 的**响应体**会被解析成 hook output（executeHttpHook 里
//     `el.hookSpecificOutput = eA.hookSpecificOutput`），超时默认 60 秒、单位是秒、
//     可用 hook 上的 `timeout` 字段覆盖 —— 与 Claude Code 走的是同一套协议。
//
// ⚠️ 注意：**官方文档没有列这个事件**。cli/dist/web-ui/docs/cn/cli/hooks.md 的事件表
// 只有 PreToolUse / PostToolUse / Notification / UserPromptSubmit / Stop / SubagentStop /
// PreCompact / SessionStart / SessionEnd；permissions.md 的「用 Hooks 扩展权限」一节
// 只讲 PreToolUse。也就是说这是「内核实现里有、文档没写」的内部事件 —— 上面的证据
// 全部来自读 codebuddy.js，因此**可能在 WorkBuddy 升级中被调整**。要换成有文档背书的
// 方案只能走 PreToolUse（但那条在权限判断**之前**运行，语义不同，需重新设计兜底）。
//
// 结论：WorkBuddy 的授权请求与 AskUserQuestion 都能像 Claude Code 一样在喵上直接
// 选，不需要用户切回 WorkBuddy 窗口。唯一的能力差是 `updatedPermissions`（「始终
// 允许」落盘）它不认（allow 分支只读 updatedInput，全程没读 updatedPermissions），
// 所以那一排按钮对 WorkBuddy 不画 —— 见 main.js 的 onAdded。
//
// 兜底：万一这份安装被 WorkBuddy 的敏感外传审查拦下、或 http 请求超时，hook 不返回
// 决策，WorkBuddy 会照常弹自己的对话框 —— 即退化成今天的行为，不会更差。

const os = require('os');
const path = require('path');
const { createInstaller } = require('./hookinstall-base');
const hookRuntime = require('./hook-runtime');

const SETTINGS_PATH = path.join(os.homedir(), '.workbuddy', 'settings.json');
const HOOK_SCRIPT = hookRuntime.runtimeHookPath('workbuddy-hook.js');
const MARKER = 'workbuddy-hook.js';

const COMMAND_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'Notification', 'Elicitation', 'ElicitationResult',
];

module.exports = createInstaller({
  integrationId: 'workbuddy',
  integrationLabel: 'WorkBuddy',
  detectPath: path.dirname(SETTINGS_PATH),
  settingsPath: SETTINGS_PATH,
  hookScript: HOOK_SCRIPT,
  marker: MARKER,
  events: COMMAND_EVENTS,
  // 阻塞式 PermissionRequest（http hook）—— 见文件头的实测依据。
  withPermission: true,
});

if (require.main === module) {
  const { readRuntimeConfig } = require('./transport');
  if (process.argv.includes('--uninstall')) {
    console.log(module.exports.unregisterHooks({ backup: true }));
  } else {
    hookRuntime.stageHookRuntime();
    const runtime = readRuntimeConfig();
    console.log(module.exports.registerHooks(runtime && runtime.port, runtime && runtime.token));
  }
}
