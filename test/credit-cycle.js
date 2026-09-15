'use strict';

// Regression test for backend/credit-cycle.js —— 本期已用积分与剩余额度。
//
// 要防的正靶：
//  ① 「今天/本期」必须是**本地时区的自然日**，不是 UTC，也不是滚动 24 小时。
//     本机在 GMT+8，所以本地 9/16 00:30 的 UTC 日期其实还是 9/15 —— 用 UTC 分桶
//     会把跨零点那半小时的用量算到前一天，测试用这个时间点卡住它。
//  ② 「没填额度」和「额度用尽」是两件事：前者返回 null（调用方隐藏整段），
//     后者返回 0（必须显示）。混了就会看到「剩余 0」而其实压根没配。

const { dayKey } = require('../backend/metering-common');
const cycle = require('../backend/credit-cycle');

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok -', msg);
}

// ── 重置日取值 ────────────────────────────────────────────────────────────────
assert(cycle.clampResetDay(15) === 15, 'clampResetDay keeps a valid day');
assert(cycle.clampResetDay('7') === 7, 'clampResetDay accepts a numeric string');
assert(cycle.clampResetDay(0) === 1, 'clampResetDay floors at 1');
assert(cycle.clampResetDay(-3) === 1, 'clampResetDay floors a negative value');
assert(cycle.clampResetDay(31) === cycle.MAX_RESET_DAY, 'clampResetDay caps at MAX_RESET_DAY');
assert(cycle.clampResetDay(29) === 28, 'clampResetDay caps 29 — February has no 29th in most years');
assert(cycle.clampResetDay(2.6) === 3, 'clampResetDay rounds');
assert(cycle.clampResetDay(undefined) === cycle.DEFAULT_RESET_DAY, 'clampResetDay falls back to the default');
assert(cycle.clampResetDay('abc') === cycle.DEFAULT_RESET_DAY, 'clampResetDay rejects garbage');

// ── 本期起始日 ────────────────────────────────────────────────────────────────
// 用本地时间构造（new Date(y, m, d) 是本地时区），避免测试自己被 UTC 影响。
assert(cycle.cycleStartKey(new Date(2026, 8, 15).getTime(), 1) === '2026-09-01',
  'resetDay 1 → the cycle starts on the 1st of this month');
assert(cycle.cycleStartKey(new Date(2026, 8, 15).getTime(), 20) === '2026-08-20',
  'before the reset day the cycle still belongs to last month');
assert(cycle.cycleStartKey(new Date(2026, 8, 20).getTime(), 20) === '2026-09-20',
  'on the reset day itself the cycle has already rolled over');
assert(cycle.cycleStartKey(new Date(2026, 8, 20).getTime(), 21) === '2026-08-21',
  'one day before the reset the cycle is still the previous one');
assert(cycle.cycleStartKey(new Date(2026, 0, 5).getTime(), 20) === '2025-12-20',
  'the rollback crosses the year boundary');
assert(cycle.cycleStartKey(new Date(2026, 8, 15).getTime(), 99) === '2026-08-28',
  'an out-of-range reset day is clamped to 28 — and since the 15th is before the 28th, the cycle is last month\'s');

// ── 「今天」= 本地自然日（不是 UTC） ──────────────────────────────────────────
const afterMidnight = new Date(2026, 8, 16, 0, 30);
const beforeMidnight = new Date(2026, 8, 15, 23, 30);
assert(dayKey(afterMidnight.getTime()) === '2026-09-16',
  'local 00:30 counts as the new calendar day (UTC would still say 09-15 on GMT+8)');
assert(dayKey(beforeMidnight.getTime()) === '2026-09-15', 'local 23:30 still belongs to the same day');
assert(cycle.sumCycleCredit({}, afterMidnight.getTime(), 1).todayKey === '2026-09-16',
  'sumCycleCredit reports the local calendar day');

// ── 本期求和 ──────────────────────────────────────────────────────────────────
const daily = {
  '2026-08-19': { credit: 999 },   // 落在本期之前（resetDay 20）→ 不计
  '2026-08-20': { credit: 10 },    // 本期第一天 → 计
  '2026-09-01': { credit: 20.5 },  // 计
  '2026-09-15': { credit: 30 },    // 今天 → 计
  '2026-09-16': { credit: 777 },   // 未来（理论上不该有）→ 不计
};
const sum = cycle.sumCycleCredit(daily, new Date(2026, 8, 15).getTime(), 20);
assert(Math.abs(sum.used - 60.5) < 1e-9, `cycle sum = 10 + 20.5 + 30 (got ${sum.used})`);
assert(sum.days === 3, `only in-cycle days are counted (got ${sum.days})`);
assert(sum.startKey === '2026-08-20' && sum.todayKey === '2026-09-15', 'the range is reported back');

// resetDay 默认为 1 时，上个月的和就不再计入
const monthOnly = cycle.sumCycleCredit(daily, new Date(2026, 8, 15).getTime(), 1);
assert(Math.abs(monthOnly.used - 50.5) < 1e-9, `resetDay 1 drops the August bucket (got ${monthOnly.used})`);

// 健壮性：缺 daily / 脏数据都不能抛
assert(cycle.sumCycleCredit(undefined, Date.now(), 1).used === 0, 'a missing daily map sums to 0');
assert(cycle.sumCycleCredit(null, Date.now(), 1).used === 0, 'a null daily map sums to 0');
assert(cycle.sumCycleCredit({ '2026-09-15': null }, new Date(2026, 8, 15).getTime(), 1).used === 0,
  'a null bucket contributes 0');
assert(cycle.sumCycleCredit({ '2026-09-15': { credit: -5 } }, new Date(2026, 8, 15).getTime(), 1).used === 0,
  'a negative credit is ignored, not subtracted');

// ── 剩余额度 ──────────────────────────────────────────────────────────────────
assert(cycle.remainingQuota(3600, 1754.9) === 1845.1, 'remaining = monthly − used');
assert(cycle.remainingQuota(3600, 0) === 3600, 'an untouched cycle shows the full quota');
assert(cycle.remainingQuota(3600, 4000) === 0, 'overspending clamps to 0 rather than going negative');
assert(cycle.remainingQuota(null, 100) === null, 'an unset quota stays null — not 0');
assert(cycle.remainingQuota(0, 100) === null, 'a zero quota means "not configured", not "exhausted"');
assert(cycle.remainingQuota(3600, undefined) === 3600, 'a missing used value counts as 0');

// 端到端：手填 3600、resetDay 1、本机 9 月已用 1754.9 → 剩余 1845.1
const e2e = cycle.remainingQuota(3600, cycle.sumCycleCredit({
  '2026-08-31': { credit: 500 },
  '2026-09-01': { credit: 1000 },
  '2026-09-15': { credit: 754.9 },
}, new Date(2026, 8, 15).getTime(), 1).used);
assert(Math.abs(e2e - 1845.1) < 1e-9, `end-to-end remaining (got ${e2e})`);

console.log('\nCREDIT CYCLE TESTS PASSED');
