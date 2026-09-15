'use strict';

// POSIX parent-chain walk (macOS). The process tables below are transcribed from
// real `ps -Ao pid=,ppid=,comm=` output on a Mac running Claude Code, so the
// fixtures carry the shapes that actually broke earlier drafts: full-path `comm`,
// names containing spaces, and login shells reported with a leading dash.

const assert = require('assert');
const pidwalk = require('../backend/pidwalk');

function table(rows) {
  const byPid = new Map();
  for (const [pid, ppid, name] of rows) byPid.set(pid, { pid, ppid, name });
  return byPid;
}

function walk(rows, startPid, opts = {}) {
  return pidwalk.resolvePosix(startPid, opts.maxDepth || 10, {
    snapshot: () => table(rows),
    commandLine: opts.commandLine || (() => ''),
  });
}

// ---- name normalisation -----------------------------------------------------

assert.strictEqual(pidwalk.posixBase('/Applications/Orca.app/Contents/MacOS/Orca'), 'orca');
// Login shells arrive dash-prefixed in both spellings; both must normalise or
// the name matches nothing and the walk misidentifies the window owner.
assert.strictEqual(pidwalk.posixBase('-zsh'), 'zsh');
assert.strictEqual(pidwalk.posixBase('-/bin/zsh'), 'zsh');
assert.strictEqual(pidwalk.posixBase('/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)'),
  'code helper (plugin)');
assert.strictEqual(pidwalk.posixBase(''), '');
assert.strictEqual(pidwalk.posixBase(undefined), '');

// ---- bundle names -----------------------------------------------------------
//
// Editor identity must come from the .app bundle, not the executable. VS Code
// ships its main binary as `Electron`, so matching the executable would both
// miss VS Code and misattribute every unrelated Electron app.

assert.strictEqual(
  pidwalk.posixBundleName('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'),
  'visual studio code');
// Nested helper bundles report the innermost bundle, which still names the product.
assert.strictEqual(
  pidwalk.posixBundleName('/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'),
  'orca helper');
assert.strictEqual(pidwalk.posixBundleName('/bin/bash'), '', 'non-bundled paths have no bundle name');
assert.strictEqual(pidwalk.posixBundleName(undefined), '');

// ---- VS Code extension client ----------------------------------------------

