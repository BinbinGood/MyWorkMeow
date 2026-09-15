'use strict';

// Regression test for backend/electron-bootstrap.js.
//
// 背景：WorkBuddy / Claude Code 的 CLI 自己带着 ELECTRON_RUN_AS_NODE=1，该变量
// 被派生的子进程继承后会让 Electron 降级成纯 Node —— require('electron') 变成
// 路径字符串、app 为 undefined，应用启动即崩。这里只测判据与重启决策（真实重启
// 需要 GUI，跑不了），关键是不能误判：正常主进程绝不能被重启。

const assert = require('assert');

const boot = require('../backend/electron-bootstrap');

function fakeProc({ type, env = {}, argv = [], execPath = '/apps/Electron' } = {}) {
  return { type, env, argv, execPath };
}

const calls = [];
function fakeSpawn(cmd, args, options) {
  calls.push({ cmd, args, options });
  return { unref() { calls.push({ unref: true }); } };
}

// 1. 正常 Electron 主进程：process.type === 'browser'，什么都不做。
assert.deepStrictEqual(boot.isRunAsNodeDegraded(fakeProc({ type: 'browser', env: { ELECTRON_RUN_AS_NODE: '1' } })), false,
  'browser process is never treated as degraded (even with the env var set)');
assert.strictEqual(boot.bootstrap(fakeProc({ type: 'browser', env: { ELECTRON_RUN_AS_NODE: '1' } }), fakeSpawn).relaunched, false,
  'browser process is not relaunched');
assert.strictEqual(calls.length, 0, 'no child process spawned for a healthy main process');

// 2. 被降级：process.type 缺失 + ELECTRON_RUN_AS_NODE=1（WorkBuddy 派生场景）。
const degraded = fakeProc({
  type: undefined,
  env: { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' },
  argv: ['/apps/Electron', '/apps/workmeow'],
});
assert.strictEqual(boot.isRunAsNodeDegraded(degraded), true, 'run-as-node degradation is detected');
const result = boot.bootstrap(degraded, fakeSpawn);
assert.strictEqual(result.relaunched, true, 'degraded process relaunches itself');
assert.strictEqual(calls.length, 2, 'spawn + unref called exactly once');
assert.strictEqual(calls[0].cmd, '/apps/Electron', 'relaunch uses the same Electron executable');
assert.deepStrictEqual(calls[0].args, ['/apps/workmeow'], 'relaunch replays argv without argv[0]');
assert.strictEqual(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined,
  'the poison variable is stripped from the child environment');
assert.strictEqual(calls[0].options.env[ boot.RELAUNCH_FLAG ], '1', 'relaunch is flagged to prevent a restart loop');
assert.strictEqual(calls[0].options.env.PATH, '/usr/bin', 'unrelated environment is preserved');
assert.strictEqual(calls[0].options.detached, true, 'child is detached so it survives the dying parent');

// 3. 防重启风暴：带标记再来一次时必须放行（让原始错误照常抛出）。
calls.length = 0;
const twice = boot.bootstrap(fakeProc({
  type: undefined,
  env: { ELECTRON_RUN_AS_NODE: '1', [boot.RELAUNCH_FLAG]: '1' },
  argv: ['/apps/Electron', '.'],
}), fakeSpawn);
assert.strictEqual(twice.relaunched, false, 'a second degraded boot does not relaunch again');
assert.strictEqual(twice.reason, 'already-relaunched');
assert.strictEqual(calls.length, 0, 'no restart storm: no spawn on the flagged boot');

// 4. 普通 node（没有污染变量）不是降级场景，交给正常流程报错。
assert.strictEqual(boot.isRunAsNodeDegraded(fakeProc({ type: undefined, env: {} })), false,
  'plain node without the env var is not relaunched');

// 5. spawn 失败不能把启动流程吞掉：返回原因，让 Electron 抛自己的原始错误。
calls.length = 0;
const failing = boot.bootstrap(fakeProc({
  type: undefined,
  env: { ELECTRON_RUN_AS_NODE: '1' },
  argv: ['/apps/Electron', '.'],
}), () => { throw new Error('EACCES'); });
assert.strictEqual(failing.relaunched, false, 'spawn failure is reported, not swallowed');
assert.strictEqual(failing.reason, 'spawn-failed');

// 6. 模块必须能在被降级的环境里安全加载：全程不加载 electron 包。
// 用 require.cache 判定而不是扫源码 —— 源码注释里也会出现 require('electron') 字样。
assert(!Object.prototype.hasOwnProperty.call(require.cache, require.resolve('electron')),
  'bootstrap must never load the electron module (it resolves to a path string when degraded)');
assert.strictEqual(typeof boot.bootstrap, 'function', 'module exports a usable bootstrap()');

console.log('electron bootstrap checks passed');
