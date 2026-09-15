'use strict';

// Resolve the terminal that owns a hook invocation (original implementation).
//
// Claude Code runs the hook as a child of the `claude` CLI, which is a child of
// the shell, which is a child of the terminal app. We walk parent PIDs up from
// the hook's parent until we hit a known terminal process (or a system root),
// and report that PID + the chain so the app can later focus that window.
//
// Windows walks Win32_Process parents via PowerShell, with an on-disk cache
// because PreToolUse hooks are hot and PowerShell startup is not free. POSIX
// walks `ps` output instead, which is milliseconds rather than seconds, so it
// needs no cache. Used only to power "💬 去回复" focus — purely a convenience
// signal, so every failure path degrades to "unknown" rather than throwing.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { statePath } = require('./paths');

const TERMINALS = new Set([
  'windowsterminal', 'wt', 'cmd', 'powershell', 'pwsh', 'mintty', 'conemu64', 'conemu',
  // editors with integrated terminals
  'code', 'cursor', 'code-insiders',
]);
const SYSTEM_ROOTS = new Set(['explorer', 'wininit', 'winlogon', 'services']);
const EDITORS = { code: 'code', cursor: 'cursor', 'code-insiders': 'code' };

const HEADLESS_RE = /\s(-p|--print)(\s|$)/;

// ---- Windows ----------------------------------------------------------------
//
// One PowerShell invocation walks the whole parent chain and prints
// `pid|name|commandline` per level. That costs ~0.5–1.5s of PowerShell startup,
// which is too much for a PreToolUse hook that fires on every tool call — so we
// cache the resolved chain in ~/.workmeow/pidwalk-cache.json keyed by the start
// pid (the claude CLI process, stable for the life of a session).

const WIN_CACHE = statePath('pidwalk-cache.json');
const WIN_CACHE_TTL = 6 * 60 * 60 * 1000;

function winCacheRead(key) {
  try {
    const all = JSON.parse(fs.readFileSync(WIN_CACHE, 'utf8'));
    const hit = all && all[String(key)];
    if (!hit || Date.now() - hit.at > WIN_CACHE_TTL) return null;
    if (hit.result && hit.result.sourcePid) process.kill(hit.result.sourcePid, 0); // stale if the terminal died
    return hit.result;
  } catch {
    return null;
  }
}

function winCacheWrite(key, result) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(WIN_CACHE, 'utf8')) || {}; } catch {}
    const now = Date.now();
    for (const k of Object.keys(all)) { if (now - (all[k].at || 0) > WIN_CACHE_TTL) delete all[k]; }
    all[String(key)] = { at: now, result };
    fs.mkdirSync(path.dirname(WIN_CACHE), { recursive: true });
    fs.writeFileSync(WIN_CACHE, JSON.stringify(all), 'utf8');
  } catch {}
}

function winWalkChain(startPid, maxDepth) {
  // $PID is reserved in PowerShell; use $cur. CommandLine goes last because it
  // may itself contain '|'.
  const script = [
    '$cur = ' + startPid,
    `for ($i = 0; $i -lt ${maxDepth}; $i++) {`,
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue',
    '  if (-not $p) { break }',
    '  Write-Output ("{0}|{1}|{2}" -f $p.ProcessId, $p.Name, $p.CommandLine)',
    '  if ($p.ParentProcessId -le 0 -or $p.ParentProcessId -eq $cur) { break }',
    '  $cur = $p.ParentProcessId',
    '}',
  ].join('\n');
  const out = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout: 4000, windowsHide: true });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [pid, name, ...rest] = line.split('|');
    return { pid: parseInt(pid, 10), name: String(name || ''), cmd: rest.join('|') };
  }).filter((e) => Number.isFinite(e.pid));
}

function winBase(name) {
  return String(name).toLowerCase().replace(/\.exe$/, '');
}

