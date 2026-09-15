'use strict';

// Regression test for backend/mac-login-item.js —— macOS 开发态的「开机自动启动」。
//
// 全部在临时 HOME 下操作，绝不碰真实的 ~/Library/LaunchAgents：这条路径一旦写错
// 就会影响用户的登录行为，测试里必须隔离。
//
// 背景：Electron 在 macOS 上不接受 setLoginItemSettings 的 path/args（官方类型
// 定义标注为 win32 only），开发态只能自己写 LaunchAgent plist。这个测试锁住
// plist 的形状、XML 转义、过期检测与幂等删除。

const fs = require('fs');
const os = require('os');
const path = require('path');

const mac = require('../backend/mac-login-item');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-login-'));
  const appId = 'io.github.vista-zhangg.workmeow';
  const execPath = process.execPath;
  const args = [path.resolve(__dirname, '..')];

  assert(mac.launchAgentsDir(home) === path.join(home, 'Library', 'LaunchAgents'),
    'launchAgentsDir points at ~/Library/LaunchAgents');
  assert(mac.plistPath(appId, home).endsWith(`${appId}.plist`), 'plistPath is <appId>.plist');

  // 默认（没写过）必须是「支持但关闭」，而不是不支持 —— 这正是修掉的那个 bug：
  // 旧实现把 macOS 判成 unsupported，设置里的开关永远灰着。
  const off = mac.readStatus({ homeDir: home, appId, execPath, args });
  assert(off.supported === true && off.enabled === false && off.stale === false,
    'macOS reports supported:true / enabled:false before the first enable');

  const on = mac.enable({ homeDir: home, appId, execPath, args });
  assert(on.enabled === true && on.stale === false && !on.error, 'enable turns the plist on');
  const target = mac.plistPath(appId, home);
  assert(fs.existsSync(target), 'enable writes the plist');

  const xml = fs.readFileSync(target, 'utf8');
  assert(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'plist has an XML declaration');
  assert(xml.includes('<key>RunAtLoad</key>\n  <true/>'), 'plist sets RunAtLoad');
  assert(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/.test(xml),
    'plist marks the job Interactive so launchd does not throttle it');
  assert(/<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/.test(xml),
    'plist is limited to the GUI (Aqua) session, i.e. behaves like a login item');
  assert(!xml.includes('KeepAlive'), 'plist must not resurrect the app after the user quits it');
  assert(xml.includes(`<string>${appId}</string>`), 'plist carries the label');

  // ProgramArguments 必须原样带上「可执行文件 + 项目路径」。开发态用
  // node_modules/electron 的可执行文件跑源码，少了第二个参数开机拉起的就是空
  // Electron —— 这正是不能直接用原生 API 的原因。
  const parsed = mac.parseProgramArguments(xml);
  assert(Array.isArray(parsed) && parsed.length === 2, 'ProgramArguments has exactly two entries');
  assert(parsed[0] === execPath, 'ProgramArguments[0] is the Electron executable');
  assert(parsed[1] === args[0], 'ProgramArguments[1] is the app path');

  // 路径里的 & < > 必须转义，否则 launchd 会读到一个坏 plist，而且是静默失败。
  const weirdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-login-'));
  const weirdExec = '/Applications/Odd & Amp <dir>/Electron';
  const weirdArgs = ['/Users/me/projects & stuff/MyWork"Meow'];
  const weird = mac.enable({ homeDir: weirdHome, appId, execPath: weirdExec, args: weirdArgs });
  assert(weird.enabled === true, 'enable succeeds for paths containing XML-hostile characters');
  const weirdXml = fs.readFileSync(mac.plistPath(appId, weirdHome), 'utf8');
  assert(weirdXml.includes('&amp;') && weirdXml.includes('&lt;dir&gt;'),
    'XML-hostile characters are escaped in the written plist');
  assert(JSON.stringify(mac.parseProgramArguments(weirdXml)) === JSON.stringify([weirdExec, ...weirdArgs]),
    'escaped arguments round-trip back to the original paths');
  assert(mac.parseProgramArguments('<plist></plist>') === null, 'parseProgramArguments returns null without the key');

  assert(mac.escapeXml('<&>"\'') === '&lt;&amp;&gt;&quot;&apos;', 'escapeXml covers the five entities');
  assert(mac.unescapeXml('&lt;&amp;&gt;&quot;&apos;') === '<&>"\'', 'unescapeXml is the inverse');
  assert(mac.programArgumentsFor('/bin/x', undefined).length === 1, 'programArgumentsFor tolerates a missing args list');

  // 过期检测：项目挪过位置 / 重装过 node_modules 之后，plist 里的路径就对不上了。
  // 报 stale（而不是假装没开）才能让设置页提示用户重新开关一次。
  const stale = mac.readStatus({ homeDir: home, appId, execPath: '/moved/Electron', args });
  assert(stale.enabled === true && stale.stale === true, 'a moved executable is reported as stale');
  const fixed = mac.enable({ homeDir: home, appId, execPath: '/moved/Electron', args });
  assert(fixed.enabled === true && fixed.stale === false, 're-enabling rewrites the stale record');

  // 幂等：内容相同不重写
  assert(mac.enable({ homeDir: home, appId, execPath: '/moved/Electron', args }).enabled === true,
    'enable is idempotent');

  const missingId = mac.enable({ homeDir: home, execPath, args });
  assert(missingId.error === 'app-id' && missingId.enabled === false, 'enable without an app id reports app-id');

  const removed = mac.disable({ homeDir: home, appId });
  assert(removed.enabled === false && !fs.existsSync(target), 'disable removes the plist');
  assert(mac.disable({ homeDir: home, appId }).enabled === false, 'disable is idempotent');
  assert(fs.readdirSync(mac.launchAgentsDir(home)).length === 0,
    'no temp files are left behind in LaunchAgents');

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(weirdHome, { recursive: true, force: true });
  console.log('\nMAC LOGIN ITEM TESTS PASSED');
}

main();
