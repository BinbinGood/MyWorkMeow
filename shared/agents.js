'use strict';

// Single source of truth for the AI-coding tools PET can monitor.
//
// Each tool produces sessions in core with a stable `agentId` (the value the
// hook/server stamps on every event). The renderer, tray menu, and event
// routing talk in SHORT KEYS (claude / codex / trae / workbuddy). This module
// is the ONLY place that maps between the two, so adding a tool = adding one
// row here + a hook script + an installer.
//
// `label` is the human tool name; `short` is the compact label used in the
// panel/session row. The product now has one shared pet, so per-agent display
// names do not belong in this table.
//
// UMD-ish: module.exports for Node, window.WorkMeowAgents for the renderer (<script>).

// 产品决定（2026-08-07）：对外只有一只「打工喵」，不再按工具分出独立桌宠。
const AGENTS = {
  claude: {
    id: 'claude-code',          // session agentId stamped by workmeow-hook.js
    label: 'Claude Code',
    short: 'Claude',
  },
  codex: {
    id: 'codex',                // session agentId stamped by codex-watch.js
    label: 'Codex',
    short: 'Codex',
  },
  trae: {
    id: 'trae',                 // session agentId stamped by trae-hook.js
    label: 'TRAE',
    short: 'TRAE',
  },
  workbuddy: {
    id: 'workbuddy',            // session agentId stamped by workbuddy-hook.js
    label: 'WorkBuddy',
    short: 'WorkBuddy',
  },
  opencode: {
    id: 'opencode',             // session agentId stamped by opencode-plugin.js
    label: 'opencode',
    short: 'opencode',
  },
};

const SHORT_KEYS = Object.keys(AGENTS);

// session agentId (e.g. 'claude-code') → short key (e.g. 'claude').
// Unknown / legacy values fall back to 'claude' for backward compatibility.
function shortKey(agentId) {
  if (!agentId) return 'claude';
  for (const k of SHORT_KEYS) {
    if (AGENTS[k].id === agentId) return k;
  }
  return 'claude';
}

// short key → full session agentId.
function agentId(key) {
  return AGENTS[key] ? AGENTS[key].id : 'claude-code';
}

function isKnownAgentId(id) {
  if (!id) return false;
  return SHORT_KEYS.some((k) => AGENTS[k].id === id);
}

function isKnownKey(key) {
  return Object.prototype.hasOwnProperty.call(AGENTS, key);
}

function label(key) {
  return AGENTS[key] ? AGENTS[key].label : (key || 'Claude');
}

function shortLabel(key) {
  return AGENTS[key] ? AGENTS[key].short : (key || 'Claude');
}

const api = {
  AGENTS,
  SHORT_KEYS,
  shortKey,
  agentId,
  isKnownAgentId,
  isKnownKey,
  label,
  shortLabel,
};

// UMD 守卫必须两边都判（照 shared/states.js:16 的写法）。
// 2026-09-16 修：这里原来是裸的 `module.exports = {...}`，渲染进程开着
// sandbox: true（main.js:266/327/376），根本没有 module —— 于是整个文件在第一
// 行 module.exports 处抛 ReferenceError，下面那句 window.WorkMeowAgents 永远
// 执行不到。pet.html 明明加载了它，可 pet.js:1226 的 try/catch 一直在走硬编码
// 的兜底表，谁也没发现。同目录的 states.js / i18n.js / pet-assets.js 都有守卫，
// 只有这个文件漏了。
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.WorkMeowAgents = api;
