'use strict';

// backend/workbuddy-titles.js —— 从 WorkBuddy 的会话库取任务名。
//
// 这里用真库（临时建一个 sqlite，结构与 ~/.workbuddy/workbuddy.db 的 sessions 表一致）
// 而不是打桩，因为这段代码的价值全在「真能读出来 + 读不到时不炸」：
//   • hook payload 没有标题字段 → 只能读库，读错就退化回目录名；
//   • 库随时可能不存在（没装 WorkBuddy）/被锁/表结构变了。
// Run: node test/workbuddy-titles.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTitles, cleanTitle, TITLE_MAX } = require('../backend/workbuddy-titles');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-titles-'));
const dbFile = path.join(dir, 'workbuddy.db');

function buildDb() {
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`create table sessions (
    id text primary key, cwd text, title text, custom_title text, status text,
    updated_at integer, last_activity_at integer, created_at integer
  )`);
  const ins = db.prepare('insert into sessions (id, cwd, title, custom_title, status, updated_at) values (?,?,?,?,?,?)');
  ins.run('aaaa-1111', '/Users/me/WorkBuddy/2026-09-15-20-00-26', 'Codex相关按钮显示条件', null, 'working', Date.now());
  ins.run('bbbb-2222', '/Users/me/WorkBuddy/2026-08-25-21-53-01', '重组飞书文档并生成新文档', '基础LLM及Agent', 'completed', Date.now());
  ins.run('cccc-3333', '/Users/me/proj', '   ', null, 'completed', Date.now());
  ins.run('dddd-4444', '/Users/me/proj', 'x'.repeat(200), null, 'completed', Date.now());
  db.close();
}

if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
  console.log('⚠️  当前 Node 没有 node:sqlite —— 只跑降级路径');
} else {
  buildDb();
}

console.log('[T1] 正常读取：工作区目录名 → 真实任务名');
{
  const titles = createTitles({ dbPath: dbFile });
  if (sqlite) {
    check('按 session id 取到 WorkBuddy 任务名', () => {
      assert.strictEqual(titles.lookup('aaaa-1111'), 'Codex相关按钮显示条件');
    });
    check('custom_title（用户改过的名字）优先于自动标题', () => {
      assert.strictEqual(titles.lookup('bbbb-2222'), '基础LLM及Agent');
    });
    check('空白标题当作没有', () => {
      assert.strictEqual(titles.lookup('cccc-3333'), null);
    });
    check('超长标题截断', () => {
      const t = titles.lookup('dddd-4444');
      assert.strictEqual(t.length, TITLE_MAX + 1);
      assert(t.endsWith('…'));
    });
  }
  check('查不到的会话返回 null（不抛）', () => {
    assert.strictEqual(titles.lookup('nope-9999'), null);
  });
  check('空 / 非字符串 id 直接 null', () => {
    assert.strictEqual(titles.lookup(''), null);
    assert.strictEqual(titles.lookup(null), null);
    assert.strictEqual(titles.lookup(undefined), null);
  });
  titles.close();
}

console.log('[T2] attach()：补 sessionTitle，且能覆盖每轮 prompt 的临时标题');
{
  const titles = createTitles({ dbPath: dbFile });
  const sessions = [
    { id: 'aaaa-1111', sessionTitle: '顺便把测试补了' },  // hook 每轮塞进来的临时标题
    { id: 'nope-9999', sessionTitle: '保留' },
    { id: 'bbbb-2222' },
    { id: null },
  ];
  const n = titles.attach(sessions);
  check('命中的会话被改成任务名', () => {
    assert.strictEqual(sessions[0].sessionTitle, sqlite ? 'Codex相关按钮显示条件' : '顺便把测试补了');
  });
  check('查不到的不动（回落链留给 adapter）', () => {
    assert.strictEqual(sessions[1].sessionTitle, '保留');
  });
  check('原本没有标题的会话被补上', () => {
    assert.strictEqual(sessions[2].sessionTitle, sqlite ? '基础LLM及Agent' : undefined);
  });
  check('无 id 的条目安全跳过', () => {
    assert.strictEqual(sessions[3].sessionTitle, undefined);
  });
  check('返回改动条数', () => {
    assert.strictEqual(n, sqlite ? 2 : 0);
  });
  check('非数组入参不炸', () => {
    assert.strictEqual(titles.attach(null), 0);
    assert.strictEqual(titles.attach(undefined), 0);
  });
  titles.close();
}

console.log('[T3] 降级：库不存在 / 不是库 / 目录给错都不抛');
{
  const missing = createTitles({ dbPath: path.join(dir, 'nope', 'workbuddy.db') });
  check('库不存在 → null，且不抛', () => {
    assert.strictEqual(missing.lookup('aaaa-1111'), null);
  });
  missing.close();

  const notADb = path.join(dir, 'garbage.db');
  fs.writeFileSync(notADb, 'this is not sqlite');
  const broken = createTitles({ dbPath: notADb });
  check('不是 sqlite 文件 → null，且不抛', () => {
    assert.strictEqual(broken.lookup('aaaa-1111'), null);
  });
  check('失败后 attach 依然安全', () => {
    assert.strictEqual(broken.attach([{ id: 'aaaa-1111' }]), 0);
  });
  broken.close();

  const viaDir = createTitles({ workbuddyDir: dir });
  check('workbuddyDir 拼出 <dir>/workbuddy.db', () => {
    assert.strictEqual(viaDir.dbPath, path.join(dir, 'workbuddy.db'));
    if (sqlite) assert.strictEqual(viaDir.lookup('aaaa-1111'), 'Codex相关按钮显示条件');
  });
  viaDir.close();
}

console.log('[T4] 缓存：命中不重复查库');
{
  const titles = createTitles({ dbPath: dbFile });
  if (sqlite) {
    check('第一次查库拿到标题', () => assert.strictEqual(titles.lookup('aaaa-1111'), 'Codex相关按钮显示条件'));
    // 把库删掉：如果还在查库就会变成 null；命中缓存则不变。
    fs.unlinkSync(dbFile);
    check('TTL 内命中缓存，不因库消失而抖回 null', () => {
      assert.strictEqual(titles.lookup('aaaa-1111'), 'Codex相关按钮显示条件');
    });
    buildDb(); // 复原，供后续段落使用
  }
  titles.close();
}

console.log('[T5] cleanTitle 的净化');
{
  check('压掉控制字符与多余空白', () => {
    assert.strictEqual(cleanTitle('a\u0000b  \n c'), 'a b c');
  });
  check('非字符串 → null', () => {
    assert.strictEqual(cleanTitle(null), null);
    assert.strictEqual(cleanTitle(42), null);
  });
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
