'use strict';

// WorkBuddy 当前会话的上下文水位（严格只读）。
//
// 数据在 ~/.workbuddy/workbuddy.db 的 session_usage 表。字段语义来自 WorkBuddy
// 内核源码 packages/workbuddy-core/src/conversations/node/persistence/
// sqlite-conversation-usage-port.ts（2026-09 在本机 app.asar 内逐字段核对）：
//   used        = usage.totalTokens      本次请求结束后已占用的上下文 token 数
//   size        = usage.contextWindow    该模型的上下文窗口
//   credit_json = { [requestId]: 累加的 usage.cost.amount }   ← 就是「积分」
//
// 这里只取最近更新的那一条，也就是用户当前正在用的会话的上下文水位 —— 托盘里
// 这一行比「历史累计」更能指导下一步动作（快满了就该收尾或者开新会话）。
//
// node:sqlite 是 Node 22.5+ 才有的 experimental 模块，Electron 43 内核为
// node 24.18.1，本机实测可用。加载不到（老内核、模块被裁掉）或数据库被独占时
// 一律返回 null 降级：托盘少一行，不影响其它任何功能。
//
// 注意：只用 SELECT，不开事务、不 checkpoint、不写。避免和 WorkBuddy 自己的连接
// 抢锁，也不要在这里触发任何会改动用户数据的行为。

const os = require('os');
const path = require('path');

const DEFAULT_DB = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
const DEFAULT_TTL_MS = 15000;

let cache = { at: 0, file: null, value: null };

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function openReadOnly(file) {
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch {
    return null;
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') return null;
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

function queryLatestSession(db) {
  const statement = db.prepare(
    'SELECT session_id, used, size, updated_at FROM session_usage'
    + ' ORDER BY updated_at DESC LIMIT 1',
  );
  const row = statement.get();
  if (!row) return null;
  const used = num(row.used);
  const size = num(row.size);
  if (size <= 0) return null;
  return {
    sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    used,
    size,
    updatedAt: num(row.updated_at),
    title: null,
  };
}

// 标题单独查、单独兜错：sessions 表的列在 WorkBuddy 各版本间变动过，标题取不到
// 不能让整行数据一起丢掉。
function queryTitle(db, sessionId) {
  if (!sessionId) return null;
  try {
    const row = db.prepare(
      'SELECT title, custom_title FROM sessions WHERE id = ? LIMIT 1',
    ).get(sessionId);
    if (!row) return null;
    const custom = typeof row.custom_title === 'string' ? row.custom_title.trim() : '';
    const plain = typeof row.title === 'string' ? row.title.trim() : '';
    return custom || plain || null;
  } catch {
    return null;
  }
}

function readWorkbuddySession(options = {}) {
  const file = options.dbPath || DEFAULT_DB;
  const now = Date.now();
  const ttl = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  // 缓存必须带上库路径：进程内只有一个真实库，但测试会指向临时库，只按时间缓存
  // 会串味。
  if (!options.noCache && cache.file === file && now - cache.at < ttl) return cache.value;

  let db = null;
  let value = null;
  try {
    db = openReadOnly(file);
    if (db) {
      value = queryLatestSession(db);
      if (value) value.title = queryTitle(db, value.sessionId);
    }
  } catch {
    value = null;
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }

  cache = { at: now, file, value };
  return value;
}

function resetCache() {
  cache = { at: 0, file: null, value: null };
}

module.exports = { DEFAULT_DB, readWorkbuddySession, resetCache };
