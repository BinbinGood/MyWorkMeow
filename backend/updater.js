'use strict';

const fs = require('fs');
const path = require('path');

const RELEASES_URL = 'https://github.com/vista-zhangg/WorkMeow/releases/latest';
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_START_DELAY_MS = 15 * 1000;

// macOS 走一条独立的通道：electron-updater 的 MacUpdater 依赖 zip 产物 + Squirrel.Mac
// 替换 bundle，而本项目 mac 侧只产 DMG、ad-hoc 签名、未公证（见 docs/LOCAL_DEPLOYMENT.md），
// 三个条件都不满足。所以 mac 只做「查询 + 引导去下载」，不碰 electron-updater，
// 也不再沿用 RELEASES_URL —— 那是 Windows 的更新源（build.publish 指向上游），
// 而上游不发布 mac 产物，指过去等于给用户一个死链。
const MAC_RELEASES_URL = 'https://github.com/BinbinGood/MyWorkMeow/releases/latest';
const MAC_LATEST_API = 'https://api.github.com/repos/BinbinGood/MyWorkMeow/releases/latest';
const MAC_REQUEST_TIMEOUT_MS = 10 * 1000;

function detectDistribution(app, options = {}) {
  const platform = options.platform || process.platform;
  // 开发态（源码运行）在任何平台都不查在线更新，先于平台判断返回，
  // 这样「开发模式」这条 UI 文案才名副其实。
  if (!app || !app.isPackaged) return 'development';
  // 打包态的 mac 是「可以检查、不能自动安装」，单独一种 mode。
  if (platform === 'darwin') return 'mac';
  if (platform !== 'win32') return 'unsupported';
  const fileSystem = options.fs || fs;
  const pathApi = options.path || path;
  const executable = options.execPath || process.execPath;
  try {
    const names = fileSystem.readdirSync(pathApi.dirname(executable));
    // electron-builder NSIS always writes this beside the installed app:
    // "Uninstall ${PRODUCT_FILENAME}.exe". The ZIP build has no uninstaller.
    if (names.some((name) => /^Uninstall .+\.exe$/i.test(name))) return 'installer';
  } catch {}
  return 'portable';
}

function errorMessage(error) {
  const text = String(error && (error.message || error) || '').replace(/\s+/g, ' ').trim();
  if (!text) return '检查更新失败，请稍后重试';
  if (/404|latest\.yml|no published versions/i.test(text)) return '更新信息尚未发布，请稍后重试';
  if (/rate limit|abuse detection/i.test(text)) return '更新服务器请求过于频繁，请稍后重试';
  if (/ENOTFOUND|ETIMEDOUT|ECONN|network|internet|net::|timeout|aborted|fetch failed/i.test(text)) {
    return '无法连接更新服务器，请检查网络后重试';
  }
  return text.slice(0, 180);
}

// 版本比较只覆盖本项目实际会出现的形态：`1.7.8`、`1.7.8-mac.2`、`1.7.9-rc.1`。
// 不引入 semver 依赖 —— 这里唯一容易踩的坑是预发布段必须按段拆开做数值比较，
// 否则 `mac.10` 会被字符串比较判成小于 `mac.2`（第 10 个 mac 版反而看不见更新）。
function parseVersion(text) {
  const match = String(text == null ? '' : text).trim().replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || null };
}

