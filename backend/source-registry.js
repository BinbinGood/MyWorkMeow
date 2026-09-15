'use strict';

// One registry for the sources that feed the merged pet/panel contract.
// Source-specific watchers and metering parsers stay in their own modules;
// this file only owns the stable identity and display label used when those
// modules are combined. Adding a source here keeps the aggregation lists in
// main.js and usage-stats.js in sync.
// `creditQuota` 标记「这个数据源的余量需要用户手填或另有来源」。目前只有
// WorkBuddy：它的积分余额只存在于服务端，本机拿不到，只能由用户手填每期总量、
// 再用本机已用反推剩余（见 backend/credit-cycle.js）。Codex 的额度是它自己的
// 接口给的，不需要手填，所以不打这个标记。
const SOURCE_REGISTRY = Object.freeze([
  Object.freeze({ id: 'claude', label: 'Claude' }),
  Object.freeze({ id: 'codex', label: 'Codex' }),
  Object.freeze({ id: 'workbuddy', label: 'WorkBuddy', creditQuota: true }),
  Object.freeze({ id: 'trae', label: 'TRAE' }),
  Object.freeze({ id: 'opencode', label: 'opencode' }),
]);

const SOURCE_IDS = Object.freeze(SOURCE_REGISTRY.map(({ id }) => id));

function withValues(values = {}) {
  return SOURCE_REGISTRY.map((source) => ({
    ...source,
    value: values && typeof values === 'object' ? values[source.id] ?? null : null,
  }));
}

// 「这个数据源的余量要不要用户手填」。用途：设置页那一项、底部展示栏的额度槽位
// 都得知道该挂在谁身上，不能写死某一个 agent。
function supportsCreditQuota(id) {
  const row = SOURCE_REGISTRY.find((source) => source.id === id);
  return !!(row && row.creditQuota === true);
}

module.exports = { SOURCE_REGISTRY, SOURCE_IDS, withValues, supportsCreditQuota };
