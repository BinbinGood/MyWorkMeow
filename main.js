'use strict';

// 打工喵 WorkMeow — Electron main process.
//
// Boot order: core (session state) → metering (cost) → permissions → HTTP
// server → install Claude Code hooks (using the bound port) → start watcher.
// Wiring: core/permission activity → adapter → pet:event / pet:stats pushed to
// the renderer over the preload IPC contract.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

// 必须早于 require('electron')：被 ELECTRON_RUN_AS_NODE 降级的进程里，
// require('electron') 返回的是可执行文件路径字符串而不是 API 对象。
const electronBootstrap = require('./backend/electron-bootstrap');
if (electronBootstrap.bootstrap().relaunched) process.exit(0);

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, shell, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const BRAND = require('./shared/brand');
const { IPC } = require('./shared/ipc-channels');
const { PetAssetStore, isAssetId } = require('./backend/pet-assets');
const { GifImportError } = require('./backend/gif-normalizer');

const PET_ASSET_SCHEME = 'workmeow-asset';
protocol.registerSchemesAsPrivileged([{
  scheme: PET_ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

// Give the dev app the public WorkMeow identity so it isn't shown as a generic
// "Electron" window or confused with an older legacy build.
try { app.setName(BRAND.name); } catch {}
try { app.setAppUserModelId(BRAND.appId); } catch {}

const config = require('./backend/config');
const { createCore } = require('./backend/core');
const { createMetering } = require('./backend/metering');
const { createPricingSync } = require('./backend/pricing-sync');
const { createPermissions, visibleSuggestions } = require('./backend/permission');
const { createServer } = require('./backend/server');
const adapter = require('./backend/adapter');
const hooks = require('./backend/hooks');
const { focusSession } = require('./backend/focus');
const { createCodexWatch } = require('./backend/codex-watch');
const { createTraeWatch } = require('./backend/trae-watch');
const { createCodexMetering } = require('./backend/codex-metering');
const { createCodexRateLimits, unavailableState: unavailableCodexQuota } = require('./backend/codex-rate-limits');
const { estimateWeeklyQuota } = require('./backend/codex-quota-estimate');
const codexQuotaTray = require('./backend/codex-quota-tray');
const { createWorkbuddyMetering } = require('./backend/workbuddy-metering');
const { createTitles: createWorkbuddyTitles } = require('./backend/workbuddy-titles');
const macLoginItem = require('./backend/mac-login-item');
const trayStatus = require('./backend/tray-status');
const creditCycle = require('./backend/credit-cycle');
const { createTraeMetering } = require('./backend/trae-metering');
const { createOpenCodeMetering } = require('./backend/opencode-metering');
const { emptyUsage, normalizeSourceRow, mergeUsageRows, mergeDaily } = require('./backend/usage-stats');
const { buildIntegrationHealth } = require('./backend/integration-health');
const { withValues: withSourceValues, supportsCreditQuota } = require('./backend/source-registry');
const transport = require('./backend/transport');
const env = require('./backend/env');
const { migrateLegacyState } = require('./backend/paths');
const i18n = require('./shared/i18n');
const { shortKey } = require('./shared/agents');
const { createUpdateService } = require('./backend/updater');
const privacy = require('./backend/privacy');

const t = i18n.t;
const petAssetStore = new PetAssetStore();
// WorkBuddy 的任务名只有它自己的会话库里有（hook payload 不带标题）——只读取标题，
// 读不到就静默回落，见 backend/workbuddy-titles.js。
const workbuddyTitles = createWorkbuddyTitles({ workbuddyDir: env.value('WORKBUDDY_DIR') || undefined });

// Windows 下由 `npm start` 的 detached 启动器（start-detached.js）
// 让 GUI 进程脱离启动它的控制台，关闭终端后桌宠仍继续运行。

const PRELOAD = path.join(__dirname, 'preload.js');
const WINDOW_ICON_PNG_PATH = path.join(__dirname, 'assets', 'salary-cat.png');
// macOS 上 Chromium 能解码 .ico，所以 isEmpty() 探测永远为 false、PNG 回退永远不
// 触发，结果是拿一张多尺寸 Windows 图标去做 Dock/关于面板图标。darwin 直接选 PNG。
const WINDOW_ICON_PATH = process.platform === 'darwin'
  ? WINDOW_ICON_PNG_PATH
  : path.join(__dirname, 'assets', 'salary-cat.ico');
const WINDOW_ICON_FILE = nativeImage.createFromPath(WINDOW_ICON_PATH);
const WINDOW_ICON = WINDOW_ICON_FILE.isEmpty()
  ? nativeImage.createFromPath(WINDOW_ICON_PNG_PATH)
  : WINDOW_ICON_FILE;
const BASE_W = 320, BASE_H = 340;

// 让一个「用户主动打开的」窗口真正拿到键盘焦点。
// app.dock.hide() 会把 mac 上的 app 变成 accessory app，副作用是 show()/focus()
// 不再激活 app 本身 —— 窗口画出来了，但按键没人收，设置面板里的时间输入框会变成
// 死的。app.focus({steal:true}) 补上这一步。只给面板/设置用：桌宠窗口是被动悬浮
// 层，抢焦点会打断用户正在敲的字。
function presentWindow(win) {
  if (!win || win.isDestroyed()) return;
  try { win.show(); } catch {}
  try { win.focus(); } catch {}
  if (process.platform === 'darwin') {
    try { app.focus({ steal: true }); } catch {}
  }
}

function applyWindowBranding(win) {
  if (!win || win.isDestroyed()) return;
  try { win.setIcon(WINDOW_ICON); } catch {}
  if (process.platform === 'win32' && typeof win.setAppDetails === 'function') {
    try {
      win.setAppDetails({
        appId: BRAND.appId,
        appIconPath: WINDOW_ICON_PATH,
        appIconIndex: 0,
      });
    } catch {}
  }
}

// 单宠模型（2026-08-07 起）：
//   只有一只「打工喵」(mergedWin, agent='all')，统一展示和统计所有 AI 工具；
//   所有后端只通过这一只喵展示和统计。
// petWin 仅作兼容别名（被旧引用使用）。
let mergedWin = null;
let petWin = null;
let panelWin = null; // 详情面板（唯一，汇总所有工具）
let settingsWin = null; // 设置面板（唯一）
let panelHeight = 0; // 当前自适应高度（防抖用）
let tray = null;
let core = null;
let metering = null;
let pricingSync = null;
let permissions = null;
let server = null;
let stopWatcher = null;
let codexWatch = null;  // Codex rollout 只读监听器
let traeWatch = null;   // TRAE SOLO CN 日志只读监听器
let codexMetering = null; // Codex rollout 累计 token 台账（与状态 watcher 解耦）
let codexRateLimits = null; // Codex App Server 订阅额度（独立于 rollout token 台账）
let codexQuotaState = unavailableCodexQuota('idle');
let workbuddyMetering = null; // WorkBuddy 转录 token 台账（只读，从 ~/.workbuddy/projects 扫描）
let traeMetering = null; // TRAE agent 日志 token 台账（只读，从 Trae CN logs 扫描）
let opencodeMetering = null; // opencode 用量台账（只读，tail ~/.workmeow/opencode-usage.jsonl）
let updateService = null;

// 宠物窗口的交互状态（单宠，但保留 Map 结构以便安全处理渲染进程生命周期）。
const petState = new Map(); // id → { agent, win, customSize, mouseIgnoring, dragId, dragSeq, lastEndedDragId }
const petStates = () => [...petState.values()].filter((s) => s.win && !s.win.isDestroyed());
const stateOfSender = (sender) => petState.get(sender.id) || null;
const primaryPetState = () => (petWin && !petWin.isDestroyed() ? petState.get(petWin.webContents.id) : null);

let lastStats = null;   // 全量快照（面板与桌宠共用）
let statsTimer = null;
let trayTimer = null;
let emitDebounce = null;
const recentOps = []; // ring for the panel "操作流"; newest first, capped
const pendingQuotaAlerts = new Map();
let quotaAlertTimer = null;

// ── window geometry ───────────────────────────────────────────────────────────
  // customSize is set by the renderer for either an intrinsic-width resting
  // capsule or an open popup, so neither state leaves an unnecessarily large
  // transparent window.
function targetSize(st) {
  const cs = st && st.customSize;
  if (cs) {
    return { w: Math.min(900, Math.max(BASE_W, cs.w)), h: Math.max(BASE_H, cs.h) };
  }
  return { w: BASE_W, h: BASE_H };
}

function validPetAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;
  const numeric = ['screenX', 'screenY', 'width', 'height', 'xOffset', 'yOffset'];
  if (!numeric.every((key) => Number.isFinite(anchor[key]))) return null;
  if (!(anchor.width > 0) || !(anchor.height > 0)) return null;
  if (!['left', 'center', 'right'].includes(anchor.xAlign)) return null;
  if (!['top', 'bottom'].includes(anchor.yAlign)) return null;
  return anchor;
}

// 从「桌宠本体在屏幕上的位置」反解窗口原点。
// 三条 xAlign 分支都是活的：渲染端贴左/右缘时把整列拉到窗口缘，本体的窗内偏移
// 变成 0，反解出的原点正好落在工作区缘上，下面 applyPetSize 的钳制就不会吃掉那
// ~100px 透明留白 —— 这正是「左右能真贴边」的实现方式（见 renderer/pet.css 里
// #stage.edge-left / .edge-right 的注释）。上面的 xAlign 白名单挡住脏值。
function anchoredPetOrigin(anchor, width, height) {
  let localX;
  if (anchor.xAlign === 'left') localX = anchor.xOffset;
  else if (anchor.xAlign === 'right') localX = width - anchor.xOffset - anchor.width;
  else localX = width / 2 + anchor.xOffset - anchor.width / 2;

  const localY = anchor.yAlign === 'top'
    ? anchor.yOffset
    : height - anchor.yOffset - anchor.height;
  return {
    x: Math.round(anchor.screenX - localX),
    y: Math.round(anchor.screenY - localY),
  };
}

function applyPetSize(st, requestedAnchor) {
  if (!st || !st.win || st.win.isDestroyed()) return;
  const win = st.win;
  const { w } = targetSize(st);
  let { h } = targetSize(st);
  const b = win.getBounds();
  // 目标与当前完全一致就别下发。setBounds 在 macOS 上会让 WindowServer 重排整个
  // 透明窗口，而渲染层一次「气泡展开→收起」会连着算出 320→520→320 三个目标：
  // 第 3 次与第 1 次的尺寸一模一样，白重排一遍，正是切状态时那下卡顿。
  // 放在两条分支的 setBounds 之前各判一次（下面 catch 里那条走的是另一套坐标）。
  const same = (x, y, width, height) => x === b.x && y === b.y && width === b.width && height === b.height;
  // Cap the window to the screen's work area so a tall popup can NEVER push the
  // pet / footer buttons off-screen — the popup scrolls internally instead.
  try {
    const wa = screen.getDisplayMatching(b).workArea;
    const width = Math.min(w, wa.width);
    h = Math.min(h, wa.height);
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, width, h) : null;
    const cx = b.x + b.width / 2;
    const bottom = b.y + b.height;
    let x = anchored ? anchored.x : Math.round(cx - width / 2);
    let y = anchored ? anchored.y : Math.round(bottom - h);
    x = Math.min(Math.max(x, wa.x), wa.x + wa.width - width);
    y = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
    if (same(x, y, width, h)) return;
    win.setBounds({ x, y, width, height: h });
  } catch {
    const anchor = validPetAnchor(requestedAnchor);
    const anchored = anchor ? anchoredPetOrigin(anchor, w, h) : null;
    const bottom = b.y + b.height;
    const x = anchored ? anchored.x : b.x;
    const y = anchored ? anchored.y : Math.round(bottom - h);
    if (same(x, y, w, h)) return;
    win.setBounds({ x, y, width: w, height: h });
  }
}

// 单宠：永远只有一只合并宠盯全部后端。
function createPetWindows() {
  reconcilePets();
}

function persistPos(b) {
  config.save({ petPosition: { x: b.x, y: b.y } });
}

function makePetWindow(agent) {
  agent = 'all'; // 单宠：忽略入参，恒为合并宠
  const c = config.get();
  const saved = c.petPosition;
  let x, y;
  if (saved) { x = saved.x; y = saved.y; }
  else {
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      x = wa.x + wa.width - BASE_W - 24;
      y = wa.y + wa.height - BASE_H - 24;
    } catch {}
  }

  const win = new BrowserWindow({
    icon: WINDOW_ICON,
    width: BASE_W,
    height: BASE_H,
    x, y,
    frame: false,
    transparent: true,
    // 透明窗口也要显式给一个全透明底色。缺省时 Electron 用不透明白，macOS 上
    // 合成器要靠它判断「这块该不该清」；面板窗口（:322）和设置窗口（:371）
    // 都设了各自的背景色，只有桌宠没设。八位十六进制的末两位是 alpha。
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  applyWindowBranding(win);
  win.setAlwaysOnTop(true, 'floating');
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  hardenWindow(win, path.join(__dirname, 'renderer', 'pet.html'));
  // ?agent= 仅保留兼容参数；单宠模式始终由统一的 all 形象渲染。
  win.loadFile(path.join(__dirname, 'renderer', 'pet.html'), { query: { agent } });

  // mouseIgnoring=true：透明窗启动即穿透，renderer 命中测试后再接管（pet.js 同款默认）
  const st = {
    agent, win, customSize: null, mouseIgnoring: true,
    dragId: null, dragSeq: -1, lastEndedDragId: null,
  };
  // 'closed' 之后绝不能再碰 win.webContents（抛 "Object has been destroyed"，主进程
  // 未捕获直接崩）——id 在创建时取好。
  const wcId = win.webContents.id;
  petState.set(wcId, st);
  win.on('closed', () => {
    petState.delete(wcId);
    if (petWin === win) petWin = null;
    if (mergedWin === win) mergedWin = null;
  });

  win.on('moved', () => {
    if (st.customSize && st.customSize.mode === 'popup') return; // only persist the resting position
    if (win.isDestroyed()) return;
    persistPos(win.getBounds());
  });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, IPC.XIABAN_SCHEDULE, getXiabanSchedule());
    if (core) sendWin(win, IPC.PET_STATS, buildStats(st.agent));
    deliverQuotaAlerts(win);
  });
  return win;
}

