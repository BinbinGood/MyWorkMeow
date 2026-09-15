'use strict';

// Regression test for backend/workbuddy-session.js —— 当前会话的上下文水位。
//
// 全程用临时 sqlite 库，不碰真实的 ~/.workbuddy/workbuddy.db。node:sqlite 是
// experimental 模块，取不到时整条链路降级为 null —— 这个测试也要能优雅跳过，
// 不能因为运行环境没有它就把 CI 判红。

const fs = require('fs');
const os = require('os');
const path = require('path');

const session = require('../backend/workbuddy-session');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

function loadSqlite() {
  try {
    const sqlite = require('node:sqlite');
    return typeof sqlite.DatabaseSync === 'function' ? sqlite : null;
  } catch {
    return null;
  }
}

function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-session-'));
  const sqlite = loadSqlite();

  // 文件不存在 / 打不开：必须返回 null 而不是抛错
  session.resetCache();
  assert(session.readWorkbuddySession({ dbPath: path.join(base, 'nope.db'), noCache: true }) === null,
    'a missing database degrades to null');
  assert(session.readWorkbuddySession({ dbPath: base, noCache: true }) === null,
    'a directory path degrades to null');
  assert(session.DEFAULT_DB.endsWith(path.join('.workbuddy', 'workbuddy.db')),
    'the default database path is ~/.workbuddy/workbuddy.db');

  if (!sqlite) {
    // 环境没有 node:sqlite（老内核）：主进程侧会一直拿到 null，托盘少一行。
    console.log('skip - node:sqlite unavailable, skipping the query assertions');
    fs.rmSync(base, { recursive: true, force: true });
    console.log('\nWORKBUDDY SESSION TESTS PASSED (degraded)');
    return;
  }

  const file = path.join(base, 'workbuddy.db');
  const db = new sqlite.DatabaseSync(file);

  // 只有 session_usage、没有 sessions 表：上下文照样读得到，标题为 null。
  db.exec('CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used INTEGER NOT NULL,'
    + ' size INTEGER NOT NULL, updated_at INTEGER NOT NULL, credit_json TEXT)');
  db.exec("INSERT INTO session_usage VALUES ('s-old', 1000, 200000, 100, NULL)");
  db.exec("INSERT INTO session_usage VALUES ('s-new', 219254, 300000, 500, '{}')");
  db.close();

  session.resetCache();
  const noTitles = session.readWorkbuddySession({ dbPath: file, noCache: true });
  assert(noTitles && noTitles.sessionId === 's-new', 'the most recently updated session wins');
  assert(noTitles.used === 219254 && noTitles.size === 300000, 'used/size are read verbatim');
  assert(noTitles.title === null, 'a missing sessions table only costs the title');

  // 补上 sessions 表：custom_title 优先于 title
  const db2 = new sqlite.DatabaseSync(file);
  db2.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT)');
  db2.exec("INSERT INTO sessions VALUES ('s-new', '先列计划再开始干活', '')");
  db2.exec("INSERT INTO sessions VALUES ('s-old', '旧会话', '自定义标题')");
  db2.close();

  session.resetCache();
  const labelled = session.readWorkbuddySession({ dbPath: file, noCache: true });
  assert(labelled.title === '先列计划再开始干活', 'an empty custom_title falls back to title');

  const db3 = new sqlite.DatabaseSync(file);
  db3.exec("UPDATE sessions SET custom_title = '自定义标题' WHERE id = 's-new'");
  db3.close();
  session.resetCache();
  assert(session.readWorkbuddySession({ dbPath: file, noCache: true }).title === '自定义标题',
    'custom_title wins when present');

  // 缓存：TTL 内返回旧值，resetCache 后重新读；不同库路径不能互相串味。
  session.resetCache();
  const first = session.readWorkbuddySession({ dbPath: file, ttlMs: 60000 });
  const db4 = new sqlite.DatabaseSync(file);
  db4.exec('UPDATE session_usage SET used = 1 WHERE session_id = \'s-new\'');
  db4.close();
  assert(session.readWorkbuddySession({ dbPath: file, ttlMs: 60000 }).used === first.used,
    'the TTL cache serves the previous value');
  assert(session.readWorkbuddySession({ dbPath: file, noCache: true }).used === 1,
    'noCache forces a fresh read');
  assert(session.readWorkbuddySession({
    dbPath: path.join(base, 'workbuddy2.db'), noCache: false, ttlMs: 60000,
  }) === null, 'the cache is keyed by database path, not only by time');
  session.resetCache();

  // 退化的数据形状：size 为 0、表为空 → null
  const db5 = new sqlite.DatabaseSync(file);
  db5.exec("UPDATE session_usage SET size = 0 WHERE session_id = 's-new'");
  db5.close();
  session.resetCache();
  assert(session.readWorkbuddySession({ dbPath: file, noCache: true }) === null,
    'a non-positive context size degrades to null');

  const db6 = new sqlite.DatabaseSync(file);
  db6.exec("UPDATE session_usage SET size = 300000 WHERE session_id = 's-new'");
  db6.exec('DELETE FROM session_usage');
  db6.close();
  session.resetCache();
  assert(session.readWorkbuddySession({ dbPath: file, noCache: true }) === null,
    'an empty session_usage table degrades to null');

  // 完全没有 session_usage 表（老版本 WorkBuddy）也不能抛
  const broken = path.join(base, 'broken.db');
  const db7 = new sqlite.DatabaseSync(broken);
  db7.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT)');
  db7.close();
  session.resetCache();
  assert(session.readWorkbuddySession({ dbPath: broken, noCache: true }) === null,
    'a database without session_usage degrades to null');

  fs.rmSync(base, { recursive: true, force: true });
  console.log('\nWORKBUDDY SESSION TESTS PASSED');
}

main();
