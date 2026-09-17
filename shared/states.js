'use strict';

// Single source of truth for the pet state vocabulary.
//
// Required by the main process (backend/core.js), loaded as a <script> by the
// renderer (renderer/pet.html → window.WorkMeowStates), and imported by the
// state-machine test. Keeping ONE copy ends the historical drift where five
// separate lists disagreed — e.g. the test's hand-copy silently missed
// 'loafing', blinding the class-leak assertion to that state.
//
// UMD shim: module.exports for Node require(), window.WorkMeowStates for the browser
// <script> and the vm-sandboxed test.

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowStates = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  // Backend aggregation priority — highest wins for the global mood across
  // multiple sessions.
  const STATE_PRIORITY = {
    error: 8,
    notification: 7,
    sweeping: 6,
    attention: 5,
    carrying: 4,
    juggling: 4,
    working: 3,
    thinking: 2,
    idle: 1,
    sleeping: 0,
  };

  // Oneshot states decay back to idle after their TTL if no further event lands
  // (notification is excluded — it means "waiting for you" and must persist).
  const ONESHOT_STATES = ['attention', 'error', 'sweeping', 'notification', 'carrying'];
  const ONESHOT_TTL_MS = { attention: 15000, carrying: 15000, sweeping: 20000, error: 45000 };

  // 上面 sweeping 的 20s 是按 `/clear` 那种瞬时清理量的。压缩上下文（PreCompact）
  // 是长操作，动辄一两分钟，用 20s 会压缩没完就衰减 —— 有后台任务时还会被
  // core.js 的衰减分支变成 working，正是「压缩时显示干活中」的成因之一。
  // 所以每个 PreCompact 生产者都必须自报这个更长的 TTL：
  // backend/hook-common.js（Claude 系）、backend/codex-watch.js（两处）、
  // backend/workbuddy-compact-watch.js（WorkBuddy —— 它的 PreCompact hook 是死
  // 代码，压缩态改由读会话状态机日志产出，见该文件顶部说明）。
  // hook/opencode-plugin.js 是零依赖的独立插件，只能照抄一份并注明与此对齐。
  const PRE_COMPACT_TTL_MS = 5 * 60 * 1000;

  // Falling-asleep sequence — vocabulary reserved; no producer yet.
  const SLEEP_SEQUENCE = ['yawning', 'dozing', 'collapsing', 'sleeping', 'waking'];

  // Busy = counts toward the stuck-sweep + transcript polling in core.
  const BUSY_STATES = ['working', 'thinking', 'juggling', 'carrying', 'sweeping'];

  // 工具类 hook 事件：一个回合**内部**的步进，不是回合边界。
  // 两处都要用同一份：backend/adapter.js 的摸鱼判定（工具间隙才算摸鱼），以及
  // backend/core.js 的 juggling / sweeping hold（这类事件不许接管这两个状态）。
  // 曾经两边各写一份，正是这个文件开头那段「五份清单互相漂移」的老毛病。
  const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'];

  // Every state the /state route accepts (backend vocabulary).
  const VALID_STATES = Array.from(new Set([...Object.keys(STATE_PRIORITY), ...SLEEP_SEQUENCE]));

  // Renderer-only synthesized states + emotion tints (no backend priority entry).
  const RENDER_EXTRA = [
    'loafing', 'happy', 'waiting', 'needsinput', 'greet', 'talking', 'done',
    'loved', 'sad', 'sorry', 'excited', 'puzzled',
  ];

  // Every class word the renderer may put on the pet element. classList.remove
  // MUST cover this whole set or a stale state class leaks. The class-leak test
  // iterates the SAME list, so cleanup and assertion can't drift apart.
  const RENDER_STATE_WORDS = Array.from(new Set([...VALID_STATES, ...RENDER_EXTRA]));

  function getPriority(state) { return STATE_PRIORITY[state] || 0; }

  return {
    STATE_PRIORITY,
    ONESHOT_STATES,
    ONESHOT_TTL_MS,
    PRE_COMPACT_TTL_MS,
    SLEEP_SEQUENCE,
    BUSY_STATES,
    TOOL_EVENTS,
    VALID_STATES,
    RENDER_EXTRA,
    RENDER_STATE_WORDS,
    getPriority,
  };
});