// 详情面板：唯一一个，汇总所有 AI 工具的用量（agent 参数保留仅为兼容旧调用）。
function openPanel() {
  if (panelWin && !panelWin.isDestroyed()) {
    presentWindow(panelWin);
    return;
  }
  panelHeight = 0;
  const win = new BrowserWindow({
    icon: WINDOW_ICON,
    width: 580,
    height: 850,
    minHeight: 500,
    frame: false,
    transparent: false,
    resizable: true,
    skipTaskbar: false,
    show: false,
    backgroundColor: '#eef4fc', // 与面板淡蓝配色一致，避免加载白闪
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowBranding(win);
  hardenWindow(win, path.join(__dirname, 'renderer', 'panel.html'));
  panelWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'panel.html'), { query: { agent: 'all' } });
  win.webContents.on('did-finish-load', () => {
    sendWin(win, IPC.PANEL_PRICE, combinedPriceInfo());
    setTimeout(() => {
      try {
        presentWindow(win);
      } catch {}
    }, 120);
  });
  win.on('closed', () => { if (panelWin === win) panelWin = null; panelHeight = 0; });
}

function closePanel() {
  if (panelWin && !panelWin.isDestroyed()) panelWin.close();
  panelWin = null;
  panelHeight = 0;
}

// 设置面板：沿用详情面板的无边框玻璃卡片风格，集中放置用户偏好。
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    presentWindow(settingsWin);
    return;
  }
  const win = new BrowserWindow({
    icon: WINDOW_ICON,
    width: 840,
    height: 760,
    minWidth: 720,
    minHeight: 620,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: false,
    show: false,
    center: true,
    backgroundColor: '#eef4fc',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowBranding(win);
  hardenWindow(win, path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      try {
        presentWindow(win);
      } catch {}
    }, 80);
  });
  win.on('closed', () => { if (settingsWin === win) settingsWin = null; });
}

function closeSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  settingsWin = null;
}

function watcherHealth(watcher) {
  const available = !!watcher && typeof watcher.start === 'function';
  let running = false;
  if (available) {
    try {
      running = typeof watcher.isRunning === 'function' ? watcher.isRunning() : true;
    } catch {}
  }
  return { available, running };
}

function codexDetected() {
  const configured = env.value('CODEX_DIR');
  try {
    return configured ? fs.existsSync(configured) : fs.existsSync(path.join(os.homedir(), '.codex'));
  } catch { return false; }
}

function currentIntegrationHealth() {
  const port = server && server.getPort();
  const token = server && server.getToken();
  return buildIntegrationHealth({
    hookIntegrations: hooks.integrationStatus(port, token),
    hooksEnabled: config.reload().hooksEnabled !== false,
    codexDetected: codexDetected(),
    watchers: {
      codex: watcherHealth(codexWatch),
      trae: watcherHealth(traeWatch),
    },
    snapshot: core ? core.buildSnapshot() : null,
  });
}

function repairIntegrationHealth() {
  if (env.flag('NO_HOOKS')) {
    return { ...currentIntegrationHealth(), ok: false, error: 'disabled-by-environment' };
  }
  if (!server || !server.getPort() || !server.getToken()) {
    return { ...currentIntegrationHealth(), ok: false, error: 'service-unavailable' };
  }

  const before = currentIntegrationHealth();
  const managedRepairNeeded = before.integrations.some((row) =>
    row.repairable && (row.mode === 'hook' || row.mode === 'plugin'));
  try {
    if (managedRepairNeeded) {
      hooks.install(server.getPort(), server.getToken());
      if (!stopWatcher) {
        stopWatcher = hooks.startWatcher(() => ({ port: server.getPort(), token: server.getToken() }));
      }
    }
    for (const watcher of [codexWatch, traeWatch]) {
      if (watcher && typeof watcher.start === 'function') watcher.start();
    }
  } catch {
    return { ...currentIntegrationHealth(), ok: false, error: 'repair-failed' };
  }
  const health = currentIntegrationHealth();
  return {
    ...health,
    ok: health.summary.needsRepair === 0,
    error: health.summary.needsRepair === 0 ? null : 'partial',
  };
}