function resolveWin(startPid, maxDepth, cacheKey) {
  const empty = {
    sourcePid: startPid || null, pidChain: startPid ? [startPid] : [], editor: null,
    headless: false,
  };
  if (!startPid) return empty;
  // The hook's ppid is a transient PowerShell wrapper (different every event),
  // so the cache is keyed by the Claude Code session id instead.
  const cached = cacheKey ? winCacheRead(cacheKey) : null;
  if (cached) return cached;

  let levels;
  try { levels = winWalkChain(startPid, maxDepth); } catch { return empty; }
  if (!levels.length) return empty;

  const chain = [];
  let terminalPid = null;
  let lastGood = null;
  let editor = null;
  let headless = false;
  const HOOK_SHELLS = new Set(['powershell', 'pwsh', 'cmd']);
  for (let i = 0; i < levels.length; i++) {
    const { pid, name, cmd } = levels[i];
    const base = winBase(name);
    // System roots (explorer & co.) own real windows — keep them out of the
    // chain entirely or focus would raise a random Explorer window.
    if (SYSTEM_ROOTS.has(base)) break;
    chain.push(pid);
    if (!editor && EDITORS[base]) editor = EDITORS[base];
    if (!headless && (base === 'claude' || base === 'node') &&
        (base === 'claude' || /claude-code|@anthropic-ai/.test(cmd)) && HEADLESS_RE.test(' ' + cmd)) headless = true;
    // Level 0 is our own transient hook shell wrapper (hookinstall runs the
    // hook via powershell) — never treat it as the user's terminal.
    if (TERMINALS.has(base) && !(i === 0 && HOOK_SHELLS.has(base))) terminalPid = pid; // keep walking: WindowsTerminal sits above cmd/pwsh
    lastGood = pid;
  }
  const result = {
    sourcePid: terminalPid || lastGood || null, pidChain: chain, editor, headless,
  };
  if (cacheKey) winCacheWrite(cacheKey, result);
  return result;
}

// ---- POSIX (macOS) ----------------------------------------------------------
//
// `ps` costs milliseconds, so unlike Windows there is no cache to invalidate.
// One `ps -Ao pid=,ppid=,comm=` snapshot builds the whole parent map; walking it
// is then pure arithmetic, so hot PreToolUse hooks stay cheap.
//
// Two macOS-specific shapes drive the parsing below:
//   * `comm` is a full path (`/Applications/…/MacOS/Electron`), not a basename.
//   * Executable names contain spaces — `Code Helper (Plugin)` — so only the
//     first two whitespace-delimited fields may be split off; the remainder is
//     the name verbatim.

const POSIX_TERMINALS = new Set([
  'terminal', 'iterm2', 'iterm', 'wezterm', 'wezterm-gui', 'ghostty',
  'alacritty', 'kitty', 'hyper', 'warp', 'warpterminal', 'tabby', 'rio',
  // editors with integrated terminals
  'code helper (plugin)', 'code helper', 'code', 'electron',
  'cursor helper (plugin)', 'cursor helper', 'cursor', 'windsurf',
]);

// launchd is every orphan's parent, and the window-server processes own real
// windows — stop before them or "focus" would raise something arbitrary.
const POSIX_SYSTEM_ROOTS = new Set(['launchd', 'loginwindow', 'windowserver']);

// Editor identification keys off the `.app` BUNDLE name, not the executable.
// VS Code ships its main binary as `Electron` and its extension host as
// `Code Helper (Plugin)`, so the executable name alone both misses real editors
// and misattributes any unrelated Electron app that happens to host a session.
// The bundle name ("Visual Studio Code") is unambiguous.
const POSIX_EDITOR_BUNDLES = [
  [/^cursor/, 'cursor'],
  [/^(visual studio )?code/, 'code'],
  [/^windsurf/, 'code'],
];

// Fallback for editors launched outside a bundle (`code` on PATH). Bare
// `electron` is deliberately absent: it identifies no particular editor.
const POSIX_EDITORS = [
  [/^cursor/, 'cursor'],
  [/^code/, 'code'],
  [/^windsurf/, 'code'],
];

// Any macOS GUI application's executable lives inside a bundle at
// `<Name>.app/Contents/MacOS/<exe>`. That structural fact identifies the window
// owner without needing to enumerate every terminal emulator — it covers
// Terminal, iTerm2, Ghostty, WezTerm, VS Code, Cursor, and third-party hosts
// (this machine runs Claude Code under Orca) alike. The name list above stays as
// a fallback for terminals invoked outside a bundle.
const GUI_BUNDLE_RE = /\.app\/Contents\/MacOS\//;

function isGuiApp(comm) {
  return GUI_BUNDLE_RE.test(String(comm || ''));
}

