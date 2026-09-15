'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runtime = require('../backend/hook-runtime');

const root = path.join(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-portable-'));

try {
  const electron = require('electron');
  const staged = runtime.stageHookRuntime({
    sourceRoot: root,
    homeDir: home,
    executable: electron,
    runAsNode: true,
  });

  assert.strictEqual(staged.copied.length, runtime.RUNTIME_FILES.length);
  for (const relative of runtime.RUNTIME_FILES) {
    assert(fs.existsSync(path.join(staged.root, ...relative.split('/'))), `staged ${relative}`);
  }

  const manifest = runtime.readHookRuntime(home);
  assert.strictEqual(manifest.executable, path.resolve(electron));
  assert.strictEqual(manifest.runAsNode, true);

  const script = runtime.runtimeHookPath('workmeow-hook.js', home);

  // Both shell dialects are asserted on every host: buildHookCommand takes an
  // explicit platform, so a Mac run still catches a broken PowerShell branch and
  // vice versa. Testing only the host's own branch would let the other rot.
  const win = runtime.buildHookCommand(script, 'SessionStart', manifest, 'win32');
  assert(win.startsWith("$env:ELECTRON_RUN_AS_NODE='1'; & "), 'PowerShell prefix');
  assert(win.includes("'SessionStart'"));

  const posix = runtime.buildHookCommand(script, 'SessionStart', manifest, 'darwin');
  assert(posix.startsWith('ELECTRON_RUN_AS_NODE=1 exec '), 'POSIX prefix');
  assert(posix.includes("'SessionStart'"));
  // No `$env:` / `&` PowerShell-isms may leak into the sh command.
  assert(!posix.includes('$env:'), 'POSIX command must not contain PowerShell env syntax');

  // runAsNode:false drops the prefix entirely rather than exporting an empty var.
  const plain = runtime.buildHookCommand(script, 'Stop',
    { executable: '/usr/bin/node', runAsNode: false }, 'darwin');
  assert(plain.startsWith("exec '/usr/bin/node' "), `unexpected plain command: ${plain}`);

  // Apostrophes are the one character each dialect escapes differently:
  // PowerShell doubles it, POSIX closes-escapes-reopens.
  const nastyExe = "C:\\Apps\\Cat's Home\\打工喵.exe";
  const nastyScript = "C:\\Users\\O'Brien\\hook.js";
  const quoted = runtime.buildHookCommand(nastyScript, 'Stop',
    { executable: nastyExe, runAsNode: true }, 'win32');
  assert(quoted.includes("Cat''s Home"), 'PowerShell executable path must escape apostrophes');
  assert(quoted.includes("O''Brien"), 'PowerShell script path must escape apostrophes');

  const quotedPosix = runtime.buildHookCommand("/tmp/O'Brien/hook.js", 'Stop',
    { executable: "/Apps/Cat's Home/打工喵", runAsNode: true }, 'darwin');
  assert(quotedPosix.includes("Cat'\\''s Home"), 'POSIX executable path must escape apostrophes');
  assert(quotedPosix.includes("O'\\''Brien"), 'POSIX script path must escape apostrophes');
  // The real test of the escaping: hand it to a shell and check the argv it
  // rebuilds matches the paths we asked for, spaces and quotes intact.
  if (process.platform !== 'win32') {
    const echoed = spawnSync('/bin/sh', ['-c',
      runtime.buildHookCommand("/tmp/O'Brien/hook.js", 'Stop',
        { executable: '/bin/echo', runAsNode: false }, 'darwin')],
      { encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(echoed.status, 0, echoed.stderr || 'sh rejected the quoted command');
    assert.strictEqual(echoed.stdout.trim(), "/tmp/O'Brien/hook.js Stop");
  }

  // Load the complete deployed dependency graph through Electron's built-in
  // Node mode. An unknown event exits immediately after all modules load.
  const probe = spawnSync(electron, [script, 'PortableRuntimeProbe'], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  assert.strictEqual(probe.status, 0, probe.stderr || probe.error || 'Electron Node-mode hook probe failed');

  const unchanged = runtime.stageHookRuntime({
    sourceRoot: root,
    homeDir: home,
    executable: electron,
    runAsNode: true,
  });
  assert.deepStrictEqual(unchanged.copied, [], 'unchanged hook payload should not be rewritten');

  // 受限沙箱会让 rename 直接抛 EPERM（GUI 进程继承沙箱 profile 时实测就是这样，
  // 用户看到的启动崩溃即出自这里）。降级路径必须仍把载荷写进去。
  const denyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-denyrename-'));
  const eioHome = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-eio-'));
  const realRename = fs.renameSync;
  const deny = (code) => () => { const e = new Error(`${code}: operation not permitted`); e.code = code; throw e; };
  try {
    fs.renameSync = deny('EPERM');
    const degraded = runtime.stageHookRuntime({
      sourceRoot: root, homeDir: denyHome, executable: electron, runAsNode: true,
    });
    assert.strictEqual(degraded.copied.length, runtime.RUNTIME_FILES.length,
      'rename-denied staging still writes every payload file');
    for (const relative of runtime.RUNTIME_FILES) {
      assert(fs.existsSync(path.join(degraded.root, ...relative.split('/'))), `degraded staged ${relative}`);
    }
    const denieManifest = runtime.readHookRuntime(denyHome);
    assert(denieManifest && denieManifest.executable === path.resolve(electron),
      'runtime manifest survives a denied rename');
    const leftovers = fs.readdirSync(path.join(degraded.root, 'hook')).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'degraded staging leaves no .tmp litter behind');

    // 只有 EPERM/EACCES 才降级：其它错误码必须照旧抛出，不能被掩盖。
    fs.renameSync = deny('EIO');
    assert.throws(() => runtime.stageHookRuntime({
      sourceRoot: root, homeDir: eioHome, executable: electron, runAsNode: true,
    }), /EIO/, 'non-permission rename errors still propagate');
  } finally {
    fs.renameSync = realRename;
    fs.rmSync(denyHome, { recursive: true, force: true });
    fs.rmSync(eioHome, { recursive: true, force: true });
  }

  assert.strictEqual(runtime.removeHookRuntime(home), true);
  assert.strictEqual(fs.existsSync(runtime.runtimeDir(home)), false);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('portable hook runtime checks passed');
