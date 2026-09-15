'use strict';

// Electron 运行时前置引导 —— 必须在 require('electron') **之前**执行。
//
// 背景：WorkBuddy / Claude Code 这类 CLI 自己就是「把 Electron 内核当 Node 跑」的
// （hook 也靠这个机制启动），所以它们的进程里带着 ELECTRON_RUN_AS_NODE=1。这个
// 变量会被派生的**任何**子进程继承，于是从这些工具里启动打工喵 —— `npm start`、
// 双击脚本、被工具拉起的终端 —— Electron 会静默降级成纯 Node 模式：
//
//     process.type          === undefined      （正常 Electron 主进程是 'browser'）
//     require('electron')   === '<可执行文件路径字符串>'   而不是 API 对象
//     app                   === undefined
//
// 后果是 main.js 里的 app.setName() 立刻抛异常，electron-updater 的
// app.getVersion() 再补一刀，表现为「启动即崩」且栈信息完全看不懂。
//
// 处理：检测到降级后摘掉该变量、用干净环境重新拉起自己，原进程退出。
//
// 判据为什么是 process.type 而不是 process.versions.electron：
// 被降级时 process.versions.electron 依然是 '43.4.0'（实测），env 里的变量也
// 可能被上层重复设置，只有 process.type 能真正区分两种模式。
//
// 本模块只依赖 child_process，不 require('electron')，所以可以安全地运行在
// 一个已经被降级的进程里。

// 防重启风暴：如果重启后依然被污染（例如上层反复注入），只重启一次就放行，
// 让原始错误照常抛出 —— 排错需要真实栈，而不是无限重启。
const RELAUNCH_FLAG = 'WORKMEOW_RELAUNCHED';

function isRunAsNodeDegraded(proc = process) {
  if (!proc || proc.type === 'browser') return false;
  const env = proc.env || {};
  return env.ELECTRON_RUN_AS_NODE === '1';
}

// 返回 { relaunched, reason }；relaunched 为 true 时调用方应立刻退出当前进程。
// spawnFn 仅用于测试注入。
function bootstrap(proc = process, spawnFn = null) {
  if (!isRunAsNodeDegraded(proc)) return { relaunched: false, reason: 'not-degraded' };
  if ((proc.env || {})[RELAUNCH_FLAG] === '1') {
    return { relaunched: false, reason: 'already-relaunched' };
  }

  const spawn = spawnFn || require('child_process').spawn;
  const env = { ...proc.env, [RELAUNCH_FLAG]: '1' };
  delete env.ELECTRON_RUN_AS_NODE;

  // argv[0] 是 Electron 可执行文件本身，从 argv[1] 起才是应用路径与用户参数。
  const args = Array.isArray(proc.argv) ? proc.argv.slice(1) : [];

  try {
    const child = spawn(proc.execPath, args, { env, detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (err) {
    // 重启失败就继续往下走：让 Electron 抛出它自己的原始错误，比静默退出好排查。
    return { relaunched: false, reason: 'spawn-failed', error: err };
  }
  return { relaunched: true, reason: 'relaunched' };
}

module.exports = { RELAUNCH_FLAG, isRunAsNodeDegraded, bootstrap };
