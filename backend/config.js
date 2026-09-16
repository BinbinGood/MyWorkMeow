'use strict';

// Persisted app config. The pet is intentionally fixed to the Salary Cat
// renderer; only lightweight display preferences are persisted here.
// Stored atomically under ~/.workmeow/config.json.

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./paths');
const { clampResetDay } = require('./credit-cycle');
const { SOURCE_IDS } = require('./source-registry');

const CONFIG_DIR = STATE_DIR;
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const DEFAULT_XIABAN_TIMES = Object.freeze({
  lunch: '10:55',
  evening: '16:55',
});

const DEFAULTS = Object.freeze({
  petPosition: null,      // {x,y} | null
  onboardingVersion: 0,  // portable integration summary shown once
  hooksEnabled: true,
  autoUpdateEnabled: true,
  privacyMode: false,
  showCat: true,
  showStatus: true,
  showTokens: false,
  showCost: true,
  // 「哪个 Agent 的额度要出现在底部展示栏 / 托盘」—— 按 Agent 逐个开关。
  // 以前这里是一个布尔 showQuota + 一个会动态改名的「额度槽位」：设置页写
  // Codex、托盘却写 WorkBuddy，看起来自相矛盾。2026-09-15 改成每个检测到
  // 的 Agent 各一个开关，有几个有效的就有几个按钮，位置从此固定。
  //   { workbuddy: true, codex: false }
  // 缺省（没写）= 打开。只有显式 false 才是关掉。
  quotaAgents: {},
  // macOS 屏幕顶部菜单栏（Tray.setTitle）显示哪些片段。形状故意和底部展示栏
  // 一一对应（用户原话「仿照喵底部栏」），不新造概念。
  // 只有 showStatus 默认开：菜单栏预算 16 列，默认全开会立刻超宽被裁尾。
  // 「显示哪个 Agent 的额度」不在这里 —— 复用上面的 quotaAgents，一处开关两处生效。
  menuBar: { showStatus: true, showQuota: false, showTokens: false, showCost: false },
  xiabanTimes: DEFAULT_XIABAN_TIMES,
  // 按数据源手填的「每期积分总量」，用于反推剩余额度：
  //   { workbuddy: { monthly: 3600, resetDay: 1 } }
  // null 表示一个都没填 —— 此时托盘不显示「剩余」那一段（不是显示 0）。
  creditQuota: null,
});

const MENU_BAR_KEYS = Object.freeze(['showStatus', 'showQuota', 'showTokens', 'showCost']);
const DEFAULT_MENU_BAR = DEFAULTS.menuBar;

let cache = null;

function isClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitize(raw) {
  // quotaAgents / menuBar 都是**可变**的对象，必须每次新建 —— DEFAULTS 顶层
  // Object.freeze 冻不住里面的对象，直接展开会把用户的开关写回默认值，跨实例串味。
  const out = {
    ...DEFAULTS,
    xiabanTimes: { ...DEFAULT_XIABAN_TIMES },
    quotaAgents: {},
    menuBar: { ...DEFAULT_MENU_BAR },
  };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
  }
  if (Number.isInteger(raw.onboardingVersion) && raw.onboardingVersion >= 0) {
    out.onboardingVersion = raw.onboardingVersion;
  }
  if (typeof raw.hooksEnabled === 'boolean') out.hooksEnabled = raw.hooksEnabled;
  if (typeof raw.autoUpdateEnabled === 'boolean') out.autoUpdateEnabled = raw.autoUpdateEnabled;
  if (typeof raw.privacyMode === 'boolean') out.privacyMode = raw.privacyMode;
  for (const key of ['showCat', 'showStatus', 'showTokens', 'showCost']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  // showQuota 是 2026-09-15 之前的老键。迁移：老配置里若明确关掉过额度，
  // 就把它当作「全部 Agent 都关」，避免升级后用户之前关掉的东西自己亮回来。
  if (typeof raw.showQuota === 'boolean') {
    for (const id of SOURCE_IDS) out.quotaAgents[id] = raw.showQuota;
  }
  if (raw.quotaAgents && typeof raw.quotaAgents === 'object' && !Array.isArray(raw.quotaAgents)) {
    for (const [id, enabled] of Object.entries(raw.quotaAgents)) {
      if (!id || typeof enabled !== 'boolean') continue;
      out.quotaAgents[id] = enabled;
    }
  }
  if (raw.menuBar && typeof raw.menuBar === 'object' && !Array.isArray(raw.menuBar)) {
    for (const key of MENU_BAR_KEYS) {
      if (typeof raw.menuBar[key] === 'boolean') out.menuBar[key] = raw.menuBar[key];
    }
  }
  if (raw.creditQuota && typeof raw.creditQuota === 'object' && !Array.isArray(raw.creditQuota)) {
    const quota = {};
    for (const [id, row] of Object.entries(raw.creditQuota)) {
      if (!id || !row || typeof row !== 'object') continue;
      // monthly 必须是正有限数；写 0 或负数等同于「没配」，直接丢掉这一项，
      // 好过留下一个会让托盘显示「剩余 0」的假额度。清空额度走 save(null)。
      const monthly = Number(row.monthly);
      if (!Number.isFinite(monthly) || monthly <= 0) continue;
      quota[id] = { monthly, resetDay: clampResetDay(row.resetDay) };
    }
    out.creditQuota = Object.keys(quota).length ? quota : null;
  }
  if (raw.xiabanTimes && isClockTime(raw.xiabanTimes.lunch) && isClockTime(raw.xiabanTimes.evening)) {
    out.xiabanTimes = {
      lunch: raw.xiabanTimes.lunch,
      evening: raw.xiabanTimes.evening,
    };
  }
  return out;
}

// 读不到/坏了 → 走 sanitize({}) 而不是 `{ ...DEFAULTS }`：后者的 quotaAgents /
// menuBar / xiabanTimes 是**和 DEFAULTS 共享的同一个对象**（顶层 freeze 冻不住
// 内嵌对象），谁往里写一下就污染了全进程的默认值。
function readDisk() {
  try {
    const value = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
    return value;
  } catch { return sanitize({}); }
}

function load() {
  if (!cache) cache = readDisk();
  return cache;
}

function save(partial) {
  // Another process can toggle integrations while the app is running. Merge
  // against disk, not the in-process cache, so a later window-position save
  // cannot silently re-enable hooks that the CLI just uninstalled.
  cache = sanitize({ ...readDisk(), ...partial });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const tmp = path.join(CONFIG_DIR, `.config.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } catch {}
  return cache;
}

function get() { return load(); }
function reload() { cache = readDisk(); return cache; }

module.exports = {
  get, reload, save, sanitize, CONFIG_PATH, DEFAULTS, DEFAULT_XIABAN_TIMES, isClockTime,
};
