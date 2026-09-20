'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
  RELEASES_URL,
  MAC_RELEASES_URL,
  MAC_LATEST_API,
  detectDistribution,
  errorMessage,
  compareVersions,
  pickMacAsset,
  createUpdateService,
} = require('../backend/updater');

class FakeUpdater extends EventEmitter {
  constructor(result = 'available') {
    super();
    this.result = result;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
  }

  async checkForUpdates() {
    this.checks += 1;
    this.emit('checking-for-update');
    if (this.result === 'error') throw new Error('network ETIMEDOUT');
    if (this.result === 'available') this.emit('update-available', { version: '1.6.0' });
    else this.emit('update-not-available', { version: '1.5.3' });
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit('download-progress', { percent: 42.4 });
    this.emit('update-downloaded', { version: '1.6.0' });
  }

  quitAndInstall(isSilent, forceRunAfter) {
    this.installs += 1;
    this.installArgs = [isSilent, forceRunAfter];
  }
}

function app(packaged = true) {
  return { isPackaged: packaged, getVersion: () => '1.5.3' };
}

function config(autoUpdateEnabled) {
  return {
    value: { autoUpdateEnabled },
    get() { return { ...this.value }; },
    save(patch) { this.value = { ...this.value, ...patch }; return { ...this.value }; },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function run() {
  assert.strictEqual(detectDistribution(app(false), { platform: 'win32' }), 'development');
  // mac 打包态是「能查不能自动装」，单独一种 mode；开发态在任何平台都先判成 development
  // （以前 darwin 一律返回 unsupported，于是安装好的正式版也被显示成「开发模式」）。
  assert.strictEqual(detectDistribution(app(), { platform: 'darwin' }), 'mac');
  assert.strictEqual(detectDistribution(app(false), { platform: 'darwin' }), 'development');
  assert.strictEqual(detectDistribution(app(), { platform: 'linux' }), 'unsupported');
  assert.strictEqual(detectDistribution(app(), {
    platform: 'win32', execPath: 'C:\\WorkMeow\\WorkMeow.exe',
    fs: { readdirSync: () => ['WorkMeow.exe', 'Uninstall 打工喵.exe'] }, path: path.win32,
  }), 'installer');
  assert.strictEqual(detectDistribution(app(), {
    platform: 'win32', execPath: 'C:\\WorkMeow\\WorkMeow.exe',
    fs: { readdirSync: () => ['WorkMeow.exe', 'resources'] }, path: path.win32,
  }), 'portable');

  const installedUpdater = new FakeUpdater();
  let readyPrompts = 0;
  const installed = createUpdateService({
    app: app(), updater: installedUpdater, config: config(true), mode: 'installer',
    shell: { openExternal: async () => {} }, onDownloaded: () => { readyPrompts += 1; },
  });
  installed.start(false);
  await installed.check(true);
  await flush();
  assert.strictEqual(installedUpdater.checks, 1, 'installed builds must check the update provider');
  assert.strictEqual(installedUpdater.downloads, 1, 'installed builds must auto-download when enabled');
  assert.strictEqual(installed.snapshot().phase, 'downloaded');
  assert.strictEqual(installed.snapshot().latestVersion, '1.6.0');
  assert.strictEqual(readyPrompts, 1, 'a downloaded update must prompt once');
  assert.strictEqual(installed.install(), true, 'downloaded installer updates must be installable');
  assert.deepStrictEqual(installedUpdater.installArgs, [false, true]);

  const manualUpdater = new FakeUpdater();
  const manualConfig = config(false);
  const manual = createUpdateService({
    app: app(), updater: manualUpdater, config: manualConfig, mode: 'installer',
    shell: { openExternal: async () => {} },
  });
  manual.start(false);
  await manual.check(true);
  await flush();
  assert.strictEqual(manual.snapshot().phase, 'available');
  assert.strictEqual(manualUpdater.downloads, 0, 'disabled auto-check must not start a download');
  assert.strictEqual(manual.install(), false, 'an update cannot install before download completes');
  await manual.download();
  assert.strictEqual(manualUpdater.downloads, 1, 'manual download must remain available');
  assert.strictEqual(manual.snapshot().phase, 'downloaded');
  manual.setAutoCheck(true);
  assert.strictEqual(manualConfig.value.autoUpdateEnabled, true, 'the preference must persist');

  const portableUpdater = new FakeUpdater();
  let openedUrl = null;
  const portable = createUpdateService({
    app: app(), updater: portableUpdater, config: config(true), mode: 'portable',
    shell: { openExternal: async (url) => { openedUrl = url; } },
  });
  portable.start(false);
  await portable.check(true);
  await flush();
  assert.strictEqual(portable.snapshot().phase, 'available');
  assert.strictEqual(portableUpdater.downloads, 0, 'ZIP builds must never auto-download an installer');
  await portable.download();
  assert.strictEqual(portableUpdater.downloads, 0, 'ZIP builds must reject explicit updater downloads too');
  assert.strictEqual(portable.install(), false, 'ZIP builds must never invoke installer replacement');
  assert.strictEqual(await portable.openReleasePage(), true);
  assert.strictEqual(openedUrl, 'https://github.com/vista-zhangg/WorkMeow/releases/tag/v1.6.0');

  // ---- 版本比较：唯一容易踩的坑是预发布段必须按段做数值比较 ----
  assert(compareVersions('1.7.9-mac.1', '1.7.8-mac.2') > 0, '次版本更高就是更新');
  assert(compareVersions('1.7.8-mac.10', '1.7.8-mac.2') > 0,
    'mac.10 必须比 mac.2 新（字符串比较会反过来）');
  assert(compareVersions('1.7.8', '1.7.8-mac.2') > 0, '正式版高于同号预发布版');
  assert(compareVersions('1.7.8-mac.2', '1.7.8-mac.2') === 0);
  assert(compareVersions('v1.7.8-mac.2', '1.7.8-mac.2') === 0, '前导 v 必须被忽略');
  assert(compareVersions('乱七八糟', '1.7.8') === 0, '解析不了就当作同版本，不误报更新');

  const release = {
    tag_name: 'v1.7.8-mac.3',
    assets: [
      { name: 'WorkMeow-1.7.8-mac.3-macOS-arm64.dmg', browser_download_url: 'https://example.com/a.dmg', size: 10 },
      { name: 'source.zip', browser_download_url: 'https://example.com/s.zip', size: 1 },
    ],
  };
  assert.strictEqual(pickMacAsset(release).name, 'WorkMeow-1.7.8-mac.3-macOS-arm64.dmg');
  assert.strictEqual(pickMacAsset({ assets: [{ name: 'source.zip' }] }), null, '只认 DMG');
  assert.strictEqual(pickMacAsset({}), null);

  // ---- macOS：查得到、但绝不下载或替换 ----
  const macUpdater = new FakeUpdater();
  let macOpenedUrl = null;
  const mac = createUpdateService({
    app: { isPackaged: true, getVersion: () => '1.7.8-mac.2' },
    updater: macUpdater, config: config(true), mode: 'mac',
    shell: { openExternal: async (url) => { macOpenedUrl = url; } },
    fetchJson: async (url) => {
      assert.strictEqual(url, MAC_LATEST_API, 'mac 必须查本 fork 的 Release');
      return release;
    },
  });
  assert.strictEqual(mac.snapshot().releaseUrl, MAC_RELEASES_URL,
    'mac 的 Release 页面不能指向上游（上游不发 mac 产物）');
  mac.start(false);
  const macState = await mac.check(true);
  assert.strictEqual(macUpdater.checks, 0, 'mac 不得走 electron-updater');
  assert.strictEqual(macState.supported, true, 'mac 必须能查更新');
  assert.strictEqual(macState.canInstall, false, 'mac 不得声称能自动安装');
  assert.strictEqual(macState.phase, 'available');
  assert.strictEqual(macState.latestVersion, '1.7.8-mac.3');
  await mac.download();
  assert.strictEqual(mac.snapshot().phase, 'available', 'mac 不得进入下载流程');
  assert.strictEqual(mac.install(), false, 'mac 不得调用 installer 替换');
  assert.strictEqual(await mac.openReleasePage(), true);
  assert.strictEqual(macOpenedUrl, 'https://github.com/BinbinGood/MyWorkMeow/releases/tag/v1.7.8-mac.3');

  const macCurrent = createUpdateService({
    app: { isPackaged: true, getVersion: () => '1.7.8-mac.2' },
    config: config(true), mode: 'mac', shell: {},
    fetchJson: async () => ({ tag_name: 'v1.7.8-mac.2', assets: [] }),
  });
  macCurrent.start(false);
  await macCurrent.check(true);
  assert.strictEqual(macCurrent.snapshot().phase, 'up-to-date');
  assert.strictEqual(macCurrent.snapshot().latestVersion, '1.7.8-mac.2');

  const macFailing = createUpdateService({
    app: { isPackaged: true, getVersion: () => '1.7.8-mac.2' },
    config: config(true), mode: 'mac', shell: {},
    fetchJson: async () => { throw new Error('fetch failed'); },
  });
  macFailing.start(false);
  await macFailing.check(true);
  assert.strictEqual(macFailing.snapshot().phase, 'error');
  assert.match(macFailing.snapshot().error, /网络/);
  assert.match(errorMessage(new Error('HTTP 404 https://api.github.com/...')), /尚未发布/);
  assert.match(errorMessage(new Error('API rate limit exceeded')), /过于频繁/);
  assert.match(errorMessage(new Error('The operation was aborted due to timeout')), /网络/);

  // 真正不支持的平台（既非 win 也非 mac）：开关和检查按钮都要保持禁用。
  const unsupported = createUpdateService({
    app: app(), updater: new FakeUpdater(), config: config(true), mode: 'unsupported', shell: {},
  });
  unsupported.start(false);
  await unsupported.check(true);
  assert.strictEqual(unsupported.snapshot().supported, false);
  assert.strictEqual(unsupported.snapshot().phase, 'unsupported');

  const latestUpdater = new FakeUpdater('latest');
  const latest = createUpdateService({
    app: app(), updater: latestUpdater, config: config(true), mode: 'installer', shell: {},
  });
  latest.start(false);
  await latest.check(true);
  assert.strictEqual(latest.snapshot().phase, 'up-to-date');
  assert.strictEqual(latest.snapshot().latestVersion, '1.5.3');

  const failingUpdater = new FakeUpdater('error');
  const failing = createUpdateService({
    app: app(), updater: failingUpdater, config: config(true), mode: 'installer', shell: {},
  });
  failing.start(false);
  await failing.check(true);
  assert.strictEqual(failing.snapshot().phase, 'error');
  assert.match(failing.snapshot().error, /网络/);
  assert.match(errorMessage(new Error('404 latest.yml')), /尚未发布/);
  assert.strictEqual(RELEASES_URL, 'https://github.com/vista-zhangg/WorkMeow/releases/latest');

  const root = path.join(__dirname, '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  const pkg = require('../package.json');
  const finalize = read('scripts/finalize-dist.js');
  const settings = read('renderer/settings.html');
  const preload = read('preload.js');
  assert(pkg.dependencies['electron-updater'], 'electron-updater must ship with the application');
  assert.strictEqual(pkg.build.electronDist, 'node_modules/electron/dist',
    'packaging must reuse the Electron runtime already installed by npm');
  assert.deepStrictEqual(pkg.build.win.target, ['nsis'],
    'new releases must expose the NSIS EXE installer only');
  assert.strictEqual(pkg.scripts['package:portable'], undefined,
    'portable ZIP packaging must be retired from the public release flow');
  assert(/--win nsis(?:\s|$)/.test(pkg.scripts['package:win']),
    'Windows packaging must target NSIS explicitly');
  assert.strictEqual(pkg.build.publish[0].provider, 'github');
  assert.strictEqual(pkg.build.publish[0].owner, 'vista-zhangg');
  // 本分支已删掉 .github/workflows/release.yml（无 CI）。原来这里还断言 workflow
  // 会上传 latest.yml / .exe.blockmap 且不上传已退役的 ZIP —— 那份契约现在由下面
  // 的 finalize-dist 断言独自承担：产物齐不齐由本地打包脚本负责，上传是手动的。
  assert(finalize.includes("'latest.yml'") && finalize.includes('`${prefix}.exe.blockmap`')
    && !finalize.includes('.zip'),
    'distribution finalization must retain updater metadata without a portable ZIP');
  assert(settings.includes('id="auto-update-toggle"') && settings.includes('id="update-check"'),
    'settings must expose the preference and manual check');
  for (const api of ['getUpdateState', 'checkForUpdates', 'setAutoUpdate', 'downloadUpdate', 'installUpdate', 'openUpdatePage']) {
    assert(preload.includes(`${api}:`), `preload must expose ${api}`);
  }

  console.log('update service and release contract checks passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
