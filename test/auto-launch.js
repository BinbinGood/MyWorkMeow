'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const channels = fs.readFileSync(path.join(root, 'shared', 'ipc-channels.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(root, 'renderer', 'settings.html'), 'utf8');
const settingsJs = fs.readFileSync(path.join(root, 'renderer', 'settings.js'), 'utf8');
const settingsCss = fs.readFileSync(path.join(root, 'renderer', 'settings.css'), 'utf8');
const i18n = require('../shared/i18n');

assert(/app\.getLoginItemSettings\(autoLaunchMatchOptions\(\)\)/.test(main), 'settings must read the current auto-launch state');
assert(/app\.setLoginItemSettings\(autoLaunchSettings\(desired\)\)/.test(main), 'settings must update the auto-launch state');
assert(/LEGACY_AUTO_LAUNCH_NAMES/.test(main) && /autoLaunchSettings\(false, name\)/.test(main),
  'disabling auto-launch must remove legacy registry entries for the same executable');
assert(/executableWillLaunchAtLogin/.test(main), 'Windows settings must use the executable launch status');
assert(/function openSettings\(\)/.test(main) && /settings\.html/.test(main), 'tray must open the settings window');
assert(/tray\.settings/.test(main), 'tray menu must expose a settings entry');
assert(/GET_AUTO_LAUNCH/.test(channels) && /SET_AUTO_LAUNCH/.test(channels), 'settings must have dedicated IPC channels');
assert(/getAutoLaunch:/.test(preload) && /setAutoLaunch:/.test(preload), 'preload must expose auto-launch settings APIs');
assert(/role="switch"/.test(settingsHtml) && /auto-launch-toggle/.test(settingsJs), 'settings UI must provide an accessible toggle');
assert(/linear-gradient\(165deg/.test(settingsCss) && /border-radius: 18px/.test(settingsCss), 'settings UI must retain the glass panel style');
assert.strictEqual(i18n.DICT.zh['tray.settings'], '设置');
assert.strictEqual(i18n.DICT.zh['settings.autoLaunchTitle'], '开机自动启动');

// ── macOS ─────────────────────────────────────────────────────────────────────
// macOS 上曾经因为 `process.platform === 'win32'` 这个硬条件被判成不支持，设置里
// 的开关永远是灰的。修法是：打包态（原生 .app）走 Electron 的登录项，开发态走
// LaunchAgent —— 因为原生 API 在 macOS 上不接受 path/args（electron.d.ts 里
// 标注 win32 only），开发态注册过去开机拉起的是个不带参数的 Electron。
assert(/require\('\.\/backend\/mac-login-item'\)/.test(main), 'main must use the macOS login-item helper');
assert(/process\.platform === 'darwin'\) return true/.test(main),
  'macOS must report auto-launch as supported');
assert(/macAutoLaunchNative/.test(main) && /app\.isPackaged === true/.test(main),
  'macOS must switch to the native login item only for packaged builds');
assert(/macLoginItem\.enable\(\{/.test(main) && /macLoginItem\.disable\(\{/.test(main),
  'the development path must go through the LaunchAgent helper');
assert(/app\.getLoginItemSettings\(\)/.test(main) && /app\.setLoginItemSettings\(\{ openAtLogin: desired \}\)/.test(main),
  'the packaged macOS path must read/write the native login item');
assert(/requires-approval/.test(main) && /requires-approval/.test(settingsJs),
  'macOS 13+ approval state must be surfaced instead of looking like a save failure');
assert(/'settings\.autoLaunchStale'/.test(settingsJs), 'a stale login item must explain itself');
assert(!/登录 Windows 后自动运行/.test(settingsHtml) && !/下次登录 Windows 时自动运行/.test(settingsHtml),
  'startup copy must not be Windows-only now that macOS is supported');
assert.strictEqual(i18n.DICT.zh['settings.autoLaunchDescription'], '登录系统后自动运行打工喵');
assert(typeof i18n.DICT.zh['settings.autoLaunchApproval'] === 'string'
  && typeof i18n.DICT.zh['settings.autoLaunchStale'] === 'string',
  'macOS approval/stale hints are present in the dictionary');

console.log('auto-launch checks passed');
