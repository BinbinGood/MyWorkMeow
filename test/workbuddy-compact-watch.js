'use strict';

// workbuddy-compact-watch 单元测试 — 用临时目录伪造
// ~/.workbuddy/logs/<date>/<slug>__<hash>.log，注入假 core 记录调用。
//
// 覆盖：行解析只认真正的状态迁移行（排除 "ignored invalid transition" 告警）、
// 首见文件跳过历史（防开机假报压缩中）、增量半行攒批、STARTED/ENDED 状态映射与
// 长 TTL、未知会话不建会话、孤立 ENDED 不假装结束、文件被轮转/目录缺失的降级。
// Run: node test/workbuddy-compact-watch.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createWorkbuddyCompactWatch, parseCompactLine, splitLines,
} = require('../backend/workbuddy-compact-watch');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✓', name, '\n     ', e.message); }
}

const SID = '4986fb67-8233-43bf-bc1c-ffb2378151da';

// 假 core：只记账；getSession 决定「会话是否已知」。
function fakeCore(known = [SID]) {
  const set = new Set(known);
  return {
    updates: [],
    updateSession(sid, state, event, fields) { this.updates.push({ sid, state, event, fields }); },
    getSession(sid) { return set.has(sid) ? { id: sid } : null; },
    add(sid) { set.add(sid); },
  };
}

// 真实日志行（照抄 2026-09-17 20:04:27 / 20:05:31 的原文）
function startedLine(sid = SID) {
  return `[9/17/2026, 8:04:27 PM.610] [Info] [pid=7469] [SessionRunStateMachine] transition | sessionId=${sid} | event=COMPACT_STARTED | from=idle | to=compacting | lifecycle=compacting | busy=true | queueBusy=true | elapsedSinceLastTransitionMs=51 | reason=compact-max-token\n`;
}
function endedLine(sid = SID) {
  return `[9/17/2026, 8:05:31 PM.022] [Info] [pid=7469] [SessionRunStateMachine] transition | sessionId=${sid} | event=COMPACT_ENDED | from=compacting | to=idle | lifecycle=idle | busy=false | queueBusy=false | elapsedSinceLastTransitionMs=63411 | reason=compact-max-token-complete\n`;
}
// 压缩期间会连打 3 条这种告警，同样含 COMPACT_STARTED 字样 —— 必须排除
function ignoredLine(sid = SID) {
  return `[9/17/2026, 8:04:27 PM.614] [Warning] [pid=7469] [SessionRunStateMachine] ignored invalid transition | sessionId=${sid} | event=AGENT_STARTED | current=compacting | lifecycle=compacting | busy=true | queueBusy=true | previousEvent=COMPACT_STARTED | previousFrom=idle | previousTo=compacting\n`;
}

function dateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function mkLogRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-wbcw-'));
  const dir = path.join(root, dateKey(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, fp: path.join(dir, 'workspace__deadbeef.log') };
}

// ── 行解析 ────────────────────────────────────────────────────────────────
check('parseCompactLine 认得真正的迁移行', () => {
  assert.deepStrictEqual(parseCompactLine(startedLine()), { sessionId: SID, started: true });
  assert.deepStrictEqual(parseCompactLine(endedLine()), { sessionId: SID, started: false });
});

check('parseCompactLine 排除 ignored invalid transition 告警', () => {
  // 这是最关键的一条：只用「包含 COMPACT_STARTED」判断的话，一次压缩会被记成
  // 4 次（1 条真迁移 + 3 条 previousEvent 告警）。
  assert.strictEqual(parseCompactLine(ignoredLine()), null);
});

check('parseCompactLine 忽略无关行', () => {
  assert.strictEqual(parseCompactLine(''), null);
  assert.strictEqual(parseCompactLine('[SessionRunStateMachine] transition | sessionId=x | event=TOOL_STARTED'), null);
  assert.strictEqual(parseCompactLine('[SessionRunStateMachine] transition | event=COMPACT_STARTED'), null); // 无 sessionId
  assert.strictEqual(parseCompactLine('随便一行 COMPACT_STARTED sessionId=' + SID), null); // 不是状态机行
});

check('splitLines 把结尾半行留成 carry', () => {
  const a = splitLines('', 'aaa\nbbb\ncc');
  assert.deepStrictEqual(a.lines, ['aaa', 'bbb']);
  assert.strictEqual(a.carry, 'cc');
  const b = splitLines(a.carry, 'c\n');
  assert.deepStrictEqual(b.lines, ['ccc']);
  assert.strictEqual(b.carry, '');
});

// ── watcher 行为 ──────────────────────────────────────────────────────────
check('首见热的日志：窗口里一对完整的历史压缩被抵消，不回放', () => {
  const { root, fp } = mkLogRoot();
  fs.writeFileSync(fp, startedLine() + endedLine()); // 一次早就结束了的压缩
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  w.tick();
  assert.deepStrictEqual(core.updates, [], '完整的旧压缩对必须被抵消，不许假报压缩中');
});

check('首见凉的日志直接对齐到末尾，不回放历史', () => {
  const { root, fp } = mkLogRoot();
  fs.writeFileSync(fp, endedLine() + startedLine());
  const old = new Date(Date.now() - 30 * 60 * 1000); // 10 分钟没动 → 凉
  fs.utimesSync(fp, old, old);
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  w.tick();
  assert.deepStrictEqual(core.updates, []);
});

