'use strict';

// WorkBuddy 的「任务名」= 会话标题。
//
// 为什么必须动它的库：
//   • WorkBuddy 的 hook payload 里**没有标题字段**（见 cli/dist/codebuddy.js 的
//     convertToSdkInput：只有 session_id / transcript_path / cwd / tool_name /
//     tool_input …），所以 hook 端无论怎么努力都拿不到你在界面上看到的那个名字；
//   • 它的 transcript 也不是 Claude Code 那套（没有 custom-title / agent-name 记录），
//     我们原来的 transcript.sessionTitle() 对 WorkBuddy 恒为 null，于是标签只能退到
//     cwd 目录名 —— 而 WorkBuddy 每个任务会给一个按时间命名的独立目录
//     （…/WorkBuddy/2026-09-15-20-00-26），列表里看到的就是一串时间戳，
//     根本认不出是哪个任务。
//
// 唯一的权威来源是它自己的会话库：~/.workbuddy/workbuddy.db 的
// sessions(id, title, custom_title)。所以这里只读打开它取标题。
//
// 安全与降级：readOnly 打开（库是 WAL，只读连接不写它）；任何异常
// （库不存在 / 被占用 / 表结构变了 / Node 没有 node:sqlite）一律当作「查不到」，
// 调用方回落到原来那套（transcript 标题 → cwd 目录名），绝不让桌宠因此报错。

const fs = require('fs');
const os = require('os');
const path = require('path');

const TITLE_MAX = 80;
// 标题很少变，但用户随时可能改名 —— 60s 足够跟上，又不至于每帧都查库。
const DEFAULT_TTL_MS = 60 * 1000;
// 查不到（新会话还没起名）时用一个更短的负缓存，别每帧重查。
const MISS_TTL_MS = 20 * 1000;
// 库打不开（没装 WorkBuddy / 结构变了）后别每次都试，过一会儿再试一次。
const FAIL_RETRY_MS = 5 * 60 * 1000;
const CACHE_MAX = 500;
const CONTROL_RE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+', 'g');

let sqliteModule = null;
let sqliteProbed = false;

// Node 22.5+ 才有 node:sqlite；Electron 43 自带 Node 24，所以运行时一定有它。
// 但测试/老运行时可能没有 —— 探测一次，没有就永久降级。
function loadSqlite() {
  if (sqliteProbed) return sqliteModule;
  sqliteProbed = true;
  try { sqliteModule = require('node:sqlite'); } catch { sqliteModule = null; }
  return sqliteModule;
}

function defaultDbPath() {
  return path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
}

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const norm = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  return norm.length > TITLE_MAX ? norm.slice(0, TITLE_MAX) + '…' : norm;
}

function createTitles(options = {}) {
  // dbPath 直接给整条路径（测试用）；workbuddyDir 给 WorkBuddy 的家目录
  // （WORKMEOW_WORKBUDDY_DIR，与 projects/ 用量台账同一处）。
  const file = typeof options.dbPath === 'string' && options.dbPath
    ? options.dbPath
    : (typeof options.workbuddyDir === 'string' && options.workbuddyDir
      ? path.join(options.workbuddyDir, 'workbuddy.db')
      : defaultDbPath());
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
  const cache = new Map(); // session id → { title, until }
  let db = null;
  let stmt = null;
  let retryAfter = 0;

  function close() {
    try { if (db) db.close(); } catch {}
    db = null;
    stmt = null;
  }

  function open() {
    if (db) return db;
    // 读不到库不是错误，只是「这个环境没有 WorkBuddy」——记一个重试时间就行，
    // 免得每个会话每 60s 都去 stat 一次不存在的文件。
    if (Date.now() < retryAfter) return null;
    const mod = loadSqlite();
    if (!mod || typeof mod.DatabaseSync !== 'function') { retryAfter = Date.now() + FAIL_RETRY_MS; return null; }
    try {
      if (!fs.existsSync(file)) { retryAfter = Date.now() + FAIL_RETRY_MS; return null; }
      db = new mod.DatabaseSync(file, { readOnly: true });
      // custom_title 是用户自己改的名字，优先于自动生成的 title（与界面一致）。
      stmt = db.prepare('select title, custom_title from sessions where id = ?');
      return db;
    } catch {
      close();
      retryAfter = Date.now() + FAIL_RETRY_MS;
      return null;
    }
  }

  function query(sessionId) {
    if (!open() || !stmt) return null;
    try {
      const row = stmt.get(sessionId);
      if (!row) return null;
      return cleanTitle(row.custom_title) || cleanTitle(row.title);
    } catch {
      // 库被换掉/锁住/表结构变了 —— 关掉重来，这一轮当作查不到。
      close();
      retryAfter = Date.now() + FAIL_RETRY_MS;
      return null;
    }
  }

  function lookup(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
    const id = sessionId.trim();
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && now < hit.until) return hit.title;
    const title = query(id);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(id, { title, until: now + (title ? ttlMs : MISS_TTL_MS) });
    return title;
  }

  // 给 core 的快照补上 sessionTitle。**覆盖**已有的值：hook 端每轮都会拿用户
  // 新输入的第一行当标题，那个名字会一轮一变；库里这个名字才是界面上那个稳定的
  // 任务名。查不到（非 WorkBuddy 会话 / 还没起名）就不动，交给原来的回落链。
  function attach(sessions) {
    if (!Array.isArray(sessions)) return 0;
    let n = 0;
    for (const s of sessions) {
      if (!s || typeof s.id !== 'string') continue;
      const title = lookup(s.id);
      if (title && s.sessionTitle !== title) { s.sessionTitle = title; n++; }
    }
    return n;
  }

  return { lookup, attach, close, dbPath: file };
}

module.exports = { createTitles, defaultDbPath, cleanTitle, TITLE_MAX };