function uninstallIntegrationHealth() {
  try {
    if (stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
  } catch {}

  let results = null;
  try { results = hooks.uninstall(); } catch {}
  const health = currentIntegrationHealth();
  const ok = Array.isArray(results) && results.every((result) => result !== null);
  return { ...health, ok, error: ok ? null : 'partial', uninstallRetryable: !ok };
}

// 显示/藏起打工喵（单宠：只有一个开关）。
function showPet() {
  if (!mergedWin || mergedWin.isDestroyed()) reconcilePets();
  if (mergedWin && !mergedWin.isDestroyed()) {
    mergedWin.show();
    deliverQuotaAlerts(mergedWin);
  }
  refreshTrayMenu();
}
function hidePet() {
  if (mergedWin && !mergedWin.isDestroyed()) mergedWin.hide();
  refreshTrayMenu();
}


// Block any navigation / new-window to external content (hardening).
function hardenWindow(win, allowedFile = null) {
  const allowedPath = allowedFile ? path.resolve(allowedFile) : null;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const next = new URL(url);
      const nextPath = next.protocol === 'file:' ? path.resolve(fileURLToPath(next)) : null;
      if (next.protocol !== 'file:' || (allowedPath && nextPath !== allowedPath)) e.preventDefault();
    } catch { e.preventDefault(); }
  });
  win.webContents.on('will-redirect', (e) => e.preventDefault());
}

