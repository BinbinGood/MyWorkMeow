'use strict';

// 积分周期与剩余额度（纯函数，不碰配置、不碰文件系统）。
//
// 为什么需要它：WorkBuddy 的「剩余积分」只存在于服务端，本机拿不到 —— 桌面端每次
// 打开设置页都实时调计费接口（`auth:getAccountUsage` → `/billing/meter/
// get-user-resource-summary` 等三个接口），结果只在内存里缓存 5 秒，从不落盘。
// 详见交接报告「第四轮」。
//
// 所以这里改成反推：用户手填「每期积分总量」，本机用 metering 已记的消耗去减。
//
// 「已用」的来源是各 provider 计量模块的 getStats().daily —— 形如
//   { '2026-09-15': { tokens, cost, credit, msgs, ... }, ... }
// 键由 backend/metering-common.js 的 dayKey() 生成，内部用
// getFullYear/getMonth/getDate，所以是**本地时区的自然日**，既不是滚动 24 小时，
// 也不是 UTC。保留期 DAILY_KEEP_DAYS = 95 天，覆盖单个计费周期绰绰有余。

const { dayKey } = require('./metering-common');

const MIN_RESET_DAY = 1;
// 上限 28 是刻意的：29/30/31 在短月份里会跳日（2 月没有 30 号），限制在 28 就
// 不必为每个月单独处理「落到下月 1 号」这类边界。订阅重置日几乎都落在 1~28。
const MAX_RESET_DAY = 28;
const DEFAULT_RESET_DAY = 1;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clampResetDay(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_RESET_DAY;
  return Math.min(MAX_RESET_DAY, Math.max(MIN_RESET_DAY, n));
}

// 本期的起始日（含），返回 'YYYY-MM-DD'。
// 今天还没到本月的重置日，说明本期是**上个月**开始的那一期。
function cycleStartKey(now = Date.now(), resetDay = DEFAULT_RESET_DAY) {
  const day = clampResetDay(resetDay);
  const date = new Date(now);
  let year = date.getFullYear();
  let month = date.getMonth();
  if (date.getDate() < day) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
  }
  // day <= 28，所以 new Date(year, month, day) 不会溢出到下个月。
  return dayKey(new Date(year, month, day));
}

// 本期已用积分。只累计落在 [本期起始日, 今天] 闭区间内的自然日桶。
// dayKey 是零填充的 YYYY-MM-DD，字符串比较与日期比较等价。
function sumCycleCredit(daily, now = Date.now(), resetDay = DEFAULT_RESET_DAY) {
  const startKey = cycleStartKey(now, resetDay);
  const todayKey = dayKey(now);
  const buckets = daily && typeof daily === 'object' ? daily : {};
  let used = 0;
  let days = 0;
  for (const [key, value] of Object.entries(buckets)) {
    if (key < startKey || key > todayKey) continue;
    used += num(value && value.credit);
    days += 1;
  }
  return { used, days, startKey, todayKey };
}

// 剩余额度。没配额度（或配了个非正数）返回 null —— 调用方据此**整段不显示**，
// 而不是显示一个 0：0 会被读成「额度已经用完」，那是完全不同的意思。
// 反过来，真的算到 0 是有效值，要正常显示。
function remainingQuota(monthly, used) {
  const total = num(monthly);
  if (total <= 0) return null;
  return Math.max(0, total - num(used));
}

module.exports = {
  MIN_RESET_DAY,
  MAX_RESET_DAY,
  DEFAULT_RESET_DAY,
  clampResetDay,
  cycleStartKey,
  sumCycleCredit,
  remainingQuota,
};
