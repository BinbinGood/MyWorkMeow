'use strict';

// Persisted app config. The pet is intentionally fixed to the Salary Cat
// renderer; only lightweight display preferences are persisted here.
// Stored atomically under ~/.workmeow/config.json.

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./paths');
const { clampResetDay } = require('./credit-cycle');

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
  showQuota: true,
  showTokens: false,
  showCost: true,
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
  const out = { ...DEFAULTS, xiabanTimes: { ...DEFAULT_XIABAN_TIMES } };
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
  for (const key of ['showCat', 'showStatus', 'showQuota', 'showTokens', 'showCost']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
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

function readDisk() {
  try {
    const value = sanitize(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
    return value;
  } catch { return { ...DEFAULTS }; }
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