// ── push helpers ──────────────────────────────────────────────────────────────
function sendWin(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
function firstAlivePetWin() {
  return mergedWin && !mergedWin.isDestroyed() ? mergedWin : null;
}
function sendPet(channel, payload) { sendWin(firstAlivePetWin(), channel, payload); }
function sendPanel(channel, payload) { sendWin(panelWin, channel, payload); }

function publishPetAssets(catalog = petAssetStore.catalog()) {
  sendPet(IPC.PET_ASSETS, catalog);
  sendWin(settingsWin, IPC.PET_ASSETS, catalog);
  return catalog;
}

function publishUpdateState(state) {
  sendWin(settingsWin, IPC.UPDATE_STATE, state);
  return state;
}

function publishPrivacyState(enabled = config.get().privacyMode === true) {
  const state = { enabled: enabled === true };
  sendWin(settingsWin, IPC.PRIVACY_STATE, state);
  return state;
}

function promptDownloadedUpdate(state) {
  const owner = settingsWin && !settingsWin.isDestroyed()
    ? settingsWin
    : (petWin && !petWin.isDestroyed() ? petWin : null);
  const options = {
    type: 'info',
    title: t('update.readyTitle'),
    message: t('update.readyMessage', { version: state.latestVersion || '' }),
    detail: t('update.readyDetail'),
    buttons: [t('update.restartNow'), t('update.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const prompt = owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
  prompt.then(({ response }) => { if (response === 0 && updateService) updateService.install(); }).catch(() => {});
}

function initUpdateService() {
  updateService = createUpdateService({
    app,
    updater: autoUpdater,
    config,
    shell,
    onState: publishUpdateState,
    onDownloaded: promptDownloadedUpdate,
  });
  updateService.start(true);
}

function registerPetAssetProtocol() {
  protocol.handle(PET_ASSET_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'asset') return new Response('Not found', { status: 404 });
      const match = decodeURIComponent(url.pathname).match(/^\/([^/]+)\.gif$/i);
      const file = match && isAssetId(match[1]) ? petAssetStore.assetPath(match[1]) : null;
      if (!file) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });
}

function meterInstances() {
  return {
    claude: metering,
    codex: codexMetering,
    workbuddy: workbuddyMetering,
    trae: traeMetering,
    opencode: opencodeMetering,
  };
}

function meterStats() {
  return Object.fromEntries(withSourceValues(meterInstances()).map(({ id, value }) => [
    id,
    value && typeof value.getStats === 'function' ? value.getStats() : null,
  ]));
}

// The detail panel shows a merged ledger, so its price badge must describe the
// merged sources too. Reporting Claude alone made the badge look online even
// when another provider was still using a stale or built-in table.
function combinedPriceInfo() {
  const items = withSourceValues(meterInstances()).flatMap(({ id, label, value: meter }) => {
    if (!meter || typeof meter.priceInfo !== 'function') return [];
    try { return [{ id, name: label, ...meter.priceInfo() }]; } catch { return []; }
  });
  const liveCount = items.filter((item) => item.live).length;
  const live = items.length > 0 && liveCount === items.length;
  const ts = items.reduce((max, item) => Math.max(max, Number(item.ts) || 0), 0);
  const count = items.reduce((max, item) => Math.max(max, Number(item.count) || 0), 0);
  return {
    live,
    mixed: liveCount > 0 && liveCount < items.length,
    count,
    ts,
    source: [...new Set(items.map((item) => item.source).filter(Boolean))].join(' + ') || 'builtin',
    stale: items.some((item) => item.stale),
    estimate: items.some((item) => item.estimate),
    sources: items,
    sync: pricingSync && typeof pricingSync.getStatus === 'function'
      ? pricingSync.getStatus()
      : null,
  };
}

// 单宠：所有事件都发给这唯一的一只打工喵。
function sendPetEvent(ev) {
  sendPet(IPC.PET_EVENT, privacy.protectEvent(ev, config.get().privacyMode === true));
}

function quotaAlertEvent(alert) {
  const remaining = codexQuotaTray.percentText(alert);
  const reset = codexQuotaTray.resetText(alert, alert.kind);
  const key = alert.kind === 'weekly' ? 'quota.alertWeekly' : 'quota.alertFiveHour';
  return {
    kind: 'quota-alert',
    text: t(key, { remaining, reset }),
    agent: 'codex',
    ts: Date.now(),
  };
}

function deliverQuotaAlerts(targetWin = null) {
  if (quotaAlertTimer) clearTimeout(quotaAlertTimer);
  quotaAlertTimer = null;
  const alerts = [...pendingQuotaAlerts.values()];
  if (!alerts.length) return;
  const events = alerts.map(quotaAlertEvent);
  const event = privacy.protectEvent({
    ...events[0],
    text: events.map((item) => item.text).join('\n'),
    quotaAlerts: events.map((item, index) => ({ id: alerts[index].alertId, text: item.text })),
  }, config.get().privacyMode === true);
  const win = targetWin || firstAlivePetWin();
  const loading = win && win.webContents && typeof win.webContents.isLoadingMainFrame === 'function'
    ? win.webContents.isLoadingMainFrame()
    : !win;
  if (win && !loading) sendWin(win, IPC.PET_EVENT, event);
}

function showQuotaAlert(alert) {
  if (!alert || typeof alert.alertId !== 'string' || !alert.alertId) return;
  pendingQuotaAlerts.set(alert.alertId, alert);
  if (quotaAlertTimer) return;
  quotaAlertTimer = setTimeout(deliverQuotaAlerts, 80);
  if (quotaAlertTimer.unref) quotaAlertTimer.unref();
}

// 没有计量数据源的工具（未来工具）用的空台账
function emptyMeter() {
  return {
    today: emptyUsage(),
    lifetime: emptyUsage(),
    byModel: {}, hourly: new Array(24).fill(0), hourlyTok: new Array(24).fill(0), daily: {}, diagnostics: null,
  };
}

// 统一统计（2026-08-07 起）：不分工具，所有数据源合并成一份台账对外展示。
// agent 参数保留仅为兼容旧调用，取值不影响结果。
function buildStats(agent = 'all', snapshot = null, cachedMeter = null) {
  const snap = snapshot || core.buildSnapshot();
  // 会话标签跟着 WorkBuddy 里显示的任务名走（拿不到就不动，回落链见
  // adapter.projectName）。放在这里是因为所有出口（桌宠 / 面板 / 设置）都经过它。
  workbuddyTitles.attach(snap.sessions);
  // 使用缓存的 metering 数据避免重复调用 getStats()
  const sourceRows = withSourceValues(cachedMeter || meterStats()).map(({ id, value }) => [id, value]);
  const usageBySource = Object.fromEntries(sourceRows);
  const claudeMeter = usageBySource.claude;
  const codexUsage = usageBySource.codex;
  const workbuddyUsage = usageBySource.workbuddy;
  const traeUsage = usageBySource.trae;
  const opencodeUsage = usageBySource.opencode;

  // 合并所有已接入的数据源；来源顺序由 source-registry 统一维护。
  const sourceMeters = sourceRows;
  const meter = claudeMeter ? { ...claudeMeter } : emptyMeter();
  meter.today = mergeUsageRows(sourceMeters.map(([source, usage]) => [source, usage && usage.today]));
  meter.lifetime = mergeUsageRows(sourceMeters.map(([source, usage]) => [source, usage && usage.lifetime]));
  // Each metering source already keeps a retained daily ledger. Expose the
  // merged ledger so the panel can switch between today/7d/30d without
  // silently dropping Codex, WorkBuddy, TRAE or opencode history.
  meter.daily = mergeDaily(sourceMeters);
  const mergeHourly = (key) => Array.from({ length: 24 }, (_, i) => sourceRows.reduce(
    (sum, [, usage]) => sum + ((usage && usage[key] && usage[key][i]) || 0), 0,
  ));
  meter.hourly = mergeHourly('hourly');
  meter.hourlyTok = mergeHourly('hourlyTok');
  // 按模型合并：同名模型（如各工具都跑 glm-5）聚合成一行。
  const byModel = {};
  for (const [source, usage] of sourceRows) {
    const src = usage && usage.byModel;
    if (!src) continue;
    for (const [model, row] of Object.entries(src)) {
      const normalized = normalizeSourceRow(source, row);
      const acc = (byModel[model] = byModel[model] || {
        tokens: 0, cost: 0, msgs: 0, messages: 0, input: 0, output: 0,
        inputTotal: 0, cachedInput: 0, cacheRead: 0, cacheWrite5m: 0,
        cacheWrite1h: 0, cacheCreate: 0, reasoningOutput: 0,
      });
      acc.tokens += normalized.tokens;
      acc.cost += normalized.cost;
      acc.msgs += normalized.msgs;
      acc.messages = acc.msgs;
      acc.input += normalized.input;
      acc.output += normalized.output;
      acc.inputTotal += normalized.inputTotal;
      // cacheRead is the single normalized cache-read field. Do not add
      // opencode's cachedInput and its mapped cacheRead twice.
      acc.cacheRead += normalized.cacheRead;
      acc.cacheWrite5m += normalized.cacheWrite5m;
      acc.cacheWrite1h += normalized.cacheWrite1h;
      acc.cacheCreate += normalized.cacheCreate;
      acc.reasoningOutput += normalized.reasoningOutput;
    }
  }
  meter.byModel = byModel;

  const pending = permissions.getPending();
  const ops = recentOps.slice(0, 30);
  const stats = adapter.buildPetStats(snap, pending, meter, {
    lastOps: ops,
    codexUsage,
    usageProvider: 'all',
  });
  stats.chipDisplay = getChipDisplay();
  // 底部展示栏每个**检测到**的 Agent 一个额度徽标，显不显示由 chipDisplay.quotaAgents
  // 逐个控制（以前是一个会动态改名的「额度槽位」，见 config.js quotaAgents 的说明）。
  stats.quotaAgents = trayAgents();
  const quotaWindows = codexQuotaState.windows || {};
  const quotaAccount = codexQuotaState.account && typeof codexQuotaState.account === 'object'
    ? {
      type: codexQuotaState.account.type || null,
      planType: codexQuotaState.account.planType || null,
    }
    : null;
  stats.codexQuota = {
    windows: quotaWindows,
    status: codexQuotaState.status,
    statusText: quotaStatusLabel(codexQuotaState),
    updatedAt: codexQuotaState.updatedAt,
    account: quotaAccount,
    estimate: estimateWeeklyQuota(codexUsage, quotaWindows.weekly),
  };
  return privacy.protectStats(stats, config.get().privacyMode === true);
}


function recordOp(ev) {
  if (ev.kind === 'operation') {
    recentOps.unshift({ tool: ev.tool, icon: ev.icon, detail: ev.detail, file: ev.file || '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else if (ev.kind === 'say') {
    recentOps.unshift({ tool: 'say', icon: '💬', detail: ev.text, file: '', project: ev.project || '', agent: ev.agent || 'claude', ts: ev.ts });
  } else return;
  if (recentOps.length > 50) recentOps.length = 50;
}

function emitStats() {
  if (!core) return;
  const snapshot = core.buildSnapshot();
  // 一次性获取 metering 数据，避免多次调用 getStats()
  const cachedMeter = meterStats();
  lastStats = buildStats('all', snapshot, cachedMeter);
  for (const st of petStates()) sendWin(st.win, IPC.PET_STATS, lastStats);
  sendPanel(IPC.PANEL_STATS, lastStats);
}

function scheduleEmit() {
  if (emitDebounce) return;
  emitDebounce = setTimeout(() => { emitDebounce = null; emitStats(); }, 150);
}

function bootBackend() {
  const codexDir = env.value('CODEX_DIR') || undefined;
  core = createCore({
    onActivity: (act) => {
      for (const ev of adapter.activityToEvents(act)) { recordOp(ev); sendPetEvent(ev); }
    },

    onDirty: scheduleEmit,
  });
  core.startStaleCleanup();
  if (!env.flag('NO_CODEX')) {
    codexMetering = createCodexMetering({
      sessionsDir: codexDir,
    });
    codexMetering.start(30000);
    codexWatch = createCodexWatch({
      core,
      // 开发/E2E 可用 WORKMEOW_CODEX_DIR 指到假目录，不碰真实 ~/.codex
      sessionsDir: codexDir,
    });
    codexWatch.start();

    if (!env.flag('NO_NET')) {
      // One official, long-lived App Server owns Codex authentication and emits
      // rate-limit updates. No auth.json or ChatGPT web endpoint is read here.
      codexRateLimits = createCodexRateLimits({
        version: require('./package.json').version,
        onUpdate: (next) => {
          codexQuotaState = next;
          refreshTrayMenu();
          // Publish the same quota snapshot immediately; do not wait for the
          // periodic stats refresh to catch the capsule up with the tray.
          emitStats();
        },
        onAlert: showQuotaAlert,
      });
      codexRateLimits.start();
    }
  }

  metering = createMetering();
  metering.start(30000);

  // WorkBuddy token ledger: scans ~/.workbuddy/projects transcripts read-only.
  // Same gating as Codex (WORKMEOW_NO_CODEX disables that; no equivalent flag yet
  // for WorkBuddy, but it's cheap and isolated).
  workbuddyMetering = createWorkbuddyMetering({
    projectsDir: env.value('WORKBUDDY_DIR') || undefined,
  });
  workbuddyMetering.start(30000);

  // TRAE token ledger: scans Trae CN ai-agent stdout logs read-only
  // (token usage: TokenUsageEvent lines). Pricing uses the models.dev cache.
  traeMetering = createTraeMetering({
    logsRoot: env.value('TRAE_DIR') || undefined,
  });
  traeMetering.start(30000);

  // opencode 用量台账：tail ~/.workmeow/opencode-usage.jsonl（插件写入），
  // 只读，与状态推送（插件直接 POST /state）解耦。WORKMEOW_NO_OPENCODE=1 跳过。
  if (!env.flag('NO_OPENCODE')) {
    opencodeMetering = createOpenCodeMetering({
      usageFile: env.value('OPENCODE_USAGE') || undefined,
    });
    opencodeMetering.start(30000);
  }

  // TRAE 状态监听：TRAE SOLO CN 的内置 agent 不支持 Claude hooks，唯一可靠
  // 的活动信号源是 ai-agent stdout 日志。读日志增量 tail 把工具生命周期
  // (hook=PreToolUse/PostToolUse) 翻译成 core 状态流。
  if (!env.flag('NO_TRAE')) {
    traeWatch = createTraeWatch({ core });
    traeWatch.start();
  }

  // Pricing sync: fetches models.dev's open pricing JSON once on boot + every 24h.
  // metering.loadPricing() now reads ~/.workmeow/pricing-cache.json beneath the
  // user override. Public-data only — no credentials, no API calls.
  // On a fresh sync: reload the in-memory price table (so new prices apply this
  // run, not next restart) and push the updated source line to the panel.
  // WORKMEOW_NO_NET=1 keeps WorkMeow fully offline: pricing uses the built-in
  // table and the Codex quota rows remain unavailable (`--`).
  if (!env.flag('NO_NET')) {
    pricingSync = createPricingSync({
      onStatus: () => {
        sendPanel(IPC.PANEL_PRICE, combinedPriceInfo());
      },
      onUpdate: async () => {
        const rebuilds = [];
        if (metering) {
          try {
            const result = metering.reloadPricing();
            if (result && typeof result.then === 'function') rebuilds.push(result);
          } catch {}
        }
        for (const { id, value: meter } of withSourceValues(meterInstances())) {
          if (id === 'claude') continue;
          if (!meter) continue;
          try {
            const result = id === 'workbuddy' && typeof meter.reloadPricing === 'function'
              ? meter.reloadPricing()
              : typeof meter.rebuild === 'function' ? meter.rebuild() : null;
            if (result && typeof result.then === 'function') rebuilds.push(result);
          } catch {}
        }
        await Promise.allSettled(rebuilds);
        sendPanel(IPC.PANEL_PRICE, combinedPriceInfo());
        scheduleEmit();
      },
    });
    pricingSync.start();
  }

  permissions = createPermissions({
    onAdded: (entry) => {
      const session = core.getSession(entry.sessionId);
      const lite = session ? {
        id: session.id,
        cwd: session.cwd,
        sessionTitle: session.sessionTitle,
        agentId: session.agentId,
      } : null;
      let choice, kind, reason;
      if (entry.isElicitation) {
        choice = adapter.buildElicitationChoice(
          { id: entry.id, sessionId: entry.sessionId, questions: entry.questions }, lite);
        kind = 'needsinput'; reason = 'reply';
      } else if (entry.toolName === 'ExitPlanMode') {
        choice = adapter.buildPlanChoice(
          { id: entry.id, sessionId: entry.sessionId, toolInput: entry.toolInput }, lite);
        kind = 'needsinput'; reason = 'plan';
      } else {
        choice = adapter.buildPermChoice(
          {
            id: entry.id,
            sessionId: entry.sessionId,
            toolName: entry.toolName,
            toolInput: entry.toolInput,
            // 「始终允许」那一排按钮会把规则写进 settings.json，而这条能力只有
            // Claude Code 有（WorkBuddy 的 decision 只认 behavior / updatedInput，
            // 规则会被静默丢掉）。判断集中在 backend/permission.js，实时卡片和
            // stats 快照共用同一个口径。
            suggestions: visibleSuggestions(entry),
          },
          lite,
        );
        kind = 'waiting'; reason = 'perm';
      }
      // A parked permission needs the user's eyes. In menubar mode (or if the pet
      // was hidden) the ask panel would render into an invisible window and CC
      // would hang until the park times out — so surface the pet window first.
      try { const w = firstAlivePetWin(); if (w && !w.isVisible()) w.show(); } catch {}
      sendPetEvent({ kind, project: choice.project, reason, sessionId: entry.sessionId, choice, agent: shortKey(entry.agentId), ts: Date.now() });
      scheduleEmit();
    },
    onChange: scheduleEmit,
  });

  server = createServer({ core, permissions });
  server.start();

  // Install hooks once the server has a port (defer so listen wins the race).
  // WORKMEOW_NO_HOOKS=1 skips touching ~/.claude/settings.json +
  // ~/.trae-cn/hooks.json + ~/.workbuddy/settings.json +
  // ~/.config/opencode/plugins/opencode-plugin.js (dev/verify mode).
  setTimeout(() => {
    if (env.flag('NO_HOOKS') || config.get().hooksEnabled === false) {
      return;
    }
    const port = server.getPort();
    if (!port) return;
    // hook 装失败（受限沙箱、状态目录只读、某工具配置被占用）只该降级成
    // 「状态不跟随」，不该让桌宠崩在启动路径上 —— 所以这里整段兜底。
    try {
      const installed = hooks.install(port, server.getToken());
      if (installed && installed.runtimeError) {
        console.warn('[workmeow] hook runtime staging failed:', installed.runtimeError);
      }
      stopWatcher = hooks.startWatcher(() => ({ port: server.getPort(), token: server.getToken() }));
      if (config.get().onboardingVersion < 1) {
        config.save({ onboardingVersion: 1 });
        showIntegrationStatus();
      }
    } catch (err) {
      console.warn('[workmeow] hook install failed:', err && err.message ? err.message : err);
    }
  }, 400);

  // Periodic refresh so idle→sleeping transitions + cost updates reach the UI.
  statsTimer = setInterval(emitStats, 4000);
  if (statsTimer.unref) statsTimer.unref();

  // 托盘顶部现在是各数据源的今日用量，得跟着台账走。单独一个低频定时器，
  // 不复用 4s 的 emitStats —— 重建一次原生菜单比发一次 IPC 贵得多，而且菜单
  // 正被打开时频繁重建没有意义。
  trayTimer = setInterval(refreshTrayMenu, 20000);
  if (trayTimer.unref) trayTimer.unref();
}

// minimal entry shape for adapter.projectName()
function registerIpc() {
  const senderPetWin = (e) => {
    const st = stateOfSender(e.sender);
    if (st && st.win && !st.win.isDestroyed()) return st.win;
    return petWin && !petWin.isDestroyed() ? petWin : null;
  };

  ipcMain.handle(IPC.GET_STATS, () => lastStats || buildStats());
  ipcMain.handle(IPC.GET_WIN_POS, (e) => {
    const win = senderPetWin(e);
    if (!win) return [0, 0];
    const b = win.getBounds();
    return [b.x, b.y];
  });
  ipcMain.handle(IPC.GET_WINDOW_METRICS, (e) => {
    const win = senderPetWin(e);
    if (!win) return null;
    const windowBounds = win.getBounds();
    let workArea = null;
    try { workArea = screen.getDisplayMatching(windowBounds).workArea; } catch {}
    return { window: windowBounds, workArea };
  });

  ipcMain.on(IPC.SET_WIN_POS, (e, x, y, dragOffset) => {
    const st = stateOfSender(e.sender);
    const win = st && st.win && !st.win.isDestroyed() ? st.win : null;
    if (win && Number.isFinite(x) && Number.isFinite(y)) {
      const b = win.getBounds();
      let targetX = x;
      let targetY = y;
      const hasDragOffset = !!dragOffset && typeof dragOffset === 'object';
      const offsetX = hasDragOffset ? Number(dragOffset.x) : NaN;
      const offsetY = hasDragOffset ? Number(dragOffset.y) : NaN;
      const dragId = hasDragOffset && typeof dragOffset.id === 'string' ? dragOffset.id : '';
      const dragSeq = hasDragOffset ? Number(dragOffset.seq) : NaN;
      const validDragOffset = hasDragOffset && Number.isFinite(offsetX) && Number.isFinite(offsetY)
        && offsetX >= 0 && offsetX <= b.width && offsetY >= 0 && offsetY <= b.height;
      if (validDragOffset) {
        // A released gesture is terminal. This also makes a queued animation
        // frame harmless if it reaches main after pointerup/pointercancel.
        if (dragId && st.lastEndedDragId === dragId) return;
        if (dragId) {
          if (st.dragId !== dragId) {
            st.dragId = dragId;
            st.dragSeq = -1;
          }
          if (Number.isFinite(dragSeq) && dragSeq <= st.dragSeq) return;
          if (Number.isFinite(dragSeq)) st.dragSeq = dragSeq;
        }
        // Moving this transparent BrowserWindow can itself enqueue pointer
        // events with stale relative coordinates. Resolve every drag frame from
        // the OS cursor so a stationary hand can never feed movement back in.
        const cursor = screen.getCursorScreenPoint();
        targetX = cursor.x - offsetX;
        targetY = cursor.y - offsetY;
      }
      const nextX = Math.round(targetX);
      const nextY = Math.round(targetY);
      // setBounds can cause another pointermove even when Chromium reports the
      // same physical cursor. Do not create a self-sustaining move -> event ->
      // move loop when the window has already reached the requested pixel.
      if (nextX === b.x && nextY === b.y) return;
      win.setBounds({ x: nextX, y: nextY, width: b.width, height: b.height });
    }
  });

  ipcMain.on(IPC.END_WIN_DRAG, (e, dragId) => {
    const st = stateOfSender(e.sender);
    if (!st || typeof dragId !== 'string' || !dragId) return;
    if (st.dragId === dragId) {
      st.dragId = null;
      st.dragSeq = -1;
    }
    st.lastEndedDragId = dragId;
  });

  ipcMain.on(IPC.OPEN_PANEL, (_e, agent) => openPanel(agent || 'all'));
  ipcMain.on(IPC.CLOSE_PANEL, closePanel);
  ipcMain.handle(IPC.GET_AUTO_LAUNCH, () => getAutoLaunchStatus());
  ipcMain.handle(IPC.GET_CHIP_DISPLAY, () => getChipDisplay());
  ipcMain.handle(IPC.SET_CHIP_DISPLAY, (e, value) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) return { ok: false };
    const patch = {};
    for (const key of ['showCat', 'showStatus', 'showTokens', 'showCost']) {
      if (value && typeof value[key] === 'boolean') patch[key] = value[key];
    }
    // 额度开关按 Agent 逐个给：{ quotaAgents: { workbuddy: false } }。
    // 走 merge 而不是整表覆盖，改一个不会把别的 Agent 的开关抹掉。
    if (value && value.quotaAgents && typeof value.quotaAgents === 'object' && !Array.isArray(value.quotaAgents)) {
      const merged = { ...(config.get().quotaAgents || {}) };
      let touched = false;
      for (const [id, enabled] of Object.entries(value.quotaAgents)) {
        if (!id || typeof enabled !== 'boolean') continue;
        merged[id] = enabled;
        touched = true;
      }
      if (touched) patch.quotaAgents = merged;
    }
    config.save(patch);
    // 托盘右键菜单也吃 quotaAgents（buildStatusRows 按 enabled 过滤），
    // 所以每次保存都得重建，不能等 20s 的定时刷新。
    refreshTrayMenu();
    emitStats();
    return { ok: true, ...getChipDisplay() };
  });
  ipcMain.handle(IPC.SET_AUTO_LAUNCH, (_e, enabled) => setAutoLaunch(enabled));
  // 每个检测到的 Agent 各自一份额度，不再有「槽位归谁」的概念 —— 设置页、底部
  // 展示栏、托盘三处都读同一份 trayAgents()。写入只接受设置窗口来的请求。
  ipcMain.handle(IPC.GET_QUOTA_AGENTS, () => ({ ok: true, agents: trayAgents() }));
  ipcMain.handle(IPC.SET_CREDIT_QUOTA, (e, payload) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) {
      return { ok: false, error: 'forbidden' };
    }
    return setCreditQuota(payload);
  });
  ipcMain.handle(IPC.GET_PRIVACY_MODE, (e) => {
    const fromSettings = settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
    if (!fromSettings && !stateOfSender(e.sender)) return { ok: false, error: 'forbidden' };
    return { ok: true, enabled: config.get().privacyMode === true };
  });
  ipcMain.handle(IPC.SET_PRIVACY_MODE, (e, enabled) => {
    const fromSettings = settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
    if (!fromSettings && !stateOfSender(e.sender)) return { ok: false, error: 'forbidden' };
    return { ok: true, enabled: setPrivacyMode(enabled === true) };
  });
  ipcMain.handle(IPC.GET_INTEGRATION_HEALTH, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) {
      return { ok: false, error: 'forbidden' };
    }
    return currentIntegrationHealth();
  });
  ipcMain.handle(IPC.REPAIR_INTEGRATIONS, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) {
      return { ok: false, error: 'forbidden' };
    }
    return repairIntegrationHealth();
  });
  ipcMain.handle(IPC.UNINSTALL_INTEGRATIONS, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) {
      return { ok: false, error: 'forbidden' };
    }
    return uninstallIntegrationHealth();
  });
  ipcMain.handle(IPC.GET_UPDATE_STATE, () => updateService ? updateService.snapshot() : null);
  ipcMain.handle(IPC.CHECK_FOR_UPDATES, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents || !updateService) {
      return { ok: false, error: 'forbidden' };
    }
    return updateService.check(true);
  });
  ipcMain.handle(IPC.SET_AUTO_UPDATE, (e, enabled) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents || !updateService) {
      return { ok: false, error: 'forbidden' };
    }
    return { ok: true, ...updateService.setAutoCheck(enabled) };
  });
  ipcMain.handle(IPC.DOWNLOAD_UPDATE, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents || !updateService) {
      return { ok: false, error: 'forbidden' };
    }
    return updateService.download();
  });
  ipcMain.handle(IPC.INSTALL_UPDATE, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents || !updateService) return false;
    return updateService.install();
  });
  ipcMain.handle(IPC.OPEN_UPDATE_PAGE, (e) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents || !updateService) return false;
    return updateService.openReleasePage();
  });
  ipcMain.handle(IPC.GET_XIABAN_SCHEDULE, () => getXiabanSchedule());
  ipcMain.handle(IPC.SET_XIABAN_SCHEDULE, (_e, schedule) => setXiabanSchedule(schedule));
  ipcMain.handle(IPC.GET_PET_ASSETS, () => petAssetStore.catalog());
  ipcMain.handle(IPC.IMPORT_PET_GIF, async (e, slotId, mode, options) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) {
      return { ok: false, error: 'forbidden', message: '只能在设置窗口中导入表情' };
    }
    const replacing = mode === 'replace' || mode === 'replace-one';
    const picked = await dialog.showOpenDialog(settingsWin, {
      title: replacing ? '选择用于替换的新表情 GIF' : '选择要新增的表情 GIF',
      buttonLabel: replacing ? '选择并替换' : '选择并添加',
      properties: ['openFile'],
      filters: [{ name: 'GIF 动画', extensions: ['gif'] }],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    try {
      const result = await petAssetStore.importGif(picked.filePaths[0], slotId, mode, options || {});
      publishPetAssets(result.catalog);
      return result;
    } catch (error) {
      const expected = error instanceof GifImportError;
      return {
        ok: false,
        error: expected ? error.code : 'processing-failed',
        message: expected ? error.message : 'GIF 处理失败，请换一个文件重试',
      };
    }
  });
  ipcMain.handle(IPC.REMOVE_PET_ASSET, (e, slotId, assetId) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) return { ok: false, error: 'forbidden' };
    const result = petAssetStore.removeAsset(slotId, assetId);
    if (result.ok) publishPetAssets(result.catalog);
    return result;
  });
  ipcMain.handle(IPC.RESET_PET_SLOT, (e, slotId) => {
    if (!settingsWin || settingsWin.isDestroyed() || e.sender !== settingsWin.webContents) return { ok: false, error: 'forbidden' };
    const result = petAssetStore.resetSlot(slotId);
    if (result.ok) publishPetAssets(result.catalog);
    return result;
  });
  ipcMain.on(IPC.CLOSE_SETTINGS, closeSettings);

  // 详情面板按内容高度自适应：clamp 到屏幕工作区，阈值防抖避免每次 stats 都抖
  ipcMain.on(IPC.SET_PANEL_HEIGHT, (e, h) => {
    const win = BrowserWindow.fromId(e.sender.id);
    if (!win || win.isDestroyed() || win !== panelWin || !Number.isFinite(h)) return;
    const b = win.getBounds();
    const wa = screen.getDisplayMatching(b).workArea;
    const clamped = Math.max(320, Math.min(Math.round(h), wa.height - 24));
    if (Math.abs(clamped - panelHeight) < 6) return;
    panelHeight = clamped;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: clamped });
  });

  // 收起 = 隐藏唯一的一只打工喵（托盘菜单可重新显示）。
  ipcMain.on(IPC.CLOSE_PET, (e) => {
    const st = stateOfSender(e.sender);
    if (!st || !st.win || st.win.isDestroyed()) return;
    st.win.hide();
    refreshTrayMenu();
  });

  ipcMain.handle(IPC.PERMISSION_DECIDE, (_e, permId, behavior) => {
    if (!permissions || typeof permId !== 'string' || !permId) return false;
    return permissions.decide(permId, behavior) === true;
  });
  ipcMain.handle(IPC.FOCUS_SESSION, (_e, sessionId) => {
    return focusSession(core.getSession(sessionId), {
      openExternal: (url) => shell.openExternal(url),
    });
  });
  // Dynamic sizing: renderer measures either the resting capsule or an open
  // popup and asks for an exact fit. w/h <= 0 resets to the base pet size.
  ipcMain.on(IPC.SET_PET_SIZE, (e, w, h, anchor, mode) => {
    const st = stateOfSender(e.sender) || primaryPetState();
    if (!st) return;
    st.customSize = (Number(w) > 0 && Number(h) > 0)
      ? { w: Number(w), h: Number(h), mode: mode === 'popup' ? 'popup' : 'resting' }
      : null;
    applyPetSize(st, anchor);
  });
  ipcMain.on(IPC.PET_BLUR, (e) => { const w = senderPetWin(e); if (w) { w.blur(); } });
  ipcMain.on(IPC.QUOTA_ALERT_SHOWN, (e, alertIds) => {
    const st = stateOfSender(e.sender);
    if (!st || !codexRateLimits || typeof codexRateLimits.acknowledgeAlert !== 'function') return;
    const ids = Array.isArray(alertIds) ? alertIds : [alertIds];
    for (const alertId of ids) {
      if (typeof alertId !== 'string' || !pendingQuotaAlerts.has(alertId)) continue;
      if (codexRateLimits.acknowledgeAlert(alertId)) pendingQuotaAlerts.delete(alertId);
    }
  });

  // Click-through: the renderer hit-tests the cursor and toggles this so the
  // transparent parts of the pet window let clicks reach apps behind it.
  // forward:true keeps mousemove flowing to the renderer while ignoring, so it
  // can re-enable clicks the moment the cursor returns to the pet/content.
  ipcMain.on(IPC.SET_IGNORE_MOUSE, (e, ignore) => {
    const st = stateOfSender(e.sender);
    const w = st && st.win && !st.win.isDestroyed() ? st.win : null;
    if (!w) return;
    st.mouseIgnoring = !!ignore; // 记录 renderer 期望的穿透状态
    try { w.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch {}
  });

}

