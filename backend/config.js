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
  // 「哪个 Agent 要出现在底部展示栏（额度徽标）」——按 Agent 逐个开关。
  //   { workbuddy: true, codex: false }
  // 缺省（没写）= 打开。只有显式 false 才是关掉。
  quotaAgents: {},
  // 「哪个 Agent 要出现在托盘弹出菜单（那一行信息）」——2026-09-16 从 quotaAgents
  // 拆出来，两个各自独立。之前一组开关同时管底部栏和托盘，用户要分开控制。
  // 升级迁移：trayAgents 没写过时，用 quotaAgents 作初值（见 sanitize）。
  trayAgents: {},
  xiabanTimes: DEFAULT_XIABAN_TIMES,
  // 按数据源手填的「每期积分总量」，用于反推剩余额度：
  //   { workbuddy: { monthly: 3600, resetDay: 1 } }
  // null 表示一个都没填 —— 此时托盘不显示「剩余」那一段（不是显示 0）。
  creditQuota: null,
});

let cache = null;

function isClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function sanitize(raw) {
  // quotaAgents 是**可变**的对象，必须每次新建 —— DEFAULTS 顶层
  // Object.freeze 冻不住里面的对象，直接展开会把用户的开关写回默认值，跨实例串味。
  const out = {
    ...DEFAULTS,
    xiabanTimes: { ...DEFAULT_XIABAN_TIMES },
    quotaAgents: {},
    trayAgents: {},
  };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.petPosition && Number.isFinite(raw.petPosition.x) && Number.isFinite(raw.petPosition.y)) {
    // w = 存盘那一刻的窗口帧宽。猫在窗口里居中，窗内偏移 = (帧宽-猫宽)/2，所以
    // 只存原点、不存帧宽的话，重建窗口（帧宽 320）时猫会相对存盘时（帧宽 520）
    // 左移 100px，越开越偏。老配置没有 w，main.js 按 BASE_W 兜底。
    out.petPosition = { x: Math.round(raw.petPosition.x), y: Math.round(raw.petPosition.y) };
    if (Number.isFinite(raw.petPosition.w) && raw.petPosition.w > 0) {
      out.petPosition.w = Math.round(raw.petPosition.w);
    }
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
  // 它当时同时管底部栏和托盘，所以两个都写。
  if (typeof raw.showQuota === 'boolean') {
    for (const id of SOURCE_IDS) {
      out.quotaAgents[id] = raw.showQuota;
      out.trayAgents[id] = raw.showQuota;
    }
  }
  if (raw.quotaAgents && typeof raw.quotaAgents === 'object' && !Array.isArray(raw.quotaAgents)) {
    for (const [id, enabled] of Object.entries(raw.quotaAgents)) {
      if (!id || typeof enabled !== 'boolean') continue;
      out.quotaAgents[id] = enabled;
    }
  }
  // trayAgents 是 2026-09-16 新增的独立开关。升级迁移：只要用户还没显式写过它，
  // 就用 quotaAgents 作初值 —— 保证「之前关掉的托盘行」不会在升级后自己亮回来。
  // 一旦用户动过 trayAgents，它就落盘成独立值，此后不再跟 quotaAgents 联动。
  if (raw.trayAgents && typeof raw.trayAgents === 'object' && !Array.isArray(raw.trayAgents)) {
    for (const [id, enabled] of Object.entries(raw.trayAgents)) {
      if (!id || typeof enabled !== 'boolean') continue;
      out.trayAgents[id] = enabled;
    }
  } else {
    out.trayAgents = { ...out.quotaAgents };
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
// xiabanTimes 是**和 DEFAULTS 共享的同一个对象**（顶层 freeze 冻不住
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