function comparePrerelease(left, right) {
  const a = String(left).split('.');
  const b = String(right).split('.');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const numericA = /^\d+$/.test(a[i]);
    const numericB = /^\d+$/.test(b[i]);
    if (numericA && numericB) {
      if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
    } else if (numericA !== numericB) {
      return numericA ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

// 无法解析时返回 0（当作同一版本），宁可少提示一次，也不要误报一个「新版本」。
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

// 只认 DMG：mac 侧的「更新」就是把新 DMG 拖进「应用程序」，别的资产（源码包、
// 校验文件）对用户没有意义。
function pickMacAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const dmg = assets.find((asset) => /\.dmg$/i.test(String(asset && asset.name || '')));
  if (!dmg) return null;
  return {
    name: String(dmg.name),
    url: String(dmg.browser_download_url || ''),
    size: Number(dmg.size) || 0,
  };
}

async function fetchGitHubJson(url) {
  if (typeof fetch !== 'function') throw new Error('当前运行环境不支持网络请求');
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      // GitHub API 对没有 User-Agent 的请求直接 403。
      'user-agent': 'WorkMeow',
    },
    signal: AbortSignal.timeout(MAC_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url} ${response.statusText || ''}`.trim());
  return response.json();
}

function createUpdateService(options) {
  const app = options.app;
  const updater = options.updater || null;
  const config = options.config;
  const shell = options.shell;
  const setTimer = options.setTimeout || setTimeout;
  const setRepeatingTimer = options.setInterval || setInterval;
  const mode = options.mode || detectDistribution(app, options);
  // 「能不能查」和「能不能自己装」分开：mac 能查不能装，所以 supported 为真、
  // canInstall 为假。UI 的开关和「立即检查」看 supported，下载/安装按钮看 canInstall。
  const canInstall = mode === 'installer' || mode === 'portable';
  const supported = canInstall || mode === 'mac';
  const macCheck = options.fetchJson || fetchGitHubJson;
  const currentVersion = app && typeof app.getVersion === 'function' ? app.getVersion() : '0.0.0';
  const listeners = new Set();
  let started = false;
  let startTimer = null;
  let intervalTimer = null;
  let downloadPromise = null;
  let promptedVersion = null;
  const saved = config && typeof config.get === 'function' ? config.get() : {};

  const state = {
    supported,
    canInstall,
    mode,
    autoCheck: saved.autoUpdateEnabled !== false,
    currentVersion,
    latestVersion: null,
    phase: supported ? 'idle' : mode,
    progress: null,
    checkedAt: null,
    error: null,
    releaseUrl: mode === 'mac' ? MAC_RELEASES_URL : RELEASES_URL,
  };

  function snapshot() { return { ...state }; }
  function publish() {
    const value = snapshot();
    for (const listener of listeners) {
      try { listener(value); } catch {}
    }
    if (typeof options.onState === 'function') {
      try { options.onState(value); } catch {}
    }
    return value;
  }
  function update(patch) { Object.assign(state, patch); return publish(); }

  async function download() {
    if (!canInstall || mode !== 'installer' || !updater) return snapshot();
    if (state.phase === 'downloaded' || state.phase === 'downloading') return snapshot();
    if (!state.latestVersion) return check(true).then(() => snapshot());
    if (downloadPromise) return downloadPromise;
    update({ phase: 'downloading', progress: 0, error: null });
    downloadPromise = Promise.resolve(updater.downloadUpdate())
      .catch((error) => update({ phase: 'error', error: errorMessage(error), progress: null }))
      .finally(() => { downloadPromise = null; });
    await downloadPromise;
    return snapshot();
  }

  // mac：查 GitHub Release，只判断有没有新版并记下 DMG，不下载、不替换。
  async function checkMacRelease() {
    update({ phase: 'checking', progress: null, error: null });
    try {
      const release = await macCheck(MAC_LATEST_API);
      const tag = String(release && (release.tag_name || release.name) || '').replace(/^v/i, '').trim();
      const latestVersion = tag || currentVersion;
      const asset = pickMacAsset(release);
      const patch = {
        latestVersion,
        checkedAt: Date.now(),
        progress: null,
        error: null,
        downloadUrl: asset ? asset.url : null,
        assetName: asset ? asset.name : null,
      };
      // 资产缺失（比如 release 只推了 tag 还没上传 DMG）不影响判定：版本号来自 tag，
      // 「前往下载」打开的是 Release 页面本身，不依赖 assets。
      if (compareVersions(latestVersion, currentVersion) > 0) update({ ...patch, phase: 'available' });
      else update({ ...patch, phase: 'up-to-date' });
    } catch (error) {
      update({ phase: 'error', error: errorMessage(error), checkedAt: Date.now(), progress: null });
    }
    return snapshot();
  }

  async function check(manual = false) {
    if (!supported) return snapshot();
    if (state.phase === 'checking' || state.phase === 'downloading') return snapshot();
    if (mode === 'mac') {
      void manual;
      return checkMacRelease();
    }
    if (!updater) return snapshot();
    update({ phase: 'checking', progress: null, error: null });
    try {
      await updater.checkForUpdates();
    } catch (error) {
      update({ phase: 'error', error: errorMessage(error), checkedAt: Date.now(), progress: null });
    }
    // The updater events are authoritative. `manual` is kept explicit at the
    // API boundary so a future UI can distinguish user and scheduled checks.
    void manual;
    return snapshot();
  }

  function install() {
    if (!canInstall || mode !== 'installer' || !updater || state.phase !== 'downloaded') return false;
    try {
      updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      update({ phase: 'error', error: errorMessage(error) });
      return false;
    }
  }

  async function openReleasePage() {
    if (!shell || typeof shell.openExternal !== 'function') return false;
    const base = mode === 'mac' ? MAC_RELEASES_URL : RELEASES_URL;
    const versionUrl = state.latestVersion
      ? base.replace(/\/latest$/, `/tag/v${encodeURIComponent(state.latestVersion)}`)
      : base;
    try { await shell.openExternal(versionUrl); return true; } catch { return false; }
  }

  function setAutoCheck(enabled) {
    state.autoCheck = !!enabled;
    if (config && typeof config.save === 'function') config.save({ autoUpdateEnabled: state.autoCheck });
    publish();
    if (state.autoCheck && state.phase === 'available' && mode === 'installer') void download();
    return snapshot();
  }

  function bindUpdater() {
    if (!updater || typeof updater.on !== 'function') return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.on('checking-for-update', () => update({ phase: 'checking', error: null, progress: null }));
    updater.on('update-available', (info) => {
      const latestVersion = info && info.version ? String(info.version) : null;
      update({ phase: 'available', latestVersion, checkedAt: Date.now(), error: null, progress: null });
      if (state.autoCheck && mode === 'installer') void download();
    });
    updater.on('update-not-available', (info) => update({
      phase: 'up-to-date',
      latestVersion: info && info.version ? String(info.version) : currentVersion,
      checkedAt: Date.now(), error: null, progress: null,
    }));
    updater.on('download-progress', (progress) => update({
      phase: 'downloading',
      progress: Math.max(0, Math.min(100, Number(progress && progress.percent) || 0)),
      error: null,
    }));
    updater.on('update-downloaded', (info) => {
      const latestVersion = info && info.version ? String(info.version) : state.latestVersion;
      update({ phase: 'downloaded', latestVersion, progress: 100, error: null });
      if (latestVersion !== promptedVersion && typeof options.onDownloaded === 'function') {
        promptedVersion = latestVersion;
        try { options.onDownloaded(snapshot()); } catch {}
      }
    });
    updater.on('error', (error) => update({ phase: 'error', error: errorMessage(error), progress: null, checkedAt: Date.now() }));
  }

  function start(schedule = true) {
    if (started) return snapshot();
    started = true;
    bindUpdater();
    if (schedule && supported) {
      startTimer = setTimer(() => { if (state.autoCheck) void check(false); }, options.startDelayMs ?? DEFAULT_START_DELAY_MS);
      if (startTimer && typeof startTimer.unref === 'function') startTimer.unref();
      intervalTimer = setRepeatingTimer(() => { if (state.autoCheck) void check(false); }, options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
      if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref();
    }
    return snapshot();
  }

  function onState(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { start, snapshot, check, download, install, openReleasePage, setAutoCheck, onState };
}

module.exports = {
  RELEASES_URL,
  MAC_RELEASES_URL,
  MAC_LATEST_API,
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_START_DELAY_MS,
  detectDistribution,
  errorMessage,
  parseVersion,
  compareVersions,
  pickMacAsset,
  fetchGitHubJson,
  createUpdateService,
};
