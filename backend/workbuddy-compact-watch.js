'use strict';

// WorkBuddy 压缩上下文（compact）只读监听器 —— 补上 hook 通道拿不到的「压缩中」。
//
// ── 为什么 hook 通道拿不到（2026-09-17 实证，别再来一遍）─────────────────────
// WorkBuddy 的 PreCompact / PostCompact hook **只有** Blocking 压缩策略会发。
// CLI 内核 codebuddy.js 里 executePreCompactHooks / executePostCompactHooks 各自
// 只有一处调用点，都在 doBlockingCompaction 里；而选策略的 runCompactStrategies
// 把 Blocking **显式排除**在派发循环之外，只在没有别的策略认领时才回落到它：
//
//     for (const s of strategies)
//       if (s.name !== 'Blocking' && s.canHandle(ctx)) return s.execute(...);
//     // 全都没认领 → 才用 Blocking
//
// 三类压缩恰好全被抢占：
//     pre-message-auto / user-command → PreMessage (priority 3000)
//     emergency-auto                  → MaxToken   (priority 2000)
// → Blocking 永远不会被选中 → PreCompact/PostCompact 是死代码。
//
// 实测证据（2026-09-17 20:04:27，本机）：CLI 日志打出
// `→ routing to strategy: MaxToken`，整轮压缩到结束（63.4s）零 PreCompact hook
// 进程；唯一与压缩相关的事件是压完之后才发出的 SessionStart(source=compact)。
// 表现就是「压缩上下文时喵状态不动 / 停在上一态」（用户 09-15、09-17 两次反馈）。
//
// ── 唯一的替代信号 ────────────────────────────────────────────────────────
// WorkBuddy 自己的会话状态机把压缩起止写进了 per-workspace 日志：
//   ~/.workbuddy/logs/<YYYY-MM-DD>/<workspace-slug>__<hash>.log
//   … [SessionRunStateMachine] transition | sessionId=<id> | event=COMPACT_STARTED | to=compacting …
//   … [SessionRunStateMachine] transition | sessionId=<id> | event=COMPACT_ENDED   | from=compacting …
// 与 codex-watch 同一套哲学：只读 tail、零配置、零侵入 —— 不看也不改 WorkBuddy
// 的任何配置（它的 hook 位置已经给别的集成占了，改配置会弄坏用户的东西）。
//
// ── 降级 ──────────────────────────────────────────────────────────────────
// 目录/文件不存在、被轮转、格式变了、读不动 —— 一律静默当作「没看见」。最差退回
// hook 单通道的既有行为（压缩期间停在 working），不会更差。

const fs = require('fs');
const os = require('os');
const path = require('path');
const env = require('./env');
const { PRE_COMPACT_TTL_MS } = require('../shared/states');

const DEFAULT_LOG_ROOT = path.join(os.homedir(), '.workbuddy', 'logs');
const POLL_MS = 2000;
const HOT_FILE_MS = 10 * 60 * 1000;   // 只盯最近 10 分钟还在写的日志
const MAX_READ_PER_TICK = 512 * 1024; // 单文件单轮读取上限；读不完下一轮继续
const FIRST_LOOK_BYTES = 256 * 1024;  // 首见一个「还热」的日志时回看的窗口
const MAX_CARRY = 64 * 1024;          // 半行缓存上限（超长行直接丢弃，防内存膨胀）
const DIR_LOOKBACK_DAYS = 2;          // 今天 + 昨天（跨零点的长寿会话）

// 「真正的状态迁移行」才认。同一次压缩期间还会打出 3 条
// `ignored invalid transition … previousEvent=COMPACT_STARTED` 的告警，它们同样
// 含 `transition |` 与 `COMPACT_STARTED` 字样；若只用「包含」判断，一次压缩会被
// 记成三次。所以必须锚定 `] transition |`：告警行是 `] ignored invalid transition |`。
const TRANSITION_MARK = '] transition |';
const STATE_MACHINE = 'SessionRunStateMachine';

// 一行 → { sessionId, started }。不匹配返回 null。导出供测试。
function parseCompactLine(line) {
  if (typeof line !== 'string' || !line) return null;
  if (line.indexOf(STATE_MACHINE) === -1 || line.indexOf(TRANSITION_MARK) === -1) return null;
  let sessionId = null;
  let event = null;
  for (const segment of line.split('|')) {
    const s = segment.trim();
    if (s.startsWith('sessionId=')) sessionId = s.slice('sessionId='.length).trim();
    else if (s.startsWith('event=')) event = s.slice('event='.length).trim();
  }
  if (!sessionId) return null;
  if (event !== 'COMPACT_STARTED' && event !== 'COMPACT_ENDED') return null;
  return { sessionId, started: event === 'COMPACT_STARTED' };
}

// 从一段字节里切出完整行，返回 { lines, carry }。carry 是结尾未换行的半行。
function splitLines(carry, chunk) {
  const text = carry + chunk;
  const parts = text.split('\n');
  const tail = parts.pop();
  // 超长行（日志里没有，但别赌）只保留尾部，避免 carry 无限增长。
  return { lines: parts, carry: tail.length > MAX_CARRY ? tail.slice(-MAX_CARRY) : tail };
}

function dateKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function createWorkbuddyCompactWatch(deps = {}) {
  const core = deps.core;
  const logRoot = deps.logRoot || env.value('WORKBUDDY_LOG_DIR') || DEFAULT_LOG_ROOT;
  const pollMs = Number(deps.pollMs) > 0 ? Number(deps.pollMs) : POLL_MS;
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {};

  /** @type {Map<string, {offset: number, carry: string}>} */
  const cursors = new Map();
  // 已经报了「开始」但还没收到「结束」的会话。只用来判断一条 ENDED 是不是我们
  // 亲眼看着开始的 —— 桌宠中途重启时不能凭一条孤立的 ENDED 就假装压缩结束。
  const compressing = new Set();
  let timer = null;

  function listLogFiles(now) {
    const out = [];
    for (let i = 0; i < DIR_LOOKBACK_DAYS; i += 1) {
      const dir = path.join(logRoot, dateKey(now - i * 24 * 60 * 60 * 1000));
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.log')) continue;
        const fp = path.join(dir, name);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (!st.isFile()) continue;
        out.push({ fp, size: st.size, mtime: st.mtimeMs });
      }
    }
    return out;
  }

  function emit(parsed) {
    const sid = parsed.sessionId;
    if (parsed.started) {
      // 未知会话不建：压缩事件不该凭空造出一个喵列表里根本没有的会话。
      let known = null;
      try { known = core.getSession(sid); } catch { known = null; }
      if (!known) return;
      compressing.add(sid);
      // 自报长 TTL：压缩实测可到 60s+，20s 的默认 oneshot TTL 会在压完之前把
      // sweeping 衰减掉（PostCompact 这条路我们也不指望，兜底必须够长）。
      core.updateSession(sid, 'sweeping', 'PreCompact', { stateTtlMs: PRE_COMPACT_TTL_MS });
      onEvent({ sessionId: sid, event: 'PreCompact' });
      return;
    }
    if (!compressing.delete(sid)) return; // 没看着开始 → 不假装结束
    core.updateSession(sid, 'thinking', 'PostCompact', {});
    onEvent({ sessionId: sid, event: 'PostCompact' });
  }

  function pump(entry, cursor, now) {
    if (entry.size < cursor.offset) { cursor.offset = 0; cursor.carry = ''; } // 被轮转/截断
    if (entry.size === cursor.offset) return;
    const want = Math.min(entry.size - cursor.offset, MAX_READ_PER_TICK);
    let chunk = '';
    try {
      const fd = fs.openSync(entry.fp, 'r');
      try {
        const buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, cursor.offset);
        chunk = buf.toString('utf8', 0, read);
        cursor.offset += read;
      } finally { fs.closeSync(fd); }
    } catch { return; } // 读不到就下一轮再说，游标不动
    const { lines, carry } = splitLines(cursor.carry, chunk);
    cursor.carry = carry;
    // 同一批里同一个会话只认**最后**一条。这条规则同时解决两件事：
    //   · 首见一个还热的日志时窗口里可能躺着一对完整的 STARTED…ENDED（压缩早就
    //     结束了）——只认最后一条 = 只看到 ENDED，而 `compressing` 里没有它，
    //     于是什么都不发，不会在启动瞬间假报一次「压缩中→结束」。
    //   · 窗口里只有一条孤立的 STARTED，说明那一刻确实正在压缩 → 正常点亮。
    const last = new Map();
    for (const line of lines) {
      const parsed = parseCompactLine(line);
      if (parsed) last.set(parsed.sessionId, parsed.started);
    }
    for (const [sid, started] of last) emit({ sessionId: sid, started });
    void now;
  }

  function tick() {
    const now = Date.now();
    for (const entry of listLogFiles(now)) {
      const cold = now - entry.mtime > HOT_FILE_MS;
      let cursor = cursors.get(entry.fp);
      if (!cursor) {
        // 首次见到这个文件：凉的（10 分钟没动）直接对齐到末尾——它就是历史，
        // 回放只会让桌宠一启动就假报「压缩中」。还热的则回看一个有限窗口，
        // 好接住「日志刚出现/桌宠刚重启时正在进行的压缩」；窗口里的完整压缩对
        // 会被上面 pump 的「同批只认最后一条」规则自然抵消掉。
        cursor = { offset: cold ? entry.size : Math.max(0, entry.size - FIRST_LOOK_BYTES), carry: '' };
        cursors.set(entry.fp, cursor);
        if (cold) continue;
      } else if (cold) {
        continue; // 凉了：保留游标，不读
      }
      pump(entry, cursor, now);
    }
  }

  function start() {
    if (timer) return;
    try { tick(); } catch {}
    timer = setInterval(() => { try { tick(); } catch {} }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function isRunning() { return !!timer; }

  return {
    start, stop, isRunning, tick,
    parseCompactLine, _cursors: cursors, _compressing: compressing,
  };
}

module.exports = { createWorkbuddyCompactWatch, parseCompactLine, splitLines, DEFAULT_LOG_ROOT };
