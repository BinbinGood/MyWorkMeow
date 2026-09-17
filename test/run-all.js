'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS = Object.freeze([
  'smoke.js',
  'state-smoke.js',
  'pricing.js',
  'pricing-sync.js',
  'metering-common.js',
  'metering.js',
  'codex-metering.js',
  'codex-rate-limits.js',
  'codex-quota-estimate.js',
  'workbuddy-metering.js',
  'workbuddy-titles.js',
  'workbuddy-compact-watch.js',
  'credit-cycle.js',
  'tray-status.js',
  'trae-metering.js',
  'opencode-metering.js',
  'usage-stats.js',
  'source-registry.js',
  'integration-health.js',
  'privacy-mode.js',
  'workmeow-migration.js',
  'config-external-write.js',
  'portable-runtime.js',
  'mac-login-item.js',
  'electron-bootstrap.js',
  'integration-detection.js',
  'pidwalk-posix.js',
  'ipc-contract.js',
  'auto-launch.js',
  'updater.js',
  'dist-verifier.js',
  'xiaban-schedule.js',
  'pet-assets.js',
  'settings-assets.js',
  'focus.js',
  'deadcode.js',
  'codex-watch.js',
  'codex-integration.js',
  'i18n.js',
  'pet-geometry.js',
  'pet-edge-cycle.js',
  'pet-insights.js',
  'chip-display.js',
  'popup-style.js',
  'branding.js',
  'tray-icon.js',
  'opencode-plugin.js',
  'notify-policy.js',
]);

function runAll() {
  // 多个 suite 用 mkdtemp 在 os.tmpdir() 里造自己的沙箱（codex-watch、codex-rate-limits、
  // metering、portable-runtime…），其中几个以 process.exit 结尾、根本没走到清理 ——
  // 跑几次 /tmp 里就堆一片 workmeow-codex-* 之类的空壳（实测 20:41~21:54 那一轮留下 15 个）。
  // 与其逐个 suite 补 try/finally，不如把整次运行的 TMPDIR 指到一个临时根里，跑完删根：
  // 一处生效、覆盖以后的 suite，也不会碰用户真正的 /tmp。
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-suite-'));
  const env = { ...process.env, TMPDIR: tmpRoot, TMP: tmpRoot, TEMP: tmpRoot };
  try {
    for (const file of TESTS) {
      const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
        env,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
    }
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  console.log(`\nWorkMeow: ${TESTS.length} test suites passed`);
}

if (require.main === module) runAll();

module.exports = { TESTS, runAll };