const VSCODE = [
  [1557, 1500, '/Users/x/.vscode/extensions/anthropic/claude'],
  [1500, 87533, '/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper (Plugin)'],
  [87533, 1, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron'],
  [1, 0, '/sbin/launchd'],
];

const vscode = walk(VSCODE, 1557);
assert.strictEqual(vscode.editor, 'code', 'VS Code host should be reported as the editor');
assert.strictEqual(vscode.sourcePid, 87533,
  'the main app must win over its helper process, so focus raises the window');
assert.deepStrictEqual(vscode.pidChain, [1557, 1500, 87533]);
assert.strictEqual(vscode.headless, false);

// ---- EPT CLI hosted in a third-party GUI app (Orca) -------------------------
//
// Orca is in no terminal name list. It resolves purely from the structural
// `.app/Contents/MacOS/` bundle signature — the reason that check exists.
// Transcribed from a live run on this machine.

const ORCA = [
  [53742, 53503, '/Users/x/.cache/ept/tools/claude'],
  [53503, 52327, 'ept'],
  [52327, 52316, '-/bin/zsh'],
  [52316, 908, '/usr/bin/login'],
  [908, 848, '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'],
  [848, 1, '/Applications/Orca.app/Contents/MacOS/Orca'],
  [1, 0, '/sbin/launchd'],
];

const orca = walk(ORCA, 53742);
assert.strictEqual(orca.sourcePid, 848,
  'an unlisted GUI host must still be found via its .app bundle path, and the '
  + 'main app must outrank its own helper bundle');
assert.strictEqual(orca.editor, null, 'Orca is a host application, not a code editor');

// The regression that motivated bundle-name matching: WorkMeow's own hook runs
// through the Electron binary, and a session hosted by any other Electron app
// looks identical at the executable level. Only the bundle name separates them,
// so neither may be reported as VS Code.
const FOREIGN_ELECTRON = [
  [61000, 61001, '/Users/x/proj/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'],
  [61001, 61002, '/Users/x/.cache/ept/tools/claude'],
  [61002, 1, '/Applications/Orca.app/Contents/MacOS/Orca'],
  [1, 0, '/sbin/launchd'],
];
assert.strictEqual(walk(FOREIGN_ELECTRON, 61000).editor, null,
  'a bare Electron app must not be misreported as VS Code');

// ---- the hook's own shell is never the terminal -----------------------------
//
// Claude Code runs our command through bash, so level 0 is a shell we spawned.
// Reporting it as the window owner would make "go reply" focus nothing. Unlike
// the Windows walker this needs no special-case: a shell is neither a GUI bundle
// nor a listed terminal. Asserted anyway so adding 'bash'/'zsh' to
// POSIX_TERMINALS later fails loudly here instead of silently breaking focus.

const WITH_HOOK_SHELL = [
  [700, 600, '/bin/bash'],
  [600, 500, '/Users/x/.cache/ept/tools/claude'],
  [500, 400, '-zsh'],
  [400, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'],
  [1, 0, '/sbin/launchd'],
];

assert.strictEqual(walk(WITH_HOOK_SHELL, 700).sourcePid, 400,
  'the hook shell must not be reported as the user terminal');
// Reached without the shell level at all — same answer, the terminal above wins.
assert.strictEqual(walk(WITH_HOOK_SHELL, 600).sourcePid, 400);

// ---- system roots bound the walk -------------------------------------------

const ORPHAN = [
  [300, 1, '/Users/x/.cache/ept/tools/claude'],
  [1, 0, '/sbin/launchd'],
];
const orphan = walk(ORPHAN, 300);
assert.strictEqual(orphan.sourcePid, 300, 'no terminal found: fall back to the last real process');
assert.deepStrictEqual(orphan.pidChain, [300], 'launchd must never enter the chain');

// loginwindow owns a real window; focusing it would raise something arbitrary.
assert.deepStrictEqual(
  walk([[10, 20, 'node'], [20, 0, '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow']], 10).pidChain,
  [10],
);

// ---- headless detection -----------------------------------------------------

const HEADLESS = [
  [800, 400, '/Users/x/.cache/ept/tools/claude'],
  [400, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'],
  [1, 0, '/sbin/launchd'],
];
assert.strictEqual(
  walk(HEADLESS, 800, { commandLine: () => 'claude -p "summarise this"' }).headless,
  true,
  '`claude -p` is a headless print run',
);
assert.strictEqual(
  walk(HEADLESS, 800, { commandLine: () => 'claude --print hello' }).headless, true);
assert.strictEqual(
  walk(HEADLESS, 800, { commandLine: () => 'claude' }).headless, false);
// A bare `node` only counts as Claude when its command line proves it.
assert.strictEqual(
  walk([[800, 400, 'node'], [400, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2'], [1, 0, '/sbin/launchd']],
    800, { commandLine: () => 'node /some/other/tool.js -p' }).headless,
  false,
  'an unrelated node process must not be read as headless Claude',
);

// ---- degradation, never throwing -------------------------------------------
//
// pidwalk only powers a convenience "focus the window" button, so every failure
// path must degrade to a usable answer rather than break the hook.

assert.strictEqual(walk(VSCODE, 0).sourcePid, null, 'pid 0 yields the empty result');
assert.strictEqual(walk([], 1557).sourcePid, 1557, 'an empty process table degrades to the start pid');
assert.strictEqual(walk(VSCODE, 999999).sourcePid, null, 'an unknown pid degrades without throwing');
assert.strictEqual(
  pidwalk.resolvePosix(1557, 10, { snapshot: () => { throw new Error('ps unavailable'); } }).sourcePid,
  1557,
  'a failing ps must be swallowed, not propagated into the hook',
);

// A ppid cycle must terminate. Real tables should not contain one, but the walk
// is fed by external state and an infinite loop would hang every hook event.
const CYCLE = [[10, 20, 'node'], [20, 10, 'node']];
assert.deepStrictEqual(walk(CYCLE, 10).pidChain, [10, 20], 'cycles terminate via the seen set');

// maxDepth truncates rather than running away.
assert.deepStrictEqual(walk(VSCODE, 1557, { maxDepth: 2 }).pidChain, [1557, 1500]);

// ---- dispatch ---------------------------------------------------------------
//
// The bug this guards: resolve() originally had no platform branch and called
// the PowerShell walker unconditionally, so on macOS every hook event paid for a
// doomed spawn and reported empty focus fields.

const dispatched = pidwalk.resolve(1, 1, null, 'darwin');
assert(dispatched && typeof dispatched === 'object' && 'sourcePid' in dispatched,
  'darwin must route to the POSIX walker and return focus fields');

console.log('pidwalk POSIX checks passed');