// 单宠对账：确保唯一的一只打工喵存在。不存在就创建；存在就不动。
function reconcilePets() {
  if (!mergedWin || mergedWin.isDestroyed()) mergedWin = makePetWindow('all');
  petWin = mergedWin; // 兼容别名
}

// ── tray ──────────────────────────────────────────────────────────────────────
function buildTray() {
  let img;
  try {
    // 托盘始终使用月薪喵头像；额度只在右键菜单里展示。
    img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'salary-cat-tray.png'));
    if (img && !img.isEmpty()) {
      img = img.resize({ width: 32, height: 32 });
    }
  } catch {}
  tray = new Tray(img || nativeImage.createEmpty());
  tray.setToolTip(t('tray.tooltip'));
  refreshTrayMenu();
  tray.on('click', () => { showPet(); });
}

function showIntegrationStatus() {
  const health = currentIntegrationHealth();
  const rows = health.integrations;
  const detail = rows.map((row) => {
    const ready = row.state === 'ready';
    const key = ready
      ? 'dlg.integrationsReady'
      : row.state === 'disabled'
        ? 'dlg.integrationsDisabled'
        : row.detected ? 'dlg.integrationsFailed' : 'dlg.integrationsMissing';
    return `${ready ? '✓' : '—'} ${row.label}：${t(key)}`;
  }).join('\n') + `\n\n${t('dlg.integrationsHint')}`;
  dialog.showMessageBox({
    type: 'info',
    title: t('dlg.integrationsTitle'),
    message: t('dlg.integrationsMessage'),
    detail,
    buttons: ['开始使用'],
    defaultId: 0,
    noLink: true,
  }).catch(() => {});
}