check('首见热的日志：窗口尾部是孤立 STARTED（桌宠启动时正在压缩）→ 点亮', () => {
  const { root, fp } = mkLogRoot();
  fs.writeFileSync(fp, startedLine()); // 只有开始，没有结束 = 压缩仍在进行
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact'],
    '桌宠中途启动也该接住正在进行的压缩');
});

check('增量 STARTED → sweeping/PreCompact 且自报 5 分钟 TTL', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick(); // 首见：游标落到 0
  fs.appendFileSync(fp, startedLine());
  w.tick();
  assert.strictEqual(core.updates.length, 1);
  const u = core.updates[0];
  assert.strictEqual(u.sid, SID);
  assert.strictEqual(u.state, 'sweeping');
  assert.strictEqual(u.event, 'PreCompact');
  assert.strictEqual(u.fields.stateTtlMs, 5 * 60 * 1000, '压缩是长操作，必须自报长 TTL');
});

check('STARTED/ENDED 分两批到达 → sweeping 再 thinking；告警行不产生事件', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick();
  // 真实时序：STARTED 之后紧跟 3 条 `ignored invalid transition` 告警，63s 后才 ENDED
  fs.appendFileSync(fp, startedLine() + ignoredLine() + ignoredLine() + ignoredLine());
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact'],
    '一批里的 3 条告警行不许把一次压缩记成多次');
  fs.appendFileSync(fp, endedLine());
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact', 'PostCompact']);
  assert.strictEqual(core.updates[1].state, 'thinking');
});

check('同一批里跑完的整段压缩（STARTED…ENDED）不发任何事件', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick();
  // 桌宠被抢占/休眠了一分钟，回来时一次压缩的起止都已在同一批里 —— 桌宠没「看见」
  // 它发生，就不该补演一遍「压缩中→结束」。
  fs.appendFileSync(fp, startedLine() + endedLine());
  w.tick();
  assert.deepStrictEqual(core.updates, []);
  // 紧接着的下一轮真实压缩要照常点亮
  fs.appendFileSync(fp, startedLine());
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact']);
});

check('未知会话不建会话（压缩事件不该凭空造出喵列表外的会话）', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore([]); // 谁都不认识
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick();
  fs.appendFileSync(fp, startedLine());
  w.tick();
  assert.deepStrictEqual(core.updates, [], '未知会话的 STARTED 必须被丢掉');
  // 之后会话被 hook 建出来，再压缩就该认了
  core.add(SID);
  fs.appendFileSync(fp, endedLine() + startedLine());
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact']);
});

check('孤立 ENDED（桌宠中途重启）不假装压缩结束', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick();
  fs.appendFileSync(fp, endedLine()); // 只有结束，没有我们亲眼看到的开始
  w.tick();
  assert.deepStrictEqual(core.updates, []);
});

check('半行攒批：跨两次 append 的同一行只解析一次', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick();
  const full = startedLine();
  const cut = 60;
  fs.appendFileSync(fp, full.slice(0, cut));
  w.tick();
  assert.deepStrictEqual(core.updates, [], '半行不该被解析');
  fs.appendFileSync(fp, full.slice(cut));
  w.tick();
  assert.strictEqual(core.updates.length, 1, '补齐换行后应解析一次');
});

check('文件被轮转/截断时重置游标且不抛', () => {
  const { root, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(fp, '');
  w.tick(); // 首见
  fs.appendFileSync(fp, startedLine());
  w.tick();
  fs.appendFileSync(fp, endedLine());
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact', 'PostCompact']);
  // 轮转：文件被换成更短的新内容（新 size < 旧 offset）
  fs.writeFileSync(fp, startedLine());
  w.tick(); // 不应抛异常
  const cur = w._cursors.get(fp);
  assert.ok(cur.offset <= fs.statSync(fp).size, '游标必须被重置到文件范围内');
});

check('日志目录缺失 / 空目录一律静默', () => {
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({
    core, logRoot: path.join(os.tmpdir(), 'workmeow-wbcw-does-not-exist'), pollMs: 999999,
  });
  w.tick(); // 不应抛
  const { root } = mkLogRoot();
  const w2 = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  w2.tick();
  assert.deepStrictEqual(core.updates, []);
});

check('非 .log 文件与凉掉的日志都不读', () => {
  const { root, dir, fp } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  fs.writeFileSync(path.join(dir, 'notes.txt'), startedLine()); // 后缀不对
  fs.writeFileSync(fp, '');
  w.tick(); // 首见：游标落到 0
  // 先写好增量，再把 mtime 推老（30 分钟没动 → 凉了），本轮不应读
  fs.appendFileSync(fp, startedLine());
  const old = new Date(Date.now() - 30 * 60 * 1000);
  fs.utimesSync(fp, old, old);
  w.tick();
  assert.deepStrictEqual(core.updates, [], '凉掉的日志不再读');
  // 重新热起来后应继续读（游标保留）
  const fresh = new Date();
  fs.utimesSync(fp, fresh, fresh);
  w.tick();
  assert.deepStrictEqual(core.updates.map((u) => u.event), ['PreCompact']);
});

check('start/stop/isRunning 契约', () => {
  const { root } = mkLogRoot();
  const core = fakeCore();
  const w = createWorkbuddyCompactWatch({ core, logRoot: root, pollMs: 999999 });
  assert.strictEqual(w.isRunning(), false);
  w.start();
  assert.strictEqual(w.isRunning(), true);
  w.start(); // 幂等
  assert.strictEqual(w.isRunning(), true);
  w.stop();
  assert.strictEqual(w.isRunning(), false);
});

console.log(failures ? `\n${failures} 个用例失败` : '');
process.exit(failures ? 1 : 0);
