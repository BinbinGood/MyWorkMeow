'use strict';

// Headless end-to-end smoke test of the backend spine (no Electron):
//   hook POST /state  → core → adapter (events + stats)
//   CC   POST /permission (held open) → decidePermission → byte-exact response
// Run: node test/smoke.js

const http = require('http');
const assert = require('assert');
const { createCore, deriveBadge } = require('../backend/core');
const { createPermissions } = require('../backend/permission');
const { createServer } = require('../backend/server');
const { SERVER_ID, SERVER_HEADER, TOKEN_HEADER } = require('../backend/transport');
const adapter = require('../backend/adapter');

const events = [];
let dirtyCount = 0;

const core = createCore({
  onActivity: (act) => { for (const ev of adapter.activityToEvents(act)) events.push(ev); },
  onDirty: () => { dirtyCount++; },
});
const permissions = createPermissions({
  onAdded: (entry) => { events.push({ kind: 'waiting', permId: entry.id, sessionId: entry.sessionId }); },
  onChange: () => {},
});
const server = createServer({ core, permissions });

function postAbortable(pathName, body, options = {}) {
  let req;
  const settled = new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const authenticated = options.auth !== false;
    const query = [];
    if (authenticated && pathName === '/permission') {
      query.push(`token=${encodeURIComponent(server.getToken())}`);
      // 安装器会把 integrationId 写进 URL（transport.buildPermissionUrl），
      // Claude Code 是 agent=claude、WorkBuddy 是 agent=workbuddy。
      if (options.agent) query.push(`agent=${encodeURIComponent(options.agent)}`);
    }
    const requestPath = query.length ? `${pathName}?${query.join('&')}` : pathName;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (authenticated && pathName === '/state') headers[TOKEN_HEADER] = server.getToken();
    req = http.request(
      { hostname: '127.0.0.1', port: server.getPort(), path: requestPath, method: 'POST', agent: false, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
  return { req, settled };
}

function post(pathName, body, options) {
  return postAbortable(pathName, body, options).settled;
}

function get(pathName) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.getPort(), path: pathName, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SID = 'test-session-aaaa';
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); }
  catch (e) { failures++; console.log('  ✗', name, '\n     ', e.message); }
}