function autoLaunchMatchOptions() {
  const options = {};
  // In development, Windows needs the Electron executable plus the project
  // path. Packaged builds launch the application executable directly.
  if (process.platform === 'win32') {
    options.path = process.execPath;
    options.args = app.isPackaged ? [] : [app.getAppPath()];
  }
  return options;
}

const LEGACY_AUTO_LAUNCH_NAMES = Object.freeze(['io.github.youraccount.workmeow']);

function autoLaunchSettings(enabled, name = BRAND.appId) {
  return { ...autoLaunchMatchOptions(), name, openAtLogin: !!enabled };
}

function autoLaunchSupported() {
  if (process.platform === 'darwin') return true;
  return process.platform === 'win32'
    && typeof app.getLoginItemSettings === 'function'
    && typeof app.setLoginItemSettings === 'function';
}

// ── macOS ─────────────────────────────────────────────────────────────────────
// Electron 的 setLoginItemSettings 在 macOS 上只注册当前 app bundle 本体：
// `path` / `args` 两个字段在官方类型定义里标注为 win32 only，开发态用它只会把
// 「Electron.app」本身登记成登录项，开机拉起一个不带参数的 Electron，本项目代码
// 不会加载。所以只有打包成 .app 才走原生登录项，开发态交给
// backend/mac-login-item.js 写 LaunchAgent（ProgramArguments 里写死可执行文件 +
// 项目路径）。两条路的「已开启」判据不同，必须成套切换，不能只切一边。
function macAutoLaunchNative() {
  return process.platform === 'darwin' && app.isPackaged === true
    && typeof app.getLoginItemSettings === 'function'
    && typeof app.setLoginItemSettings === 'function';
}