// The owning application's bundle name, e.g. "visual studio code" from
// `/Applications/Visual Studio Code.app/Contents/MacOS/Electron`. Nested helper
// bundles (`…/Code.app/Contents/Frameworks/Code Helper.app/…`) report the
// innermost bundle, which still carries the product name.
function posixBundleName(comm) {
  const matches = String(comm || '').match(/([^/]+)\.app\/Contents\//g);
  if (!matches || !matches.length) return '';
  const last = matches[matches.length - 1];
  return last.slice(0, last.indexOf('.app')).toLowerCase();
}

function posixBase(comm) {
  // Strip the directory part of the full path `comm` reports, then normalise.
  // A trailing " (Plugin)" is kept: it distinguishes VS Code's extension host
  // from the main app, and both are legitimate terminal owners.
  //
  // Login shells are reported with a leading dash (`-zsh`, `-/bin/zsh`), which
  // must come off or the name matches nothing.
  const raw = String(comm || '').trim().replace(/^-/, '');
  const slash = raw.lastIndexOf('/');
  return (slash === -1 ? raw : raw.slice(slash + 1)).toLowerCase();
}

function posixSnapshot() {
  const out = execFileSync('ps', ['-Ao', 'pid=,ppid=,comm='],
    { encoding: 'utf8', timeout: 4000 });
  const byPid = new Map();
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split off exactly pid and ppid; the rest is the name, spaces included.
    const m = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    if (!Number.isFinite(pid)) continue;
    byPid.set(pid, { pid, ppid: Number.isFinite(ppid) ? ppid : 0, name: m[3] });
  }
  return byPid;
}

// `comm` is truncated and argument-free, so headless detection needs the full
// command line. Only fetched for the one pid that looks like a Claude process.
function posixCommandLine(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'args='],
      { encoding: 'utf8', timeout: 2000 }).trim();
  } catch {
    return '';
  }
}

function resolvePosix(startPid, maxDepth, deps = {}) {
  const snapshot = deps.snapshot || posixSnapshot;
  const commandLine = deps.commandLine || posixCommandLine;
  const empty = {
    sourcePid: startPid || null, pidChain: startPid ? [startPid] : [], editor: null,
    headless: false,
  };
  if (!startPid) return empty;

  let byPid;
  try { byPid = snapshot(); } catch { return empty; }
  if (!byPid.size) return empty;

  const chain = [];
  let terminalPid = null;
  let lastGood = null;
  let editor = null;
  let headless = false;
  let cur = startPid;
  const seen = new Set();

  for (let i = 0; i < maxDepth; i++) {
    const proc = byPid.get(cur);
    if (!proc || seen.has(cur)) break;
    seen.add(cur);
    const base = posixBase(proc.name);
    if (POSIX_SYSTEM_ROOTS.has(base)) break;
    chain.push(proc.pid);

    if (!editor) {
      // Prefer the bundle name; fall back to the executable for non-bundled CLIs.
      const bundle = posixBundleName(proc.name);
      const table = bundle ? POSIX_EDITOR_BUNDLES : POSIX_EDITORS;
      const subject = bundle || base;
      for (const [re, id] of table) {
        if (re.test(subject)) { editor = id; break; }
      }
    }
    if (!headless && (base === 'claude' || base === 'node')) {
      const cmd = commandLine(proc.pid);
      if ((base === 'claude' || /claude-code|@anthropic-ai/.test(cmd)) &&
          HEADLESS_RE.test(' ' + cmd)) headless = true;
    }
    // The first GUI bundle we meet is the window owner; keep walking so a helper
    // process loses to the main app above it (Code Helper → Electron, Orca Helper
    // → Orca).
    //
    // Windows needs a level-0 exemption here because its hook wrapper is
    // `powershell`, which is itself in TERMINALS. POSIX needs none: the hook
    // shell is bash/zsh, which is neither a GUI bundle nor a listed terminal, so
    // it can never be mistaken for the user's window.
    if (isGuiApp(proc.name) || POSIX_TERMINALS.has(base)) {
      terminalPid = proc.pid;
    }
    lastGood = proc.pid;
    if (!proc.ppid || proc.ppid === proc.pid) break;
    cur = proc.ppid;
  }

  return {
    sourcePid: terminalPid || lastGood || null, pidChain: chain, editor, headless,
  };
}

// Returns focus fields. `cacheKey` is a stable per-session id so hot hooks skip
// PowerShell while the same session is active; POSIX needs no cache because `ps`
// is cheap, so the key is ignored there.
function resolve(startPid = process.ppid, maxDepth = 10, cacheKey = null, platform = process.platform) {
  return platform === 'win32'
    ? resolveWin(startPid, maxDepth, cacheKey)
    : resolvePosix(startPid, maxDepth);
}

module.exports = {
  resolve,
  // Exposed so tests can drive the POSIX parent walk from a fixed process table
  // instead of whatever happens to be running on the build machine.
  resolvePosix,
  posixBase,
  posixBundleName,
};