async function main() {
  server.start();
  for (let i = 0; i < 50 && !server.getPort(); i++) await sleep(20);
  assert(server.getPort(), 'server failed to bind a port');
  console.log('server on', server.getPort());

  console.log('\n[1] health');
  const health = await get('/state');
  check('GET /state returns ok', () => {
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).app, SERVER_ID);
    assert.strictEqual(health.headers[SERVER_HEADER], SERVER_ID);
  });

  console.log('\n[1b] write endpoints require the per-run token');
  let r = await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'forged' }, { auth: false });
  check('unauthenticated state write → 403', () => {
    assert.strictEqual(r.status, 403);
    assert.strictEqual(core.getSession('forged'), null);
  });
  r = await post('/permission', { tool_name: 'Bash', tool_input: {}, session_id: 'forged' }, { auth: false });
  check('unauthenticated permission write → 403', () => {
    assert.strictEqual(r.status, 403);
    assert.strictEqual(permissions.getPending().length, 0);
  });

  console.log('\n[2] session lifecycle via /state');
  r = await post('/state', { state: 'idle', event: 'SessionStart', session_id: SID, cwd: '/Users/me/proj-x' });
  check('SessionStart accepted', () => { assert.strictEqual(r.status, 200); assert.strictEqual(r.headers[SERVER_HEADER], SERVER_ID); });

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('greet emitted on first prompt（欢迎延迟到首条输入）', () => assert(events.some((e) => e.kind === 'greet')));
  check('session is thinking', () => assert.strictEqual(core.getSession(SID).state, 'thinking'));

  r = await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: SID, cwd: '/Users/me/proj-x' });
  check('user-turn event emitted（第二条起）', () => assert(events.some((e) => e.kind === 'user-turn')));

  r = await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: SID, cwd: '/Users/me/proj-x' });
  check('operation event for Bash', () => assert(events.some((e) => e.kind === 'operation' && e.tool === 'Bash')));

  r = await post('/state', {
    state: 'attention', event: 'Stop', session_id: SID, cwd: '/Users/me/proj-x',
    assistant_last_output: '我已经修好了那个 bug，并跑通了测试。',
  });
  check('turn-done event emitted', () => assert(events.some((e) => e.kind === 'turn-done')));
  check('say event carries Claude message', () => assert(events.some((e) => e.kind === 'say' && /修好/.test(e.text))));
  check('session requiresCompletionAck after Stop', () => assert.strictEqual(core.getSession(SID).requiresCompletionAck, true));
  check('completed turn no longer carries a running timer', () => assert.strictEqual(core.getSession(SID).turnStartedAt, 0));

  console.log('\n[3] unknown state rejected');
  r = await post('/state', { state: 'bogus', event: 'X', session_id: SID });
  check('unknown state → 400', () => assert.strictEqual(r.status, 400));

  console.log('\n[4] permission hold-open → decide allow (byte-exact)');
  const permSid = 'perm-session-bbbb';
  // create the session first so the choice gets a project name
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: permSid, cwd: '/Users/me/proj-y' });
  const permRespP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, session_id: permSid });
  await sleep(80);
  check('permission is pending', () => assert.strictEqual(permissions.getPending().length, 1));
  const pend = permissions.getPending()[0];
  check('waiting event emitted with permId', () => assert(events.some((e) => e.kind === 'waiting' && e.permId === pend.id)));

  // build the stats the frontend would receive and verify the waiting overlay + choice
  const stats = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
  check('stats waitingCount = 1', () => assert.strictEqual(stats.waitingCount, 1));
  check('waiting session has perm choice', () => {
    const ws = stats.sessions.find((s) => s.state === 'waiting');
    assert(ws && ws.choice && ws.choice.kind === 'perm' && ws.choice.permId === pend.id);
    assert(/rm -rf build/.test(ws.choice.question));
  });

  permissions.decide(pend.id, 'allow');
  const permResp = await permRespP;
  check('permission response is byte-exact allow', () => {
    assert.strictEqual(permResp.status, 200);
    assert.strictEqual(permResp.headers[SERVER_HEADER], SERVER_ID);
    assert.deepStrictEqual(JSON.parse(permResp.body), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  check('no pending after decide', () => assert.strictEqual(permissions.getPending().length, 0));

  console.log('\n[5] permission deny carries message');
  const denySid = 'deny-session-cccc';
  const denyP = post('/permission', { tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, session_id: denySid });
  await sleep(60);
  const dpend = permissions.getPending()[0];
  permissions.decide(dpend.id, 'deny');
  const denyResp = await denyP;
  check('deny response shape', () => {
    const j = JSON.parse(denyResp.body);
    assert.strictEqual(j.hookSpecificOutput.decision.behavior, 'deny');
  });

  console.log('\n[6] passthrough tool auto-allowed (not held)');
  const ptResp = await post('/permission', { tool_name: 'TaskCreate', tool_input: {}, session_id: 'pt' });
  check('TaskCreate auto-allow', () => assert.strictEqual(JSON.parse(ptResp.body).hookSpecificOutput.decision.behavior, 'allow'));

  console.log('\n[7] 并行事件保留权限卡；只在 SessionEnd 无裁决清理');
  const sweepSid = 'sweep-session-dddd';
  const bashP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: sweepSid });
  const writeP = post('/permission', { tool_name: 'Write', tool_input: { file_path: '/tmp/parallel.txt' }, session_id: sweepSid });
  await sleep(60);
  check('two distinct permissions can wait in one shared session', () => {
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === sweepSid).length, 2);
  });
  const parallelStats = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
  check('adapter exposes every parallel request as an independent action', () => {
    const actions = parallelStats.actions.filter((action) => action.sessionId === sweepSid);
    assert.strictEqual(actions.length, 2);
    assert.strictEqual(new Set(actions.map((action) => action.id)).size, 2);
    assert.strictEqual(parallelStats.waitingCount, 2);
  });
  for (const [event, state] of [
    ['PostToolUse', 'working'],
    ['PostToolUseFailure', 'error'],
    ['Stop', 'attention'],
    ['UserPromptSubmit', 'thinking'],
  ]) {
    await post('/state', { state, event, tool_name: 'Bash', session_id: sweepSid });
  }
  check('unrelated lifecycle events keep both live permission cards', () => {
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === sweepSid).length, 2);
  });
  const sweepPending = permissions.getPending().filter((p) => p.sessionId === sweepSid);
  permissions.decide(sweepPending.find((p) => p.toolName === 'Bash').id, 'allow');
  permissions.decide(sweepPending.find((p) => p.toolName === 'Write').id, 'deny');
  const [bashResp, writeResp] = await Promise.all([bashP, writeP]);
  check('later clicks resolve only their matching parallel requests', () => {
    assert.strictEqual(JSON.parse(bashResp.body).hookSpecificOutput.decision.behavior, 'allow');
    assert.strictEqual(JSON.parse(writeResp.body).hookSpecificOutput.decision.behavior, 'deny');
  });

  const endSid = 'ended-session-eeee';
  const endSettled = post('/permission', { tool_name: 'Bash', tool_input: { command: 'pwd' }, session_id: endSid })
    .then((resp) => ({ resp }), (err) => ({ err }));
  await sleep(60);
  await post('/state', { state: 'sleeping', event: 'SessionEnd', session_id: endSid });
  const endOutcome = await endSettled;
  check('SessionEnd drops stale permission without allow/deny', () => {
    assert(endOutcome.err);
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === endSid).length, 0);
  });

  console.log('\n[7b] primary hook disconnect promotes a live duplicate instead of denying it');
  const dupSid = 'duplicate-session-ffff';
  const dupBody = { tool_name: 'Bash', tool_input: { command: 'echo duplicate' }, session_id: dupSid };
  const primary = postAbortable('/permission', dupBody);
  primary.settled.catch(() => {});
  await sleep(30);
  const duplicate = postAbortable('/permission', dupBody);
  await sleep(60);
  check('identical retry shares one permission card', () => {
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === dupSid).length, 1);
  });
  primary.req.destroy();
  await sleep(30);
  check('card remains pending after primary connection closes', () => {
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === dupSid).length, 1);
  });
  const dupPending = permissions.getPending().find((p) => p.sessionId === dupSid);
  permissions.decide(dupPending.id, 'allow');
  const duplicateResp = await duplicate.settled;
  check('promoted duplicate receives the later user decision', () => {
    assert.strictEqual(JSON.parse(duplicateResp.body).hookSpecificOutput.decision.behavior, 'allow');
  });

  console.log('\n[7c] 长前缀不同请求绝不合并；权限可先于 state 出现');
  const prefixSid = 'long-prefix-session-hhhh';
  const commonPrefix = 'x'.repeat(3000);
  const prefixA = post('/permission', { tool_name: 'Bash', tool_input: { command: commonPrefix + 'A' }, session_id: prefixSid });
  const prefixB = post('/permission', { tool_name: 'Bash', tool_input: { command: commonPrefix + 'B' }, session_id: prefixSid });
  await sleep(60);
  const prefixPending = permissions.getPending().filter((p) => p.sessionId === prefixSid);
  check('full request identity keeps long-prefix requests distinct', () => assert.strictEqual(prefixPending.length, 2));
  const pendingOnlyStats = adapter.buildPetStats(core.buildSnapshot(), prefixPending, null);
  check('permission arriving before state remains visible', () => {
    assert.strictEqual(pendingOnlyStats.actions.filter((a) => a.sessionId === prefixSid).length, 2);
    assert.strictEqual(pendingOnlyStats.waitingCount, 2);
  });
  permissions.decide(prefixPending[0].id, 'allow');
  permissions.decide(prefixPending[1].id, 'deny');
  const [prefixAResp, prefixBResp] = await Promise.all([prefixA, prefixB]);
  check('long-prefix requests receive their own decisions', () => {
    assert.strictEqual(JSON.parse(prefixAResp.body).hookSpecificOutput.decision.behavior, 'allow');
    assert.strictEqual(JSON.parse(prefixBResp.body).hookSpecificOutput.decision.behavior, 'deny');
  });

  const missingSession = await post('/permission', { tool_name: 'Bash', tool_input: { command: 'pwd' } });
  check('permission without session_id is explicitly denied', () => {
    const decision = JSON.parse(missingSession.body).hookSpecificOutput.decision;
    assert.strictEqual(decision.behavior, 'deny');
    assert.strictEqual(permissions.getPending().some((p) => p.sessionId === 'default'), false);
  });

  const blankSession = await post('/state', { state: 'idle', event: 'SessionStart', session_id: '   ' });
  check('blank session_id is rejected like a missing id', () => assert.strictEqual(blankSession.status, 400));

  check('direct core updates without session_id are ignored', () => {
    assert.strictEqual(core.updateSession('', 'working', 'PreToolUse', {}), null);
    assert.strictEqual(core.getSession('default'), null);
  });

  const resumed = SID + '-resumed';
  await post('/state', { state: 'working', event: 'PreToolUse', session_id: resumed, background_tasks_count: 1 });
  await post('/state', { state: 'attention', event: 'Stop', session_id: resumed, background_tasks_count: 0 });
  await post('/state', { state: 'working', event: 'PreToolUse', session_id: resumed, background_tasks_count: 1 });
  check('suppressed continuation clears the previous completion badge', () => {
    const entry = core.buildSnapshot().sessions.find((s) => s.id === resumed);
    assert(entry);
    assert.strictEqual(entry.requiresCompletionAck, false);
    assert.strictEqual(entry.badge, 'running');
  });

  const soloSid = 'disconnected-session-gggg';
  const solo = postAbortable('/permission', {
    tool_name: 'Bash',
    tool_input: { command: 'echo terminal-answer' },
    session_id: soloSid,
  });
  solo.settled.catch(() => {});
  await sleep(60);
  solo.req.destroy();
  await sleep(30);
  check('last connection close cleans the card without a synthetic decision', () => {
    assert.strictEqual(permissions.getPending().filter((p) => p.sessionId === soloSid).length, 0);
  });

  console.log('\n[8] juggling/sweeping 透传（皮肤素材可达）+ 计数');
  const jSid = 'juggle-session-eeee';
  await post('/state', { state: 'juggling', event: 'SubagentStart', session_id: jSid, cwd: '/Users/me/proj-j' });
  const sSid = 'sweep-session-ffff';
  await post('/state', { state: 'sweeping', event: 'PreCompact', session_id: sSid, cwd: '/Users/me/proj-s' });
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const js = st.sessions.find((x) => x.sessionId === jSid);
    const ss = st.sessions.find((x) => x.sessionId === sSid);
    check('juggling 不再折叠成 working', () => assert.strictEqual(js.state, 'juggling'));
    check('sweeping 不再折叠成 working', () => assert.strictEqual(ss.state, 'sweeping'));
    check('jugglingCount/sweepingCount 计数', () => {
      assert(st.jugglingCount >= 1 && st.sweepingCount >= 1);
    });
  }

  console.log('\n[9] Stop 完成门：后台任务未结束时保持运行');
  const supSid = 'suppressed-stop-gggg';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: supSid, cwd: '/Users/me/proj-sup' });
  const backgroundTurnStartedAt = core.getSession(supSid).turnStartedAt;
  await post('/state', {
    state: 'attention', event: 'Stop', session_id: supSid, cwd: '/Users/me/proj-sup',
    background_tasks_count: 2, session_crons_count: 1,
  });
  {
    const s9 = core.getSession(supSid);
    check('后台 Stop 保持 working 且不置完成标记', () => {
      assert.strictEqual(s9.state, 'working');
      assert.strictEqual(!!s9.requiresCompletionAck, false);
      assert.strictEqual(s9.turnStartedAt, backgroundTurnStartedAt);
    });
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const e9 = st.sessions.find((x) => x.sessionId === supSid);
    check('快照传递后台/定时数量并显示运行徽标', () => {
      assert.strictEqual(e9.state, 'working');
      assert.strictEqual(e9.badge, 'running');
      assert.strictEqual(e9.backgroundActive, true);
      assert.strictEqual(e9.backgroundTasksCount, 2);
      assert.strictEqual(e9.sessionCronsCount, 1);
    });
    check('无 turn-done 庆祝事件', () => assert(!events.some((e) => e.kind === 'turn-done' && e.project === 'proj-sup')));
    await post('/state', { state: 'idle', event: 'IdleNotification', session_id: supSid });
    core.sessions.get(supSid).updatedAt = Date.now() - 31 * 60 * 1000;
    core.cleanStaleSessions();
    check('空闲通知、5 分钟忙碌兜底和 30 分钟无 PID 回收不打断已知后台任务', () => {
      assert.strictEqual(core.getSession(supSid).state, 'working');
      assert.strictEqual(core.getSession(supSid).backgroundActive, true);
    });

    // A later Stop with empty registries is the actual completion boundary.
    // stop_hook_active only reports that a previous Stop hook continued Claude;
    // it is not evidence of remaining background work on this Stop.
    const completedBefore = events.filter((e) => e.kind === 'turn-done' && e.project === 'proj-sup').length;
    await post('/state', {
      state: 'attention', event: 'Stop', session_id: supSid, cwd: '/Users/me/proj-sup',
      background_tasks_count: 0, session_crons_count: 0, stop_hook_active: true,
    });
    const finalSession = core.getSession(supSid);
    const finalStats = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const finalEntry = finalStats.sessions.find((x) => x.sessionId === supSid);
    check('后台清空后才完成并清理后台状态', () => {
      assert.strictEqual(finalSession.state, 'idle');
      assert.strictEqual(finalSession.turnStartedAt, 0);
      assert.strictEqual(finalSession.backgroundActive, false);
      assert.strictEqual(finalEntry.badge, 'done');
      assert.strictEqual(finalEntry.backgroundTasksCount, 0);
      assert.strictEqual(finalEntry.sessionCronsCount, 0);
      assert.strictEqual(events.filter((e) => e.kind === 'turn-done' && e.project === 'proj-sup').length, completedBefore + 1);
    });

    const cronOnlySid = 'cron-only-stop-hhhh';
    await post('/state', {
      state: 'attention', event: 'Stop', session_id: cronOnlySid,
      session_crons_count: 1,
    });
    check('缺少前置事件时，定时等待 Stop 也会建立本轮计时', () => {
      assert(core.getSession(cronOnlySid).turnStartedAt > 0);
      assert.strictEqual(core.getSession(cronOnlySid).state, 'working');
    });
    await post('/state', { state: 'attention', event: 'Stop', session_id: cronOnlySid, session_crons_count: 0 });
  }

  console.log('\n[10] oneshot 衰减：error/sweeping 不再永久卡死');
  const errSid = 'stuck-error-hhhh';
  await post('/state', { state: 'error', event: 'StopFailure', session_id: errSid, cwd: '/Users/me/proj-err' });
  check('StopFailure 后会话进入 error', () => assert.strictEqual(core.getSession(errSid).state, 'error'));
  core.sessions.get(errSid).updatedAt = Date.now() - 46 * 1000; // 越过 45s TTL
  core.cleanStaleSessions();
  check('error 45s 后衰减为 idle（不再钉死全局瘫倒）', () => assert.strictEqual(core.getSession(errSid).state, 'idle'));

  console.log('\n[11] /clear 幽灵会话：sweeping 衰减 + ended 回收');
  const clrSid = 'cleared-session-iiii';
  await post('/state', { state: 'sweeping', event: 'SessionEnd', session_id: clrSid, cwd: '/Users/me/proj-clr' });
  check('SessionEnd(clear) 标记 ended', () => assert.strictEqual(core.getSession(clrSid).ended, true));
  core.sessions.get(clrSid).updatedAt = Date.now() - 21 * 1000; // 越过 sweeping 20s TTL
  core.cleanStaleSessions();
  check('清理表情 20s 后衰减为 idle', () => assert.strictEqual(core.getSession(clrSid).state, 'idle'));
  core.sessions.get(clrSid).updatedAt = Date.now() - 31 * 60 * 1000; // 越过 30min
  core.cleanStaleSessions();
  check('ended 会话 30min 后被回收（终端 pid 存活也不豁免）', () => assert.strictEqual(core.getSession(clrSid), null));

  console.log('\n[12] hook 契约：无 session_id 丢弃 + op 标签不陈旧');
  const hook = require('../hook/workmeow-hook');
  const opSid = 'op-label-jjjj';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: opSid, cwd: '/Users/me/proj-op' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: opSid, cwd: '/Users/me/proj-op' });
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eOp = st.sessions.find((x) => x.sessionId === opSid);
    check('thinking 阶段不显示上一轮的「运行命令」', () => assert.strictEqual(eOp.op, null));
  }

  console.log('\n[13] greet 延迟到第一条 prompt：入口会话静默、真对话欢迎');
  // 用户定义情形 b：看板上没有的会话被 resume 进入 = 新对话，说话后欢迎
  const rsSid = 'resume-session-kkkk';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: rsSid, cwd: '/Users/me/proj-resume', session_source: 'resume' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: rsSid, cwd: '/Users/me/proj-resume' });
  check('看板外会话 resume 进入 + 说话 → 欢迎', () => assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-resume')));
  const nsSid = 'startup-session-llll';
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: nsSid, cwd: '/Users/me/proj-fresh', session_source: 'startup' });
  check('SessionStart 本身不欢迎（等第一条 prompt）', () => assert(!events.some((e) => e.kind === 'greet' && e.project === 'proj-fresh')));
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: nsSid, cwd: '/Users/me/proj-fresh' });
  check('新对话第一条 prompt → 欢迎', () => assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-fresh')));
  check('欢迎时不叠 user-turn（短暂态不互抢）', () =>
    assert(!events.some((e) => e.kind === 'user-turn' && e.project === 'proj-fresh')));
  check('hook 转发 SessionStart source', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x2', source: 'resume' });
    assert(b && b.session_source === 'resume');
  });

  console.log('\n[14] 工具结束后长间隙 = 摸鱼（loafing），不硬说思考');
  const tgSid = 'loafgap-session-mmmm';
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具结束 6s 无事件
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PostToolUse 后 >5s 无事件 → loafing 摸鱼', () => assert.strictEqual(eTg.state, 'loafing'));
    check('loafingCount 计数', () => assert(st.loafingCount >= 1));
  }
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000; // 工具还在跑 6s
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('PreToolUse 长间隙（工具仍在跑）→ 仍是 working', () => assert.strictEqual(eTg.state, 'working'));
  }
  // 重连/流式输出场景：事件间隙里 transcript 还在长 → 干活，不是摸鱼
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: tgSid, cwd: '/Users/me/proj-tg' });
  core.sessions.get(tgSid).updatedAt = Date.now() - 6000;
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 3000; // 3s 前还在写
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('间隙但 transcript 在长（模型产出中）→ working', () => assert.strictEqual(eTg.state, 'working'));
  }
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 200 * 1000; // 文件 3 分多钟没动
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eTg = st.sessions.find((x) => x.sessionId === tgSid);
    check('间隙且 transcript 长时间不动 → loafing 摸鱼', () => assert.strictEqual(eTg.state, 'loafing'));
  }
  const codexGapSid = 'codex-gap-session-rrrr';
  await post('/state', { state: 'working', event: 'PostToolUse', tool_name: 'Bash', session_id: codexGapSid, cwd: '/Users/me/proj-codex' });
  core.sessions.get(codexGapSid).agentId = 'codex'; // Codex watcher 直连 core；HTTP hook 固定是 Claude
  core.sessions.get(codexGapSid).updatedAt = Date.now() - 6000;
  core.sessions.get(codexGapSid).transcriptActiveAt = Date.now() - 6000;
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eCodex = st.sessions.find((x) => x.sessionId === codexGapSid);
    check('Codex PostToolUse 长间隙仍是 working（等明确 task_complete）', () => assert.strictEqual(eCodex.state, 'working'));
  }
  // 慢长任务（17m 一轮、token 缓涨）：事件 6 分钟没来但文件半分钟前还在写 → 不被卡死兜底打成 idle
  core.sessions.get(tgSid).updatedAt = Date.now() - 6 * 60 * 1000;
  core.sessions.get(tgSid).transcriptActiveAt = Date.now() - 30 * 1000;
  core.cleanStaleSessions();
  check('慢长任务不被 WORKING_STALE 打成 idle', () => assert.strictEqual(core.getSession(tgSid).state, 'working'));

  console.log('\n[15] SessionStart 无 source 时用 transcript 历史兜底');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-test-'));
  const histFile = path.join(tmpDir, 'hist.jsonl');
  fs.writeFileSync(histFile, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '之前聊过' }] } }) + '\n'
    + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } }) + '\n');
  check('有历史对话 + 无 source → 标记 resume（诊断用）', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x3', transcript_path: histFile });
    assert.strictEqual(b.session_source, 'resume');
  });
  check('无 transcript + 无 source → 标记 startup', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x4', transcript_path: path.join(tmpDir, 'nope.jsonl') });
    assert.strictEqual(b.session_source, 'startup');
  });
  check('显式 source 优先', () => {
    const b = hook.buildBody('SessionStart', { session_id: 'x5', source: 'compact', transcript_path: histFile });
    assert.strictEqual(b.session_source, 'compact');
  });

  console.log('\n[17] 同 cwd 已有活跃会话 → 说话也不欢迎（进入执行中任务兜底）');
  const busyCwd = '/Users/me/proj-busy-x';
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: 'busy-owner-oooo', cwd: busyCwd });
  // ccd 点进该任务：fork 新 id + 无 source + 空 transcript（最恶劣组合）
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'fork-entry-pppp', cwd: busyCwd, session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'fork-entry-pppp', cwd: busyCwd });
  check('同 cwd 忙碌中，进入后说话也不欢迎', () =>
    assert(!events.some((e) => e.kind === 'greet' && e.project === 'proj-busy-x')));
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'fresh-proj-qqqq', cwd: '/Users/me/proj-brand-new', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'fresh-proj-qqqq', cwd: '/Users/me/proj-brand-new' });
  check('全新项目的新对话仍正常欢迎', () =>
    assert(events.some((e) => e.kind === 'greet' && e.project === 'proj-brand-new')));

  console.log('\n[19] 工具拉起的一次性目录会话 + 同项目欢迎频控');
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'toolspawn-ssss', cwd: '/Users/me/.someapp/sessions/ab12cd34', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'toolspawn-ssss', cwd: '/Users/me/.someapp/sessions/ab12cd34' });
  check('隐藏目录 cwd（工具拉起）说话也不欢迎', () =>
    assert(!events.some((e) => e.kind === 'greet' && e.project === 'ab12cd34')));
  const winToolBefore = events.filter((e) => e.kind === 'greet').length;
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'toolspawn-win-ssss', cwd: 'C:\\Users\\me\\.someapp\\sessions\\ab12cd34', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'toolspawn-win-ssss', cwd: 'C:\\Users\\me\\.someapp\\sessions\\ab12cd34' });
  check('Windows 隐藏目录同样不欢迎', () =>
    assert.strictEqual(events.filter((e) => e.kind === 'greet').length, winToolBefore));
  // 同项目名 30 分钟频控：第一次欢迎后，另一个同名项目的新对话不再欢迎
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'debounce-a-tttt', cwd: '/Users/me/proj-debounce', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'debounce-a-tttt', cwd: '/Users/me/proj-debounce' });
  await post('/state', { state: 'idle', event: 'SessionStart', session_id: 'debounce-c-vvvv', cwd: '/tmp/other/proj-debounce', session_source: 'startup' });
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: 'debounce-c-vvvv', cwd: '/tmp/other/proj-debounce' });
  check('同项目 30 分钟内只欢迎一次', () =>
    assert.strictEqual(events.filter((e) => e.kind === 'greet' && e.project === 'proj-debounce').length, 1));

  const activeBusy = core.updateSession('active-busy', 'working', 'PreToolUse', { cwd: '/busy', toolName: 'Bash' });
  activeBusy.updatedAt = Date.now() - 5000;
  core.updateSession('new-idle', 'idle', 'SessionStart', { cwd: '/idle' });
  check('active session prefers semantic priority over a newer idle start', () =>
    assert.notStrictEqual(core.buildSnapshot().active.sessionId, 'new-idle'));

  const oldDone = core.updateSession('old-done', 'attention', 'Stop', { cwd: '/old-done' });
  oldDone.completionAt = Date.now() - 3 * 60 * 1000;
  oldDone.updatedAt = Date.now() - 3 * 60 * 1000;
  core.cleanStaleSessions();
  check('completion badge expires instead of persisting for the terminal lifetime', () => {
    const entry = core.buildSnapshot().sessions.find((s) => s.id === 'old-done');
    assert(entry);
    assert.strictEqual(entry.badge, 'idle');
    assert.strictEqual(entry.requiresCompletionAck, false);
  });

  console.log('\n[16] ESC 中断检测（transcript 发现，10s 巡检放下忙碌态）');
  const intSid = 'interrupt-session-nnnn';
  // 像真实 hook 那样直接带 transcript_path（server 存 s.transcriptPath，core 直接读），
  // 不再靠 cwd 反推编码目录 —— 也不再往用户真实的 ~/.claude/projects 写测试文件。
  const intDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-int-'));
  const intFile = path.join(intDir, `${intSid}.jsonl`);
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: intSid, cwd: '/Users/me/workmeow-int', transcript_path: intFile });
  await sleep(30);
  fs.writeFileSync(intFile,
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
  core.cleanStaleSessions();
  check('中断后忙碌态被放下（不再等 5 分钟）', () => assert.strictEqual(core.getSession(intSid).state, 'idle'));
  {
    const st = adapter.buildPetStats(core.buildSnapshot(), [], null);
    const eInt = st.sessions.find((x) => x.sessionId === intSid);
    check('徽标显示中断', () => assert.strictEqual(eInt.badge, 'interrupted'));
  }
  // 新事件到达（用户继续）→ lastEvent 晚于中断标记 → 不再触发
  await sleep(30);
  await post('/state', { state: 'working', event: 'PreToolUse', tool_name: 'Bash', session_id: intSid, cwd: '/Users/me/workmeow-int', transcript_path: intFile });
  core.cleanStaleSessions();
  check('中断后继续对话不误判', () => assert.strictEqual(core.getSession(intSid).state, 'working'));
  fs.rmSync(intDir, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n[18] 网络重试检测：API 错误间隙不再误判成思考中');
  const netSid = 'netretry-session-rrrr';
  const netDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workmeow-net-'));
  const netFile = path.join(netDir, `${netSid}.jsonl`);
  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: netSid, cwd: '/Users/me/workmeow-net', transcript_path: netFile });
  await sleep(30);
  fs.writeFileSync(netFile,
    JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', sessionId: netSid, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Connection closed mid-response.' }] } }) + '\n');
  core.cleanStaleSessions();
  check('重试失败间隙 → error 而非 thinking', () => assert.strictEqual(core.getSession(netSid).state, 'error'));
  check('错误类型被记录', () => assert.strictEqual(core.getSession(netSid).errorType, 'server_error'));
  // 重试成功：错误条目之后出现正常消息 → 恢复干活
  fs.appendFileSync(netFile,
    JSON.stringify({ type: 'assistant', sessionId: netSid, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '恢复了，继续。' }] } }) + '\n');
  core.cleanStaleSessions();
  check('重试成功后自动恢复 working', () => assert.strictEqual(core.getSession(netSid).state, 'working'));
  fs.rmSync(netDir, { recursive: true, force: true });

  console.log('\n[19] WorkBuddy 走同一条 PermissionRequest 通道（agent=workbuddy）');
  // 背景：workbuddy-hookinstall.js 原先是 withPermission:false，注释还断言
  // 「WorkBuddy 不用阻塞式 PermissionRequest hook」。实测核对 cli/dist/codebuddy.js
  // 后发现是错的 —— 它既有 PERMISSION_REQUEST 事件、http hook 的响应体也会被解析
  // 成 hookSpecificOutput。这一节把那句话变成可回归的断言。
  const wbSid = 'workbuddy-perm-session-uuuu';
  const wbPayload = {
    session_id: wbSid,
    // WorkBuddy 的 PermissionRequest 请求体字段（hook_event_name / call_id /
    // tool_use_id / permission_suggestions），与 Claude Code 的 shape 一致。
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dist' },
    tool_use_id: 'call_wb_0001',
    permission_suggestions: [{ rules: [{ toolName: 'Bash', ruleContent: 'rm -rf dist' }] }],
    transcript_path: '/tmp/workbuddy-perm.jsonl',
    cwd: '/Users/me/proj-wb',
  };
  const wbP = post('/permission', wbPayload, { agent: 'workbuddy' });
  await sleep(80);
  const wbPending = permissions.getPending().find((p) => p.sessionId === wbSid);
  check('WorkBuddy 的授权请求被挂起（说明 withPermission 通道通）', () => assert(wbPending));
  check('来源 Agent 被记录成 workbuddy，不是写死的 claude-code', () => {
    assert.strictEqual(wbPending.agentId, 'workbuddy');
  });
  check('WorkBuddy 的 tool_use_id 被当成请求身份（重发可去重）', () => {
    assert.strictEqual(wbPending.toolInput.command, 'rm -rf dist');
  });
  permissions.decide(wbPending.id, 'allow');
  const wbResp = await wbP;
  // 这条断言就是「WorkBuddy 能不能读懂」的全部契约：它的
  // executePermissionRequestHooks() 读 hookSpecificOutput.decision.behavior。
  check('返回体逐字节符合 WorkBuddy 的 decision 协议', () => {
    assert.strictEqual(wbResp.status, 200);
    assert.deepStrictEqual(JSON.parse(wbResp.body), {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  // 不带 agent 参数的旧 URL（升级前装好的 hook）必须继续按 Claude Code 处理
  const legacySid = 'legacy-perm-session-vvvv';
  const legacyP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: legacySid });
  await sleep(60);
  const legacyPending = permissions.getPending().find((p) => p.sessionId === legacySid);
  check('旧 URL（无 agent 参数）回落成 claude-code，不会被误判成别的工具', () => {
    assert(legacyPending);
    assert.strictEqual(legacyPending.agentId, 'claude-code');
  });
  permissions.decide(legacyPending.id, 'allow');
  await legacyP;

  // AskUserQuestion：WorkBuddy 的「让用户选」就走这条。它同样从
  // decision.updatedInput 取答案（CLI 侧 cachePreToolUseResult({modifiedInput})），
  // 所以喵的选择卡在 WorkBuddy 上一样能落回宿主。
  const askSid = 'workbuddy-ask-session-wwww';
  const askP = post('/permission', {
    session_id: askSid,
    hook_event_name: 'PermissionRequest',
    tool_name: 'AskUserQuestion',
    tool_use_id: 'call_wb_0002',
    tool_input: {
      questions: [{
        header: '方案',
        question: '用哪种口径统计？',
        options: [{ label: '按自然日', description: '本地自然日' }, { label: '滚动 24h' }],
        multiSelect: false,
      }],
    },
  }, { agent: 'workbuddy' });
  await sleep(80);
  const askPending = permissions.getPending().find((p) => p.sessionId === askSid);
  check('WorkBuddy 的 AskUserQuestion 也走这条路且识别为选择题', () => {
    assert(askPending);
    assert.strictEqual(askPending.isElicitation, true);
    assert.strictEqual(askPending.questions.length, 1);
    assert.strictEqual(askPending.questions[0].options[0].label, '按自然日');
  });
  permissions.decide(askPending.id, { type: 'elicitation-submit', answers: { '用哪种口径统计？': '按自然日' } });
  const askResp = await askP;
  check('选择题的答案通过 decision.updatedInput 回传', () => {
    const decision = JSON.parse(askResp.body).hookSpecificOutput.decision;
    assert.strictEqual(decision.behavior, 'allow');
    assert.deepStrictEqual(decision.updatedInput.answers, { '用哪种口径统计？': '按自然日' });
  });

  // 安装器写进 settings.json 的 URL 必须带上来源，否则主进程分不出是谁在问。
  check('buildPermissionUrl 带上 agent，且拒绝非法值（不留注入面）', () => {
    const { buildPermissionUrl } = require('../backend/transport');
    const token = 'a'.repeat(64);
    assert.strictEqual(buildPermissionUrl(41330, token, 'workbuddy'),
      `http://127.0.0.1:41330/permission?token=${token}&agent=workbuddy`);
    assert.strictEqual(buildPermissionUrl(41330, token, 'claude'),
      `http://127.0.0.1:41330/permission?token=${token}&agent=claude`);
    assert.strictEqual(buildPermissionUrl(41330, token, 'bad value&x=1'),
      `http://127.0.0.1:41330/permission?token=${token}`);
    assert.strictEqual(buildPermissionUrl(41330, token),
      `http://127.0.0.1:41330/permission?token=${token}`, '省略 agent 时保持旧形状');
  });

  // 「始终允许」按钮：Claude Code 的 decision 支持 updatedPermissions 落盘规则，
  // WorkBuddy 不支持 —— 那就别把按钮画出来（点了不生效比没有更糟）。
  // 这里连 stats 快照那条路一起验：实时推送（onAdded）和快照（getPending）是
  // 两个消费方，只改一边会出现「实时卡片没按钮、刷新后又冒出来」。
  const sugSid = 'workbuddy-sug-session-xxxx';
  const sugP = post('/permission', {
    session_id: sugSid,
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    permission_suggestions: [{ rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }],
  }, { agent: 'workbuddy' });
  await sleep(70);
  const sugPending = permissions.getPending().find((p) => p.sessionId === sugSid);
  check('WorkBuddy 的卡片不带「始终允许」建议', () => {
    assert(sugPending);
    assert.deepStrictEqual(sugPending.suggestions, []);
  });
  check('stats 快照里的 WorkBuddy 卡片同样只有「允许 / 拒绝」两个按钮', () => {
    const snap = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
    const act = snap.actions.find((a) => a.sessionId === sugSid);
    assert(act);
    assert.deepStrictEqual(act.choice.options.map((o) => o.key), ['allow', 'deny']);
  });
  permissions.decide(sugPending.id, 'allow');
  await sugP;

  const claudeSugSid = 'claude-sug-session-yyyy';
  const claudeSugP = post('/permission', {
    session_id: claudeSugSid,
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    permission_suggestions: [{ rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }],
  }, { agent: 'claude' });
  await sleep(70);
  const claudeSug = permissions.getPending().find((p) => p.sessionId === claudeSugSid);
  check('Claude Code 的「始终允许」建议原样保留（别把功能一起删掉）', () => {
    assert(claudeSug);
    assert.strictEqual(claudeSug.suggestions.length, 1);
  });
  check('stats 快照里的 Claude Code 卡片多出「始终允许」按钮', () => {
    const snap = adapter.buildPetStats(core.buildSnapshot(), permissions.getPending(), null);
    const act = snap.actions.find((a) => a.sessionId === claudeSugSid);
    assert(act);
    assert.deepStrictEqual(act.choice.options.map((o) => o.key), ['allow', 'suggestion:0', 'deny']);
  });
  permissions.decide(claudeSug.id, 'allow');
  await claudeSugP;

  // 免鉴权 / 无 agent 参数都不该绕过注册表：未知 agent 一律回落 claude-code
  const bogusSid = 'bogus-agent-session-zzzz';
  const bogusP = post('/permission', { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: bogusSid }, { agent: 'not-an-agent' });
  await sleep(70);
  const bogus = permissions.getPending().find((p) => p.sessionId === bogusSid);
  check('未知 agent 回落 claude-code 而不是被当成新工具', () => {
    assert(bogus);
    assert.strictEqual(bogus.agentId, 'claude-code');
  });
  permissions.decide(bogus.id, 'allow');
  await bogusP;

  console.log('\n[20] 压缩上下文：sweeping 不再被 20s 默认 TTL 顶回「刚完成」');
  // 用户实测：模型压缩上下文时喵显示的还是「已完成」。根因是两条叠加：
  //   1) oneshot 的 sweeping TTL 是 20s（那个值是给 /clear 量的），压缩一超时
  //      状态就落回 idle；
  //   2) 上一轮 Stop 留下的 requiresCompletionAck 还在 → 徽标立刻 derive 回 done。
  // 修法：PreCompact 由 hook 报一个更长的 state_ttl_ms（压缩期间一直挂着 sweeping），
  // 并把 PreCompact/PostCompact 归入 WORK_START_EVENTS（新工作开始时清完成徽标）。
  const { buildBody: buildHookBody } = require('../backend/hook-common');
  const cmpSid = 'compact-session-1111';
  const preBody = buildHookBody('PreCompact', {
    session_id: cmpSid, cwd: '/Users/me/proj-cmp', hook_event_name: 'PreCompact', trigger: 'auto',
  }, 'workbuddy');
  const postBody = buildHookBody('PostCompact', {
    session_id: cmpSid, cwd: '/Users/me/proj-cmp', hook_event_name: 'PostCompact', trigger: 'auto',
  }, 'workbuddy');

  check('hook 给 PreCompact 带上更长的 state_ttl_ms', () => {
    assert(preBody && preBody.state === 'sweeping');
    assert(preBody.state_ttl_ms > 20 * 1000, 'TTL 必须比 sweeping 默认的 20s 长');
  });
  check('PostCompact 不带 TTL（回到状态表默认值）', () => {
    assert(postBody && postBody.state === 'thinking');
    assert.strictEqual(postBody.state_ttl_ms, undefined);
  });

  await post('/state', { state: 'thinking', event: 'UserPromptSubmit', session_id: cmpSid, cwd: '/Users/me/proj-cmp' });
  await post('/state', { state: 'attention', event: 'Stop', session_id: cmpSid, stop_hook_active: false });
  check('回合结束后徽标是「刚完成」', () => {
    assert.strictEqual(deriveBadge(core.getSession(cmpSid)), 'done');
  });

  await post('/state', preBody);
  check('PreCompact 立刻进入 sweeping（徽标不再是完成）', () => {
    assert.strictEqual(core.getSession(cmpSid).state, 'sweeping');
    assert.strictEqual(deriveBadge(core.getSession(cmpSid)), 'running');
  });
  check('PreCompact 清掉上一轮的完成标志（衰减后也不会变回 done）', () => {
    assert.strictEqual(core.getSession(cmpSid).requiresCompletionAck, false);
    assert.strictEqual(core.getSession(cmpSid).completionAt, 0);
  });
  core.sessions.get(cmpSid).updatedAt = Date.now() - 30 * 1000; // 越过 sweeping 默认的 20s
  core.cleanStaleSessions();
  check('压缩跑了 30s 仍然挂着 sweeping（原来就是这里丢的状态）', () => {
    assert.strictEqual(core.getSession(cmpSid).state, 'sweeping');
    assert.notStrictEqual(deriveBadge(core.getSession(cmpSid)), 'done');
  });

  await post('/state', postBody);
  check('PostCompact 回到干活态并清掉长 TTL', () => {
    const s = core.getSession(cmpSid);
    assert.strictEqual(s.state, 'thinking');
    assert.strictEqual(s.stateTtlMs, 0);
  });
  // 长 TTL 只属于「这一次压缩」：紧接着来一发 /clear 的 sweeping，必须仍按
  // 状态表默认的 20s 衰减（绝不能把 5 分钟借给别的场景）。
  await post('/state', { state: 'sweeping', event: 'SessionEnd', session_id: cmpSid, cwd: '/Users/me/proj-cmp' });
  core.sessions.get(cmpSid).updatedAt = Date.now() - 21 * 1000;
  core.cleanStaleSessions();
  check('长 TTL 不外泄：/clear 的 sweeping 仍按默认 20s 衰减', () => {
    assert.strictEqual(core.getSession(cmpSid).state, 'idle');
  });

  console.log('\n[21] 会话名跟着任务名走（每轮 prompt 只做兜底）');
  const titleSid = 'title-session-2222';
  const first = buildHookBody('UserPromptSubmit', {
    session_id: titleSid, cwd: '/Users/me/proj-t', hook_event_name: 'UserPromptSubmit', prompt: '帮我改一下登录接口\n第二行不该进标题',
  }, 'workbuddy');
  const second = buildHookBody('UserPromptSubmit', {
    session_id: titleSid, cwd: '/Users/me/proj-t', hook_event_name: 'UserPromptSubmit', prompt: '顺便把测试补了',
  }, 'workbuddy');
  check('prompt 首行走 prompt_title 而不是权威标题', () => {
    assert.strictEqual(first.prompt_title, '帮我改一下登录接口');
    assert.strictEqual(first.session_title, undefined);
  });
  await post('/state', first);
  check('还没有名字时用 prompt 首行兜底', () => {
    assert.strictEqual(core.getSession(titleSid).sessionTitle, '帮我改一下登录接口');
  });
  await post('/state', second);
  check('下一轮不再改名（原来一轮一变，列表里认不出是哪个任务）', () => {
    assert.strictEqual(core.getSession(titleSid).sessionTitle, '帮我改一下登录接口');
  });
  await post('/state', { ...first, session_title: '自定义任务名' });
  check('权威标题（自定义 / WorkBuddy 任务库）仍然可以改名', () => {
    assert.strictEqual(core.getSession(titleSid).sessionTitle, '自定义任务名');
  });

  server.stop();
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ ' + failures + ' FAILURE(S)'} — events captured: ${events.length}, dirty fires: ${dirtyCount}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('test crashed:', e); process.exit(1); });