function macAutoLaunchArgs() {
  // 打包态启动的是 app 本体，不需要额外参数；开发态要把项目路径传给 Electron。
  return app.isPackaged ? [] : [app.getAppPath()];
}

function macAutoLaunchStatus() {
  if (macAutoLaunchNative()) {
    try {
      const settings = app.getLoginItemSettings();
      // macOS 13+ 会把新登记的登录项挂成「待批准」，用户要去系统设置里放行，
      // 此时 openAtLogin 已经是 true 但实际不会生效，必须单独报出来。
      return {
        supported: true,
        enabled: !!settings.openAtLogin,
        stale: false,
        error: settings.status === 'requires-approval' ? 'requires-approval' : null,
      };
    } catch {
      return { supported: true, enabled: false, stale: false, error: 'read' };
    }
  }
  try {
    return macLoginItem.readStatus({
      appId: BRAND.appId,
      execPath: process.execPath,
      args: macAutoLaunchArgs(),
    });
  } catch {
    return { supported: true, enabled: false, stale: false, error: 'read' };
  }
}

function getAutoLaunchStatus() {
  if (process.platform === 'darwin') return macAutoLaunchStatus();
  if (!autoLaunchSupported()) return { supported: false, enabled: false, error: null };
  try {
    const settings = app.getLoginItemSettings(autoLaunchMatchOptions());
    // Windows can report openAtLogin=false when the registered path/args do
    // not exactly match the current process. executableWillLaunchAtLogin is
    // the reliable answer to whether this executable will run at login.
    const enabled = process.platform === 'win32'
      ? !!settings.executableWillLaunchAtLogin
      : !!settings.openAtLogin;
    return { supported: true, enabled, error: null };
  } catch {
    return { supported: true, enabled: false, error: 'read' };
  }
}

function setAutoLaunch(enabled) {
  const desired = !!enabled;
  if (process.platform === 'darwin') {
    if (macAutoLaunchNative()) {
      try {
        app.setLoginItemSettings({ openAtLogin: desired });
      } catch {
        return { ...getAutoLaunchStatus(), ok: false, error: 'write' };
      }
      const status = getAutoLaunchStatus();
      refreshTrayMenu();
      // 「待批准」不算成功：登记写进去了，但用户没放行前不会真的自启。
      return { ...status, ok: !status.error && status.enabled === desired };
    }
    try {
      const result = desired
        ? macLoginItem.enable({
          appId: BRAND.appId,
          execPath: process.execPath,
          args: macAutoLaunchArgs(),
        })
        : macLoginItem.disable({ appId: BRAND.appId });
      refreshTrayMenu();
      return { ...result, ok: !result.error && result.enabled === desired };
    } catch {
      return { ...getAutoLaunchStatus(), ok: false, error: 'write' };
    }
  }
  if (!autoLaunchSupported()) return { supported: false, enabled: false, ok: false, error: 'unsupported' };
  try {
    app.setLoginItemSettings(autoLaunchSettings(desired));
    // Older development builds used a placeholder AppUserModelId as the Run
    // value name. Removing that exact legacy entry prevents Windows from still
    // launching the same executable after the current entry has been disabled.
    for (const name of LEGACY_AUTO_LAUNCH_NAMES) {
      app.setLoginItemSettings(autoLaunchSettings(false, name));
    }
  } catch {
    return { ...getAutoLaunchStatus(), ok: false, error: 'write' };
  }
  const status = getAutoLaunchStatus();
  refreshTrayMenu();
  return { ...status, ok: !status.error && status.enabled === desired };
}

function getXiabanSchedule() {
  const times = config.get().xiabanTimes || config.DEFAULT_XIABAN_TIMES;
  return {
    lunch: times.lunch,
    evening: times.evening,
  };
}

function setXiabanSchedule(schedule) {
  const current = getXiabanSchedule();
  if (!schedule || !config.isClockTime(schedule.lunch) || !config.isClockTime(schedule.evening)) {
    return { ok: false, schedule: current, error: 'invalid' };
  }
  const next = { lunch: schedule.lunch, evening: schedule.evening };
  const saved = config.save({ xiabanTimes: next });
  const actual = saved && saved.xiabanTimes ? {
    lunch: saved.xiabanTimes.lunch,
    evening: saved.xiabanTimes.evening,
  } : current;
  const ok = actual.lunch === next.lunch && actual.evening === next.evening;
  if (ok) sendPet(IPC.XIABAN_SCHEDULE, actual);
  return { ok, schedule: actual, error: ok ? null : 'write' };
}

function setPrivacyMode(enabled) {
  const saved = config.save({ privacyMode: enabled === true });
  const actual = saved && saved.privacyMode === true;
  refreshTrayMenu();
  publishPrivacyState(actual);
  if (core) emitStats();
  return actual;
}

function getChipDisplay() {
  const { showCat, showStatus, showTokens, showCost, quotaAgents } = config.get();
  return { showCat, showStatus, showTokens, showCost, quotaAgents: { ...quotaAgents } };
}

  // 手填「每期积分总量」并落盘。monthly 传成非正数/空 = 清掉这一项 —— 清掉之后
// 托盘与展示栏仍保留这个 Agent 的行，只是不显示「剩余」（0 会被读成额度用完了）。
//
// 刻意按数据源**合并**而不是整表覆盖：将来多个 agent 都要手填时，改其中一个
// 不会把另一个的额度抹掉。
function setCreditQuota(payload) {
  const id = payload && typeof payload.sourceId === 'string' ? payload.sourceId : '';
  if (!supportsCreditQuota(id)) return { ok: false, error: 'unknown-source' };
  const quota = { ...(config.get().creditQuota || {}) };
  const monthly = Number(payload && payload.monthly);
  if (Number.isFinite(monthly) && monthly > 0) {
    quota[id] = { monthly, resetDay: creditCycle.clampResetDay(payload && payload.resetDay) };
  } else {
    delete quota[id];
  }
  config.save({ creditQuota: Object.keys(quota).length ? quota : null });
  refreshTrayMenu();
  emitStats();
  return { ok: true, agents: trayAgents() };
}

