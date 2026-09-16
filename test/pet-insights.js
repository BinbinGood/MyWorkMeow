'use strict';

// Provider-agnostic presentation contract for the situation capsule and the
// purr-payday summary. Keep these checks against the shared helper so changes
// to one supported AI source cannot silently change the merged UI semantics.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const insights = require('../shared/pet-insights');

const root = path.join(__dirname, '..');
const petHtml = fs.readFileSync(path.join(root, 'renderer', 'pet.html'), 'utf8');
const petJs = fs.readFileSync(path.join(root, 'renderer', 'pet.js'), 'utf8');
const petCss = fs.readFileSync(path.join(root, 'renderer', 'pet.css'), 'utf8');

const base = (over = {}) => ({
  today: { tokens: 0, cost: 0, messages: 0 },
  sessions: [],
  waitingCount: 0,
  needsinputCount: 0,
  workingCount: 0,
  jugglingCount: 0,
  sweepingCount: 0,
  thinkingCount: 0,
  loafingCount: 0,
  errorCount: 0,
  idleMs: 1000,
  ...over,
});

assert.deepStrictEqual(insights.BUSY_STATES, ['working', 'juggling', 'sweeping', 'thinking', 'loafing']);

const attention = insights.context(base({
  waitingCount: 1,
  needsinputCount: 2,
  workingCount: 3,
}));
assert.strictEqual(attention.kind, 'waiting', 'authorization must outrank reply and active work');
assert.strictEqual(attention.count, 1);
assert.strictEqual(attention.needsinput, 2);

const errorAttention = insights.context(base({ errorCount: 1, needsinputCount: 1 }));
assert.strictEqual(errorAttention.kind, 'error',
  'capsule priority must match the renderer: error outranks needsinput');

const active = insights.context(base({
  workingCount: 1,
  sessions: [{ state: 'working', agent: 'codex', createdAt: 100, headless: false }],
}));
assert.strictEqual(active.kind, 'active');
assert.strictEqual(active.state, 'working');
assert.strictEqual(active.primary.agent, 'codex');

const allSupportedAgents = ['claude', 'codex', 'trae', 'workbuddy', 'opencode'];
const mergedAgents = insights.context(base({
  workingCount: allSupportedAgents.length,
  sessions: allSupportedAgents.map((agent, index) => ({
    state: 'working', agent, createdAt: 100 + index, headless: false,
  })),
}));
assert.strictEqual(mergedAgents.activeCount, allSupportedAgents.length,
  'the capsule must aggregate every supported AI tool through the shared snapshot');

const sleeping = insights.context(base({ idleMs: null }));
assert.strictEqual(sleeping.kind, 'sleeping');
assert.strictEqual(insights.hasActiveWork(sleeping), false);

const freshIdle = insights.context(base({ idleMs: 1000 }));
assert.strictEqual(freshIdle.recentDone, false,
  'a short global idle timer must not impersonate a completed turn');
const explicitDone = insights.context(base({
  idleMs: 500,
  sessions: [{ state: 'idle', badge: 'done', idleMs: 500 }],
}));
assert.strictEqual(explicitDone.recentDone, true,
  'the completion capsule must still react to an explicit done badge');

const mergedUsage = insights.usage({
  today: {
    input: 100,
    inputTotal: 180,
    cacheRead: 80,
    tokens: 240,
    cost: 0.42,
    messages: 7,
  },
});
assert.deepStrictEqual(mergedUsage, {
  rounds: 7,
  tokens: 240,
  cost: 0.42,
  cacheRead: 80,
  inputTotal: 180,
  cacheRate: (80 / 180) * 100,
});

assert(/id="chip-context"/.test(petHtml), 'situation capsule needs a dedicated context label');
assert(/shared\/pet-insights\.js/.test(petHtml), 'renderer must load the shared insight contract');
assert(/const PURR_HOLD_MS = 1100;/.test(petJs), 'purr easter egg must use a long press');
assert(/function triggerPurrPayday\(\)/.test(petJs), 'purr payday trigger must remain explicit');
assert(/purr-payday-day/.test(petJs), 'purr payday must deduplicate its daily headline locally');
assert(/const HIT_SEL = '#cat,#stage\.cat-hidden #chip,/.test(petJs),
  'the hidden-cat capsule must remain a native hit target for drag and interaction');
assert(/\.chip-context\s*\{[\s\S]*?flex:\s*0 0 auto;/.test(petCss),
  'primary situation label must not shrink before token/cost details');
assert(/\.chip\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?min-height:\s*21px;/.test(petCss),
  'the whole capsule must keep a stable height when the stage is over-constrained');
assert(/\.bubble\.hidden\s*\{[\s\S]*?display:\s*none;/.test(petCss),
  'a hidden long bubble must not remain in the flex layout after popup collapse');
assert(/\.sessions\s*\{[\s\S]*?flex:\s*0 0 auto;/.test(petCss),
  'session dots must not be compressed with the capsule');
assert(/#cat\s*\{[\s\S]*?flex:\s*0 0 auto;/.test(petCss),
  'the cat frame must not be compressed with the capsule');
assert(/\.chip-tokens, \.chip-cost\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?overflow:\s*visible;/.test(petCss),
  'token/cost details must retain their intrinsic width');
assert(/function fitRestingFrame\(/.test(petJs) && /fitRestingFrame\(\);/.test(petJs),
  'resting capsule width must be measured and applied dynamically');
assert(/function positionProp\(\)[\s\S]*sessionRect[\s\S]*sessionRect\.left/.test(petJs),
  'compact mode must position the live tool icon before the status dots');

// ── #cat 的滤镜链层数必须恒定 ────────────────────────────────────────────────
// 2026-09-16 的回归靶子。切进/切出 waiting/needsinput/error/loved 时如果滤镜链的
// **结构**变了（静息 1 层 → 醒目 2 层），Chromium 要重建整个 #cat 子树的滤镜缓冲，
// 而这与同一次 setState() 里的 catImg.src 赋值撞在一帧 —— macOS 上表现为猫周围
// 一圈拖影。所以静息态也得占位一层 drop-shadow(0 0 0 transparent)，
// 四个醒目态只改参数。
// 这条不测「好不好看」，只测层数一致 —— 光晕颜色随便调，层数不能变。
const catFilters = [...petCss.matchAll(/#cat(?:\.[a-z]+)?(?:,\s*\n#cat\.[a-z]+)?\s*\{[^}]*?filter:\s*([^;]+);/g)]
  .map((m) => m[1].match(/drop-shadow/g).length);
assert(catFilters.length >= 4,
  `every #cat state rule must declare a filter (found ${catFilters.length})`);
assert(new Set(catFilters).size === 1,
  `#cat's filter must keep a constant number of drop-shadow layers across states (got ${catFilters.join('/')})`);
assert(catFilters[0] === 2, `the chain is two layers: glow + ground shadow (got ${catFilters[0]})`);
// 透明窗口的全透明底色。缺省是不透明白，macOS 合成器靠它判断该清哪块。
assert(/transparent:\s*true,[\s\S]{0,400}?backgroundColor:\s*'#00000000'/.test(
  fs.readFileSync(path.join(root, 'main.js'), 'utf8')),
'the transparent pet window must declare a fully transparent backgroundColor');

console.log('pet insight checks passed');
