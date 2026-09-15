'use strict';

// macOS 的「开机自动启动」。
//
// 为什么不直接用 Electron 的原生 API：
//   app.setLoginItemSettings 在 macOS 上只注册**当前 app bundle 本体**，官方类型
//   定义里 `path` / `args` 明确标注为 win32 only（见 node_modules/electron/
//   electron.d.ts 的 Settings 接口）。开发态是用 node_modules/electron 的可执行
//   文件跑源码，注册过去开机拉起的是一个不带任何参数的 Electron，本项目代码根本
//   不会加载 —— 开关看着生效、实际无效，比灰掉更糟。
//
// 所以按是否打包分两条路：
//   已打包 .app → 原生 setLoginItemSettings({ openAtLogin })，条目进「系统设置 →
//                通用 → 登录项」，用户可以自己看到、自己关掉，行为最标准；
//   开发态源码  → 自己写 LaunchAgent plist，把 [Electron 可执行文件, 项目路径]
//                显式放进 ProgramArguments，RunAtLoad=true。launchd 在登录时会读
//                ~/Library/LaunchAgents，这是 dev 模式唯一可靠的做法。
//
// 只写 ~/Library/LaunchAgents/ 这一个用户目录，不碰 /Library 与系统目录，不需要 sudo。
//
// 路径形如 <home>/Library/LaunchAgents/<appId>.plist。同名 plist 的存在性就是
// 「已开启」的判据；内容与当前可执行文件/项目路径不一致时标为 stale，让上层提示
// 用户重新开关一次（项目挪过位置、node_modules 重装过都会导致 stale）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLIST_SUFFIX = '.plist';

function launchAgentsDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'LaunchAgents');
}

function plistPath(appId, homeDir = os.homedir()) {
  return path.join(launchAgentsDir(homeDir), `${appId}${PLIST_SUFFIX}`);
}

// XML 文本转义。路径里出现 & < > 是完全可能的（用户名、目录名都可能有），
// 不转义会写出一个 launchd 读不了的 plist，而且失败是静默的。
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// LimitLoadToSessionType=Aqua 把它限定在图形登录会话里加载，语义上等价于
// 「登录项」而不是后台守护进程；ProcessType=Interactive 避免 launchd 按后台
// 任务节流。不设 KeepAlive —— 用户主动退出桌宠后不该被自动拉起。
function buildPlist(options = {}) {
  const label = String(options.label || '');
  const programArguments = Array.isArray(options.programArguments) ? options.programArguments : [];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((arg) => `    <string>${escapeXml(arg)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>ProcessType</key>',
    '  <string>Interactive</string>',
    '  <key>LimitLoadToSessionType</key>',
    '  <string>Aqua</string>',
    '</dict>',
    '</plist>',
    '',
  ];
  return lines.join('\n');
}

// 只解析我们自己写出去的那一种 plist —— 与其引一个 plist 解析器，不如把
// ProgramArguments 数组读回来做「是否过期」的判断，够用且没有依赖。
function parseProgramArguments(xml) {
  const text = String(xml || '');
  const key = text.indexOf('<key>ProgramArguments</key>');
  if (key < 0) return null;
  const open = text.indexOf('<array>', key);
  if (open < 0) return null;
  const close = text.indexOf('</array>', open);
  if (close < 0) return null;
  const body = text.slice(open + '<array>'.length, close);
  const out = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(unescapeXml(m[1]));
  return out;
}

function sameArguments(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// tmp → 目标 的替换。和 backend/hook-runtime.js 的 replaceFile 同一个理由：
// 受限沙箱 profile 下 rename 可能抛 EPERM，此时降级为覆盖写，别让「开关自启动」
// 变成打崩主进程的路径。
function replaceFile(tmp, target) {
  try {
    fs.renameSync(tmp, target);
    return;
  } catch (err) {
    const code = err && err.code;
    if (code !== 'EPERM' && code !== 'EACCES') throw err;
  }
  try {
    fs.copyFileSync(tmp, target);
    fs.unlinkSync(tmp);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error(`launch agent is not writable: ${target}`);
  }
}

function writeFileAtomic(target, text) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    try {
      if (fs.readFileSync(target, 'utf8') === text) return false;
    } catch {}
  }
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmp, text, 'utf8');
  replaceFile(tmp, target);
  return true;
}

function programArgumentsFor(execPath, args = []) {
  return [execPath, ...args].map((value) => String(value));
}

// enabled 以 plist 是否存在为准（用户系统里的客观事实），stale 单独报。
function readStatus(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const appId = options.appId;
  const target = plistPath(appId, homeDir);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return { supported: true, enabled: false, stale: false, path: target };
  }
  const expected = programArgumentsFor(options.execPath || process.execPath, options.args);
  const actual = parseProgramArguments(raw);
  return {
    supported: true,
    enabled: true,
    stale: expected.length > 0 && !sameArguments(actual, expected),
    path: target,
  };
}

function enable(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const appId = options.appId;
  if (!appId) return { supported: true, enabled: false, stale: false, error: 'app-id' };
  const target = plistPath(appId, homeDir);
  const text = buildPlist({
    label: appId,
    programArguments: programArgumentsFor(options.execPath || process.execPath, options.args),
  });
  try {
    writeFileAtomic(target, text);
  } catch {
    return { ...readStatus(options), error: 'write' };
  }
  return { ...readStatus(options) };
}

// 关闭时不比对内容，直接删：内容对不上（stale）也必须能删掉。
function disable(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const target = plistPath(options.appId, homeDir);
  try {
    fs.rmSync(target, { force: true });
  } catch {
    return { ...readStatus(options), error: 'write' };
  }
  return { ...readStatus(options) };
}

module.exports = {
  launchAgentsDir,
  plistPath,
  buildPlist,
  parseProgramArguments,
  escapeXml,
  unescapeXml,
  programArgumentsFor,
  readStatus,
  enable,
  disable,
};