function quotaStatusLabel(quota) {
  if (quota.status === 'ready') return t('tray.quotaStatusReady');
  if (quota.status === 'connecting') return t('tray.quotaStatusConnecting');
  if (quota.error === 'codex-not-found') return t('tray.quotaStatusCodexMissing');
  if (quota.error === 'not-signed-in') return t('tray.quotaStatusSignedOut');
  if (quota.error === 'chatgpt-account-required') return t('tray.quotaStatusChatgptRequired');
  return t('tray.quotaStatusUnavailable');
}

// 缓存「哪些工具被检测到」，但**不**缓存用量数字 —— 用量是内存里的现成结果，
// 取一次几乎零成本，而集成检测要读若干配置文件。托盘的刷新触发点包含 Codex
// 额度的每次状态变化，没必要每次都去摸一遍磁盘。
const DETECTED_TTL_MS = 15000;
let detectedCache = { at: 0, ids: new Set() };

function detectedSourceIds() {
  const now = Date.now();
  if (now - detectedCache.at < DETECTED_TTL_MS) return detectedCache.ids;
  try {
    const ids = new Set(
      currentIntegrationHealth().integrations.filter((row) => row.detected).map((row) => row.id),
    );
    detectedCache = { at: now, ids };
    return ids;
  } catch {
    return detectedCache.ids;
  }
}

// 每个**检测到**的 Agent 一份账面，托盘 / 底部展示栏 / 设置页三处共用。
//
// 口径（2026-09-15 用户定的）：
//   · 检测到就算「有效」—— 不再按「今天有没有用量」过滤，位置从此固定
//   · 顺序固定按注册表，不排序 —— 行不会跳来跳去
//   · 不截断 —— 有几个显示几个
//   · 不再有「额度槽位归谁」这个概念 —— 每个 Agent 显示自己的额度，
//     所以设置页写 Codex 而托盘写 WorkBuddy 这种东西不会再出现
//
// 剩余额度由用户手填的每期总量减去本机已用得出 —— WorkBuddy 的余额只在服务端，
// 本机拿不到（详见交接报告「第四轮」），所以只能这样反推。
// Codex 的额度是它自己的接口给的，不需要手填。
function trayAgentRows() {
  const meters = meterStats();
  const detected = detectedSourceIds();
  const quota = config.get().creditQuota || {};
  const codexQuota = codexQuotaBundle();
  return withSourceValues(meters).map(({ id, label, value }) => {
    const today = (value && value.today) || {};
    const lifetime = (value && value.lifetime) || {};
    const configured = quota[id];
    // 本期已用从计量台账的按日分桶求和（本地自然日，保留 95 天，见
    // backend/credit-cycle.js）。没填额度时 remaining 为 null。
    const cycle = configured
      ? creditCycle.sumCycleCredit(value && value.daily, Date.now(), configured.resetDay)
      : null;
    return {
      id,
      label,
      detected: detected.has(id),
      tokens: today.tokens,
      cost: today.cost,
      credit: today.credit,
      lifetimeTokens: lifetime.tokens,
      lifetimeCredit: lifetime.credit,
      quota: id === 'codex'
        ? codexQuota
        : supportsCreditQuota(id)
          ? {
            kind: 'credit',
            ready: !!configured,
            remaining: cycle ? creditCycle.remainingQuota(configured.monthly, cycle.used) : null,
            today: Number(today.credit) || 0,
            cycleUsed: cycle ? cycle.used : null,
            monthly: configured ? configured.monthly : null,
            resetDay: configured ? configured.resetDay : null,
            cycleStart: cycle ? cycle.startKey : null,
          }
          : null,
    };
  });
}

// Codex 的额度包。注意「检测到但额度没到手」也要返回 —— 有效 Agent 必须在
// 托盘/设置页各占一格，不能因为暂时没数字就整格消失（这是之前最容易看出的
// 不一致：设置页写着 Codex，托盘里却什么都找不到）。
function codexQuotaBundle() {
  if (!codexDetected()) return null;
  const ready = codexQuotaState.status === 'ready';
  const windows = codexQuotaState.windows || {};
  return {
    kind: 'codex',
    ready,
    status: ready ? null : quotaStatusLabel(codexQuotaState),
    // 托盘一行只要 `5h 82%` 这样的压缩片段；完整形态渲染端本来就有 stats.codexQuota
    windows: ready
      ? [['fiveHour', '5h'], ['weekly', '7d']]
        .map(([key, label]) => ({ label, percent: Number(windows[key] && windows[key].remainingPercent) }))
        .filter((w) => Number.isFinite(w.percent))
      : [],
  };
}

// 「托盘/底部展示栏要不要显示这个 Agent 的额度」。缺省放行，只有显式 false 才关。
function quotaAgentEnabled(id) {
  const map = config.get().quotaAgents || {};
  return map[id] !== false;
}

// 给托盘的入参：只留检测到的，其余字段照原样带过去。
function trayAgents() {
  return trayAgentRows().filter((row) => row.detected).map((row) => ({
    ...row,
    enabled: quotaAgentEnabled(row.id),
  }));
}

function refreshTrayMenu() {
  if (!tray) return;
  const privacyMode = config.get().privacyMode === true;
  const baseTooltip = t(privacyMode ? 'tray.tooltipPrivate' : 'tray.tooltip');
  tray.setToolTip(baseTooltip);
  const petVisible = !!(mergedWin && !mergedWin.isDestroyed() && mergedWin.isVisible());
  const items = [
    // 每个检测到的 Agent 一段；段内超宽在片段边界折行，看细节去详情面板。
    ...trayStatus.buildStatusRows({ agents: trayAgents(), t }),
    { type: 'separator' },
    { label: t('tray.panel'), click: () => openPanel() },
    { label: petVisible ? t('tray.hidePet') : t('tray.showPet'), click: () => (petVisible ? hidePet() : showPet()) },
    { type: 'separator' },
    { label: t('tray.settings'), click: () => openSettings() },
    { type: 'separator' },
    { label: t('tray.quit'), click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
// 多实例防护（对齐 clawd-on-desk 的处理）：
//  1) Electron 实例锁：同一份 app 重复启动 → 新实例静默退出；
//  2) 启动探测：候选端口上已有同身份 server 在跑（多为另一份代码副本）→ 提示并退出；
//  3) server.js 里的 runtime 守护：存活期间 runtime.json 被别的副本覆盖 → 抢回。
// 开发需要多开时用 WORKMEOW_ALLOW_MULTI=1 跳过 1/2。
const allowMulti = env.flag('ALLOW_MULTI');

// 并行探测所有候选端口，找到任一存活的同身份 server 就返回其端口
function findRivalInstance() {
  if (allowMulti) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = transport.PORTS.length;
    let found = null;
    for (const p of transport.PORTS) {
      transport.probe(p, 600, (ok) => {
        if (ok && found === null) found = p;
        if (--pending === 0) resolve(found);
      });
    }
  });
}

const gotTheLock = allowMulti ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => { try { for (const st of petStates()) st.win.show(); } catch {} });
  app.whenReady().then(async () => {
    const rival = await findRivalInstance();
    if (rival) {
      dialog.showErrorBox(
        t('dlg.dupTitle'),
        t('dlg.dupBody', { port: rival }) + t('dlg.dupHint')
      );
      app.quit();
      return;
    }
    migrateLegacyState();
    // Windows 靠每个窗口的 skipTaskbar 从任务栏隐身，但 mac 的 Dock 图标是
    // 「整个 app 一个」，skipTaskbar 在这里是 no-op。桌宠是托盘常驻程序，Dock 里
    // 留一个图标既不像桌宠、也会让 window-all-closed 之后看起来像卡死的空壳。
    // 放在建窗之前，避免图标先闪一下再消失。退出入口仍在托盘菜单里。
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.hide(); } catch {}
    }
    // Rewrite legacy config once so removed appearance/layout/budget fields disappear
    // from ~/.workmeow/config.json instead of remaining as dead state.
    config.save({});
    registerPetAssetProtocol();
    registerIpc();
    bootBackend();
    createPetWindows();
    try { buildTray(); } catch {}
    initUpdateService();
  });
}

app.on('window-all-closed', () => { /* tray app: stay alive */ });

app.on('before-quit', () => {
  try { if (quotaAlertTimer) clearTimeout(quotaAlertTimer); } catch {}
  try { if (codexWatch) codexWatch.stop(); } catch {}
  try { if (codexRateLimits) codexRateLimits.stop(); } catch {}
  try { if (traeWatch) traeWatch.stop(); } catch {}
  try { if (stopWatcher) stopWatcher(); } catch {}
  try { if (permissions) permissions.cleanup(); } catch {}
  try { if (server) server.stop(); } catch {}
  try { if (metering) metering.stop(); } catch {}
  try { if (codexMetering) codexMetering.stop(); } catch {}
  try { if (workbuddyMetering) workbuddyMetering.stop(); } catch {}
  try { if (traeMetering) traeMetering.stop(); } catch {}
  try { if (opencodeMetering) opencodeMetering.stop(); } catch {}
  try { if (pricingSync) pricingSync.stop(); } catch {}
  try { if (core) core.stopStaleCleanup(); } catch {}
});
