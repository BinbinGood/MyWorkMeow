'use strict';

// 单宠时代（2026-08-07 起）：永远只有一只打工喵盯全部工具，AGENT 恒为 'all'。
// 该常量保留仅为兼容旧查询参数与下方少量分支判断。
const AGENT = new URLSearchParams(location.search).get('agent') || 'all';

const stage = document.getElementById('stage');
const cat = document.getElementById('cat');
// 猫 + 胶囊那一列。弹窗贴边时会给它加帧内偏移（popupShiftPlan 算出的 catShift），
// 把猫往帧中心挪、腾出弹窗阴影的地方；主进程随后按锚点把整个帧反向挪回来，
// 净效果是猫在屏幕上一动不动。详见 applyCatShift 的注释。
const compactRow = document.getElementById('compact-row');

// 状态 GIF 缺失或加载失败时使用仓库自带的静态猫图。
const catImg = document.getElementById('cat-img');
const CAT_FALLBACK = '../assets/salary-cat.png';
if (catImg) {
  catImg.onerror = () => {
    if (!catAssetMatches(CAT_FALLBACK)) catImg.src = CAT_FALLBACK;
  };
}
const PET_ASSET_REGISTRY = window.WorkMeowPetAssets;
let petAssetCatalog = PET_ASSET_REGISTRY.defaultCatalog();

/* ── GIF 换图：先解码，再挂上去 ────────────────────────────────────────────────
   裸赋值 `catImg.src = url` 的问题：Chromium 在新 GIF 的首帧解码完成前**继续显示
   旧图**。cat-working-2.gif 是 265 KB / ~44 帧，这个窗口期肉眼可见，就是用户说的
   「切状态时旧姿势卡一下才跳过去」。
   放大因素是 nextPoolFile 的洗牌队列：每次进 working 抽 5 张里**不同**的一张，
   永远命中不了上次已解码的那张（ambient-awake 有 8 张，更极端）。
   img.decode() 等首帧解码完成，之后的赋值就是命中缓存的即时切换。
   三条边界：
     · 沙箱/无 Image 环境走同步赋值 —— 测试紧跟着断言 src，异步会读到旧值；
     · 解码失败（素材损坏、workmeow-asset:// 取不到）照旧赋值，让 onerror 兜底，
       绝不因为解码不过就卡着不换图；
     · seq 守卫：两次换图叠在一起时，晚出发的赢，先出发的那次 resolve 了也不许
       把画面拽回去。 */
const warmedAssets = new Set();
let catSwapSeq = 0;

function warmAsset(url) {
  if (!url || warmedAssets.has(url)) return null;
  if (typeof Image !== 'function') return null;
  let img;
  try { img = new Image(); } catch { return null; }
  img.src = url;
  if (typeof img.decode !== 'function') { warmedAssets.add(url); return null; }
  return img.decode().then(() => { warmedAssets.add(url); }, () => {});
}

function swapCatAsset(source) {
  if (!catImg || !source || catAssetMatches(source)) return;
  const seq = ++catSwapSeq;
  const pending = warmAsset(source);
  if (!pending) { catImg.src = source; return; }
  // 超时兜底：解码慢于人眼耐受度（约 120ms）就先换过去，宁可闪一下也不僵着。
  let done = false;
  const commit = () => {
    if (done || seq !== catSwapSeq) return;
    done = true;
    if (!catAssetMatches(source)) catImg.src = source;
  };
  pending.then(commit);
  setTimeout(commit, 120);
}

// 进入某状态时顺手预热该池的**下一张**，把解码成本挪到空闲期 —— 轮换定时器
// 60s 才动一次，这段时间足够解码完，届时是命中缓存的瞬时切换。
function warmPoolNext(name, pool) {
  if (!Array.isArray(pool) || pool.length < 2) return;
  const cycle = poolCycles.get(name);
  const next = cycle && cycle.remaining.length ? cycle.remaining[0] : null;
  if (next) warmAsset(next);
}

function slotAssetUrls(slotId) {
  const slot = petAssetCatalog.slots[slotId];
  return slot && Array.isArray(slot.active) ? slot.active.map((asset) => asset.url).filter(Boolean) : [];
}

function stateAssetUrls(stateName) {
  const slotId = PET_ASSET_REGISTRY.slotForState(stateName);
  const active = slotAssetUrls(slotId);
  return active.length ? active : slotAssetUrls('idle');
}

function applyPetAssetCatalog(next) {
  petAssetCatalog = PET_ASSET_REGISTRY.normalizeCatalog(next);
  poolCycles.clear();
  stopPoolRot();
  ambientStop();
  xiabanVisualKey = null;
  xiabanVisualAsset = null;
  updateCat(state);
}

// Any state can now have more than one pose. Entering a state chooses one,
// then a long-running state rotates every 60 seconds. Each state owns an
// independent shuffled cycle so adding a custom pose never causes repeats.
const POOL_ROTATE_MS = 60 * 1000;
let poolRot = null;
let poolState = null;
const poolCycles = new Map();

function shufflePool(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function nextPoolFile(name, pool) {
  const signature = pool.join('\u0000');
  let cycle = poolCycles.get(name);
  if (!cycle || cycle.signature !== signature || cycle.remaining.length === 0) {
    const remaining = shufflePool(pool);
    // 洗牌仍然是随机的，但避免跨轮次紧挨着播出同一张，观感更自然。
    if (cycle && cycle.last && remaining.length > 1 && remaining[0] === cycle.last) {
      const swap = 1 + Math.floor(Math.random() * (remaining.length - 1));
      [remaining[0], remaining[swap]] = [remaining[swap], remaining[0]];
    }
    cycle = { signature, remaining, last: null };
    poolCycles.set(name, cycle);
  }
  const file = cycle.remaining.shift();
  cycle.last = file;
  return file;
}

function showPoolFile(name, pool) {
  const source = nextPoolFile(name, pool);
  swapCatAsset(source);
  warmPoolNext(name, pool);
}

function stopPoolRot() {
  if (poolRot) clearInterval(poolRot);
  poolRot = null;
  poolState = null;
}

/* ====================================================================
   闲时作息（ambient）：无任务时的「下班生活」
   --------------------------------------------------------------------
   一直播同一张睡觉图既呆板又不真实——人闲下来也不是倒头就睡。这里挂一层
   **只影响画面、不改语义**的作息表：语义态仍然是 sleeping（会话点过滤、
   气泡抑制、playAction 屏蔽、STATES.md 优先级全部照旧），变的只有两样：
   显示哪张 GIF，以及 💤 角标亮不亮。

   为什么不直接把语义态改成 loafing/idle：loafing 现在的含义是「任务进行中
   的工具间隙」，idle 是「一轮已收尾、等你下一句」。若无任务时也复用它们，
   你就再也无法一眼分辨「喵在摸鱼」到底有没有活在跑，诊断价值直接归零。

   作息曲线：越闲越困。刚下班基本在活动，夜深了基本在睡，但任何阶段都保留
   反向可能——所以永远不会静止成一张图。
   ==================================================================== */
function ambientScenes(wantSleep) {
  const slotId = wantSleep ? 'ambient-sleep' : 'ambient-awake';
  return slotAssetUrls(slotId).map((url) => ({
    gif: url,
    sleep: wantSleep,
    hold: /\/cat-roam\.gif(?:[?#]|$)/.test(url) ? [8000, 16000] : null,
  }));
}
// awake = 抽到「醒着的活动」的概率；hold = 片段停留时长区间（区间内随机，避免机械感）。
// maxSleepRun / maxAwakeRun 是节奏护栏：概率负责自然感，护栏保证不会一直睡或一直醒。
// 越往后不只是越困，切换也越慢——睡沉了还每 30 秒换个睡姿，看着像在发抖。
const AMBIENT_PHASES = [
  { until: 5 * 60 * 1000,  awake: 0.85, hold: [15000, 35000], maxSleepRun: 2, maxAwakeRun: 4 },  // 刚下班：几乎都在活动，节奏快
  { until: 20 * 60 * 1000, awake: 0.45, hold: [25000, 55000], maxSleepRun: 2, maxAwakeRun: 3 },  // 犯困期：活动与打盹各半
  { until: Infinity,       awake: 0.15, hold: [45000, 120000], maxSleepRun: 3, maxAwakeRun: 2 }, // 夜深了：以睡为主，偶尔翻身摸手机
];
let ambientAt = 0;      // 进入闲时作息的时刻
let ambientTimer = null;
let ambientGif = null;  // 当前片段，用于判断是否刚进入闲时
let ambientSleepRun = 0; // 连续睡觉片段数；超过阶段护栏就安排醒来活动
let ambientAwakeRun = 0; // 连续醒着片段数；超过阶段护栏就安排打盹
const ambientCycles = new Map(); // 睡觉/醒着各自独立的一轮随机队列

function ambientPhase() {
  const elapsed = perfNow() - ambientAt;
  return AMBIENT_PHASES.find((p) => elapsed < p.until) || AMBIENT_PHASES[AMBIENT_PHASES.length - 1];
}

function nextAmbientScene(wantSleep) {
  let same = ambientScenes(wantSleep);
  if (!same.length) same = ambientScenes(!wantSleep);
  const key = wantSleep ? 'sleep' : 'awake';
  let cycle = ambientCycles.get(key);
  const signature = same.map((scene) => scene.gif).join('\u0000');
  if (!cycle || cycle.signature !== signature || cycle.remaining.length === 0) {
    const remaining = shufflePool(same);
    if (cycle && cycle.last && remaining.length > 1 && remaining[0].gif === cycle.last) {
      const swap = 1 + Math.floor(Math.random() * (remaining.length - 1));
      [remaining[0], remaining[swap]] = [remaining[swap], remaining[0]];
    }
    cycle = { signature, remaining, last: null };
    ambientCycles.set(key, cycle);
  }
  const scene = cycle.remaining.shift();
  cycle.last = scene.gif;
  return scene;
}

function ambientPick(phase) {
  let wantSleep;
  if (ambientGif == null) {
    // 刚结束一轮工作先缓一会儿：第一幕固定是待命/摸鱼/发呆，不会一进闲置就倒头睡。
    wantSleep = false;
  } else if (ambientSleepRun >= phase.maxSleepRun) {
    wantSleep = false;
  } else if (ambientAwakeRun >= phase.maxAwakeRun) {
    wantSleep = true;
  } else {
    wantSleep = Math.random() >= phase.awake;
  }
  return nextAmbientScene(wantSleep);
}

function ambientStep() {
  const phase = ambientPhase();
  const sc = ambientPick(phase);
  ambientGif = sc.gif;
  if (sc.sleep) {
    ambientSleepRun++;
    ambientAwakeRun = 0;
  } else {
    ambientAwakeRun++;
    ambientSleepRun = 0;
  }
  swapCatAsset(sc.gif);
  if (sleepEl) sleepEl.classList.toggle('on', sc.sleep); // 💤 只在真睡的片段亮
  const [lo, hi] = sc.hold || phase.hold; // 片段自带时长优先（如 roam 幅度大要短播）
  ambientTimer = setTimeout(ambientStep, lo + Math.random() * (hi - lo));
}

function ambientStart() {
  if (ambientTimer) return; // 已在跑：保留时段进度，别把「越闲越困」重置回刚下班
  ambientAt = perfNow();
  ambientGif = null;
  ambientSleepRun = 0;
  ambientAwakeRun = 0;
  ambientStep();
}

function ambientStop() {
  if (ambientTimer) { clearTimeout(ambientTimer); ambientTimer = null; }
  ambientGif = null;
  ambientSleepRun = 0;
  ambientAwakeRun = 0;
}

// 定时下班片段：只在本机当地时间的两个下班窗口播放，且只覆盖真正无任务的
// idle/sleeping。它不是业务状态，不会把 sleeping 伪装成 loafing，也不会盖住工作。
const XIABAN_DURATION_MS = 10 * 60 * 1000;
const XIABAN_DEFAULT_TIMES = Object.freeze({ lunch: '10:55', evening: '16:55' });
let xiabanSchedule = { ...XIABAN_DEFAULT_TIMES };
const XIABAN_STATES = new Set(['idle', 'sleeping']);
const XIABAN_COPY_KEYS = {
  lunch: ['bub.xiabanLunch1', 'bub.xiabanLunch2', 'bub.xiabanLunch3'],
  evening: ['bub.xiabanEvening1', 'bub.xiabanEvening2', 'bub.xiabanEvening3'],
};
const XIABAN_ANNOUNCED_STORAGE_KEY = 'workmeow.xiaban-announced-window';
let xiabanTimer = null;
let xiabanVisualKey = null;
let xiabanVisualAsset = null;
let xiabanAnnouncedWindow = (() => {
  try { return window.localStorage && window.localStorage.getItem(XIABAN_ANNOUNCED_STORAGE_KEY); }
  catch { return null; }
})();

function isXiabanClockTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function xiabanStartEntries() {
  return [
    { period: 'lunch', time: xiabanSchedule.lunch },
    { period: 'evening', time: xiabanSchedule.evening },
  ].filter((entry) => isXiabanClockTime(entry.time)).map((entry) => ({
    ...entry,
    startMin: Number(entry.time.slice(0, 2)) * 60 + Number(entry.time.slice(3)),
  }));
}

function applyXiabanSchedule(next) {
  if (!next || !isXiabanClockTime(next.lunch) || !isXiabanClockTime(next.evening)) return false;
  xiabanSchedule = { lunch: next.lunch, evening: next.evening };
  if (xiabanTimer) {
    clearTimeout(xiabanTimer);
    xiabanTimer = null;
  }
  scheduleXiabanBoundary();
  if (XIABAN_STATES.has(state)) updateCat(state);
  return true;
}

function xiabanWindow(now = Date.now()) {
  const d = new Date(now);
  const dayMs = (((d.getHours() * 60 + d.getMinutes()) * 60 + d.getSeconds()) * 1000) + d.getMilliseconds();
  for (const entry of xiabanStartEntries()) {
    const { startMin } = entry;
    const startMs = startMin * 60 * 1000;
    if (dayMs >= startMs && dayMs < startMs + XIABAN_DURATION_MS) {
      // 日期 + 时段共同组成去重 key：同一窗口反复收到状态
      // 快照也只播报一次，第二天自动解锁。
      const dateKey = [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');
      return {
        remainingMs: startMs + XIABAN_DURATION_MS - dayMs,
        period: entry.period,
        key: `${dateKey}:${startMin}`,
      };
    }
  }
  return null;
}

function xiabanBoundaryDelay(now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let best = Infinity;
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const day = new Date(today);
    day.setDate(day.getDate() + dayOffset);
    for (const entry of xiabanStartEntries()) {
      const { startMin } = entry;
      const start = new Date(day);
      start.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
      for (const boundary of [start.getTime(), start.getTime() + XIABAN_DURATION_MS]) {
        const delay = boundary - now;
        if (delay > 100) best = Math.min(best, delay);
      }
    }
  }
  return Number.isFinite(best) ? Math.max(250, best) : 60 * 60 * 1000;
}

function scheduleXiabanBoundary() {
  if (xiabanTimer) return;
  xiabanTimer = setTimeout(() => {
    xiabanTimer = null;
    updateCat(state);
    scheduleXiabanBoundary();
  }, xiabanBoundaryDelay());
}

function announceXiaban(info) {
  if (!info || xiabanAnnouncedWindow === info.key) return;
  // 用户正在操作卡片/菜单时不抢界面，也不先标记已播报；
  // 下一次状态快照进来后仍可以补播。
  if (askActive || actionPopOpen || radialOpen || peekOpen) return;
  const keys = XIABAN_COPY_KEYS[info.period] || XIABAN_COPY_KEYS.evening;
  const key = keys[Math.floor(Math.random() * keys.length)];
  xiabanAnnouncedWindow = info.key;
  // 记住最近一个已播报窗口，避免在 10 分钟内重启应用后
  // 又立即播一次；新日期/新时段的 key 不同，会正常解锁。
  try { if (window.localStorage) window.localStorage.setItem(XIABAN_ANNOUNCED_STORAGE_KEY, info.key); } catch {}
  showBubble(t(key), Math.min(6500, Math.max(3200, info.remainingMs)));
}

function xiabanMaybeShow(s) {
  scheduleXiabanBoundary();
  const info = xiabanWindow();
  if (!XIABAN_STATES.has(s) || !info) {
    xiabanVisualKey = null;
    xiabanVisualAsset = null;
    return false;
  }
  const pool = slotAssetUrls('xiaban');
  if (!pool.length) return false;
  if (xiabanVisualKey !== info.key || !xiabanVisualAsset) {
    xiabanVisualKey = info.key;
    xiabanVisualAsset = nextPoolFile('xiaban', pool);
  }
  swapCatAsset(xiabanVisualAsset);
  if (sleepEl) sleepEl.classList.remove('on');
  announceXiaban(info);
  return true;
}

function updateCat(s) {
  if (!catImg) return;
  if (xiabanMaybeShow(s)) {
    ambientStop();
    stopPoolRot();
    return;
  }
  if (s === 'sleeping') { stopPoolRot(); ambientStart(); return; } // 画面交给作息表
  ambientStop();
  const pool = stateAssetUrls(s);
  if (pool.length) {
    if (poolState !== s) {
      stopPoolRot();
      poolState = s;
      showPoolFile(s, pool);
      poolRot = setInterval(() => {
        const cur = stateAssetUrls(state);
        if (!cur.length || state !== s) { stopPoolRot(); return; }
        showPoolFile(s, cur);
      }, POOL_ROTATE_MS);
    }
  } else {
    stopPoolRot();
  }
}

function catAssetMatches(source) {
  if (!catImg) return false;
  try {
    return new URL(catImg.src, window.location.href).href === new URL(source, window.location.href).href;
  } catch {
    return String(catImg.getAttribute('src') || '') === String(source || '');
  }
}
const bubble = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const chipCost = document.getElementById('chip-cost');
const chipTokens = document.getElementById('chip-tokens');
const chipContext = document.getElementById('chip-context');
const chip = document.getElementById('chip');
const quotaEl = document.getElementById('chip-quota');
const quotaPopover = document.getElementById('quota-popover');
const quotaPopoverTitle = document.getElementById('quota-popover-title');
const quotaPopoverStatus = document.getElementById('quota-popover-status');
const quotaPopoverRows = document.getElementById('quota-popover-rows');
const quotaPopoverInsight = document.getElementById('quota-popover-insight');
const quotaPopoverUpdated = document.getElementById('quota-popover-updated');
const quotaPopoverHint = document.getElementById('quota-popover-hint');
const quotaPopoverClose = document.getElementById('quota-popover-close');
const sessionsEl = document.getElementById('sessions');
const radial = document.getElementById('radial');
const thinkEl = document.getElementById('think');
const sleepEl = document.getElementById('sleep');
const propEl = document.getElementById('prop');
const sidekickEl = document.getElementById('sidekick');
const askEl = document.getElementById('ask');
const askScroll = document.getElementById('ask-scroll');
const askLabel = document.getElementById('ask-label');
const askSess = document.getElementById('ask-sess');
const askQhead = document.getElementById('ask-qhead');
const askQ = document.getElementById('ask-q');
const askHint = document.getElementById('ask-hint');
const askOpts = document.getElementById('ask-opts');
const askInputRow = document.getElementById('ask-input-row'); // .ask-other
const askText = document.getElementById('ask-text');
const askPage = document.getElementById('ask-page');
const askFoot = document.getElementById('ask-foot');
const askSubmit = document.getElementById('ask-submit');
const askBack = document.getElementById('ask-back');
const askTerm = document.getElementById('ask-term');
const notepad = document.getElementById('notepad');
const npBadge = document.getElementById('np-badge');
const actionPop = document.getElementById('action-pop');
const acActs = document.getElementById('ac-acts');
const acActSec = document.getElementById('ac-act-sec');
const peekEl = document.getElementById('peek');
const peekState = document.getElementById('peek-state');
const peekTitle = document.getElementById('peek-title');
const peekSubtitle = document.getElementById('peek-subtitle');
const peekList = document.getElementById('peek-list');
const peekSummary = document.getElementById('peek-summary');
const peekHint = document.getElementById('peek-hint');
const peekFocus = document.getElementById('peek-focus');
const peekPanel = document.getElementById('peek-panel');
const peekClose = document.getElementById('peek-close');

// Keep the non-native details card closed even if a cached/older HTML shell
// is ever loaded before the renderer finishes its first stats pass.
quotaPopover.classList.add('hidden');
quotaEl.setAttribute('aria-expanded', 'false');

let askActive = false;
let askQueue = []; // 当前所有待处理的选择/输入（每项含 project）
let askIdx = 0;
let lastAskSig = ''; // 当前面板内容签名，避免每 2s 重渲冲掉用户输入
const answered = new Set(); // 已答的 key，避免快照延迟导致重弹
let askHover = false; // 鼠标在选项面板上
let elic = null;      // elicitation 渲染态：{ key, questions, qIdx, answers, selected }
// 面板开着、且(鼠标在面板上 / 输入框聚焦/有草稿 / 已选了选项) = 交互中：
// 此时别重渲面板、别改打工喵状态，免得打断你思考/选择。面板一关就自动解除。
const isInteracting = () => askActive && (askHover || document.activeElement === askText || !!(askText && askText.value) || (elic && elic.selected != null));

// i18n: shared/i18n.js is loaded as a <script> before this file.
const t = (key, vars) => window.WorkMeowI18n.t(key, vars);
const backgroundStatus = (session) => window.WorkMeowI18n.backgroundStatus(session);
// A reason arrives as a stable key ('reply'|'plan'|'perm'); older payloads may
// still carry free text, so fall back to whatever came in.
const waitPhrase = (reason) => (reason ? t('wait.' + reason) : t('wait.default'));
const reasonWord = (reason) => (reason ? t('reason.' + reason) : t('reason.default'));
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 带上 sessionId：否则同一项目下两个并行会话若问了同样的问题，会共用一个 key，
// 答掉一个就把另一个也标记成 answered 吞掉。choice 各构造处都带 sessionId。
const choiceKey = (c) => {
  if (!c) return '';
  if (c.permId) return `perm:${c.permId}`;
  if (c.actionId) return `action:${c.actionId}`;
  // Compatibility fallback for old snapshots; authorization choices always
  // take one of the stable branches above.
  return (c.sessionId || '') + '|' + (c.project || '') + '|' + (c.question || '');
};

// 先扩到目标宽度再量高度：如果在基础 320px 窄窗里先测，长文本会被过度换行，
// 错误地把弹层撑到整屏高。（帧**高**不再跟内容走，见 PET_FRAME_H。）
const POPUP_W = 520;
const POPUP_BOTTOM = 200;
const ASK_VIEWPORT_MAX_H = 520;
// 桌宠帧高**恒定**（2026-09-17，E2）。
//
// 用户原话：「任务气泡点击出现，点其他位置消失的时候……现在是往上消失，然后再出现，
// 给人的感觉还是卡卡的」。探针实测：开/关气泡时窗口**高度**与 **y 原点**分帧落地，
// 屏幕上看到的相位错帧**幅度恰好等于两次帧高之差**；把这个差人为压到 0（开关气泡
// 不改高度）→ 16/16 例零闪现，差保持原样 → 16 例中 7 例可见。
// 微观机制这里明确留空 —— 早先注释里「合成器还持有旧表面并裁掉顶部」那个说法是
// 推测且已证伪，不要再传播。能确定的只有上面这条相关性。
//
// 于是帧高恒取「弹窗最高时需要的那个值」：POPUP_BOTTOM + ASK_VIEWPORT_MAX_H + 24。
// main.js 的 PET_FRAME_H 是同一个推导写死成 744，改一处必须改两处，
// test/popup-style.js 钉住了它们相等。小屏（工作区不足 744 高）由主进程
// applyPetSize 的 Math.min 削一次，该屏内仍恒定。
const PET_FRAME_H = POPUP_BOTTOM + ASK_VIEWPORT_MAX_H + 24;
// 老的「静息帧高」。帧高恒定（PET_FRAME_H）之后它不再是任何窗口的真实高度，还剩
// 两个用途：
//   ① 读 window.innerHeight 拿不到有效值时的兜底值（测试 DOM 桩里就是 340）；
//   ② restingTopRoom 的基准 —— 「静息态本来给气泡留了多高」。这一项才是它现在的
//      主要语义：340 是历史上「刚好裹住内容」的那个帧高，减掉猫高和猫下方那一截
//      （胶囊）剩下的就是气泡的可用高度，也就是上/下让位的阈值。
// 别再拿它当「当前帧是不是静息帧」的判据 —— 恒高之后没有这种判据。
const BASE_PET_FRAME_H = 340;
let fitPopupSeq = 0;
// 只有竖直方向有贴边态。横向那半套已于 2026-09-17 退役：它存在的唯一目的是绕开
// 「主进程钳窗口」这个前提（窗口 520 宽而猫 120 宽，钳窗口会把猫从屏幕左右各 200px
// 的「环带」里推走），而钳制现在换成了钳猫本体（main.js clampCatOrigin），窗口原点
// 允许悬出屏幕，工作区内每个像素都直接可达，不需要任何对齐切换。
let edgeLayout = { vertical: 'above' };
// 待应用的贴边布局：窗口尺寸真的变了时，flex 变更延后到 resize 事件里、和窗口
// 重排同帧落地（否则猫会先往一边挪一帧再弹回来，看着卡）。无尺寸变化时不走这里。
let pendingEdgeLayout = null;

function browserWorkArea() {
  const s = window.screen || {};
  const width = Number.isFinite(s.availWidth) ? s.availWidth : (window.innerWidth || 320);
  const height = Number.isFinite(s.availHeight) ? s.availHeight : (window.innerHeight || 340);
  return {
    x: Number.isFinite(s.availLeft) ? s.availLeft : 0,
    y: Number.isFinite(s.availTop) ? s.availTop : 0,
    width,
    height,
  };
}

function petGeometrySnapshot() {
  const el = curSkinEl();
  if (!el || !Number.isFinite(window.screenX) || !Number.isFinite(window.screenY)) return null;
  const rect = el.getBoundingClientRect();
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || 340);
  return {
    workArea: browserWorkArea(),
    windowRect: { x: window.screenX, y: window.screenY, width: viewportW, height: viewportH },
    petRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
}

function setStageEdgeLayout(next) {
  const layout = next || edgeLayout;
  edgeLayout = {
    vertical: layout.vertical === 'below' ? 'below' : 'above',
  };
  stage.classList.toggle('edge-below', edgeLayout.vertical === 'below');
  if (propEl && propEl.classList.contains('on')) positionProp();
}

// Changing the flex anchor moves the pet inside the transparent BrowserWindow.
// This payload lets the main process move/resize that window in the opposite
// direction, so the visible pet stays on exactly the same screen pixel.
//
// 这里**不做任何吸附**。2026-09-17（E2）之前有两条竖直吸附分支：窗口被钳在工作区
// 上/下缘、而猫还困在窗口的透明留白里时，按「用户其实想把猫贴到那条边」把 screenY
// 拉到边上。那两条分支的前提是「主进程钳的是窗口」—— 竖直改钳猫（main.js
// clampCatOriginY）之后猫本体到边和窗口到边是同一件事，「窗口被拦住而猫没到边」
// 这个状态不再存在，无从推断也无需推断。横向那条对应分支在同一天以同样的论证退役。
// 顺带一提它们已经先被恒高废掉了：门是 `wr.height <= RESTING_FRAME_MAX_H(360)`，
// 帧高恒 744 之后恒 false。留着就是死代码，而上一次留下的死门（永真的
// inferHorizontalFrameClamp）正是 E3/E4 那条环带没被拦住的直接原因。
function anchoredLayoutPayload(next) {
  const before = petGeometrySnapshot();
  if (!before) { setStageEdgeLayout(next); return null; }
  const oldPet = before.petRect;
  const wr = before.windowRect;
  const screenX = wr.x + oldPet.x;
  const screenY = wr.y + oldPet.y;

  // 测「目标布局」下猫的窗内偏移。临时切 class、同步测 rect、立刻恢复：整段在一个
  // 同步块里跑完，浏览器不会在中间 paint，所以不产生「先挪一帧再弹回」的抖动；flex
  // 的真正落地仍由调用方延后到 resize 事件（pendingEdgeLayout），与窗口重排同帧。
  // offset 必须实测、不能归零 —— 尤其垂直方向：贴窗口底的是胶囊而不是猫（猫在它
  // 上方、隔一个胶囊高），yOffset 就是那段胶囊高。
  // 弹窗贴边时给猫那一列加帧内偏移。**位置很讲究**：必须在这里、在 measureEdgeRect
  // 之前 —— 上面的 screenX 是由**旧** rect 定住的（猫此刻真实的屏幕位置），而下面的
  // measureEdgeRect 取的是**新** rect（含本次偏移）。两者之差正是要让主进程反向吸收
  // 的那一段；如果挪到函数外面，Δ 会被算进 screenX，主进程就把猫真的推走了。
  const plan = popupShiftPlan(screenX, oldPet.width);
  applyCatShift(plan ? plan.catShift : 0);

  const rect = measureEdgeRect(next);
  const viewportW = Math.max(1, window.innerWidth || 320);
  const viewportH = Math.max(1, window.innerHeight || BASE_PET_FRAME_H);
  // 横向恒居中，但猫的窗内偏移**不再恒等于** (帧宽-猫宽)/2 —— 弹窗贴边时上面的
  // applyCatShift 会给它加 catShift（2026-09-18 H3）。所以 xOffset 必须像现在这样
  // 实测，不能按公式归零；主进程 main.js:333 的 `inset = anchor.screenX - anchored.x`
  // 正是把这个偏移读回去、反向挪帧的那一步。
  // 仍然发 'center' 而不是省掉这个字段，是因为主进程 anchoredPetOrigin 靠它反解
  // localX（三条分支还留着，兼容旧锚点）。
  const xAlign = 'center';
  const yAlign = next.vertical === 'below' ? 'top' : 'bottom';
  const xOffset = rect.left + rect.width / 2 - viewportW / 2;
  const yOffset = yAlign === 'top' ? rect.top : viewportH - rect.bottom;
  return {
    screenX, screenY,
    width: rect.width, height: rect.height,
    xAlign, yAlign, xOffset, yOffset,
  };
}

// 临时把 stage 的贴边 class 切到 next、测出猫在新布局下的窗内偏移、再立刻恢复。
// 不经过 setStageEdgeLayout：那会改 edgeLayout 全局量、还会触发 positionProp 等
// 副作用，这里只需要纯布局测量。同步块内完成，不会 paint 出中间态。
function measureEdgeRect(next) {
  const vb = next.vertical === 'below';
  const prevVb = edgeLayout.vertical === 'below';
  stage.classList.toggle('edge-below', vb);
  const rect = curSkinEl().getBoundingClientRect();
  stage.classList.toggle('edge-below', prevVb);
  return rect;
}

// 胶囊的按需内缩。这里是唯一的计算点，因为这里（也只有这里）能拿到桌宠本体
// **移动之后**的屏幕位置：screenX 就是主进程即将把本体放到的那一像素，整套
// anchored payload 机制保证的就是这件事。窗口移动不会触发渲染端的 resize
// 事件，所以指望事后重算是等不到的。
//
// 反复调用是幂等的：输入只有本体的屏幕位置和胶囊的**宽度**，translateX 不改宽度。
// 但要小心 —— transform 虽然不参与布局，却**会**把祖先的 scrollWidth 撑大，所以
// measuredRestingWidth 必须绕开 #compact-row（见那里的注释），否则位移会喂回帧宽。
//
// 胶囊居中在猫正下方，只在会探出工作区时往内挪刚好够用的距离（capsuleShift 的
// 「按需最小位移」口径）。横向贴边退役后 flex 中心恒在猫正下方，所以传猫的中心点
// 就够了，不再需要按对齐反推 flex 中心（旧的 capsuleShiftFromEdge 已删）。
function applyCapsuleShift(petScreenX, petWidth) {
  if (!stage || !stage.style) return;
  const rect = chip && !chip.hidden && typeof chip.getBoundingClientRect === 'function'
    ? chip.getBoundingClientRect()
    : null;
  const width = rect ? Number(rect.width) : 0;
  // 隐藏猫身时胶囊本身就是锚点（curSkinEl() === chip），没有「居中在猫正下方」
  // 这回事，整行交给 align-items 摆放即可。
  const shift = (catVisible && width > 0 && window.PetGeometry)
    ? window.PetGeometry.capsuleShift({
      petCenterX: Number(petScreenX) + Number(petWidth) / 2,
      capsuleWidth: width,
      workArea: browserWorkArea(),
      petWidth: Number(petWidth),
    })
    : 0;
  stage.style.setProperty('--chip-shift', shift + 'px');
  applyPopupShift(petScreenX, petWidth);
}

// 弹窗（.peek / .ask / .bubble / .think）的按需内缩，和胶囊同一个口径、同一个
// 计算时机，但**必须单独算**：它们比胶囊宽，需要的位移量不一样。
//
// 为什么需要这个：横向贴边退役后，弹窗一律由 #stage 的 align-items:center 居中在
// **520 宽的窗口**里，而钳猫之后窗口原点合法地悬出屏幕（猫贴死左缘时原点 = wa.x-200）。
// 于是 .peek（320 宽）落在 wa.x-100、.ask（340 宽）落在 wa.x-110 —— 探出屏幕外，
// 被直接裁掉。旧代码里这不会发生：#stage.edge-left 把整列拉到窗口左缘，而那个缘
// 本身被钳在 wa.x —— 也就是说横向贴边那半套**顺手**保护了弹窗，删它的时候这层保护
// 一起没了。这里把保护补回来，而且是显式的。
//
// 用 position:relative + left，不用 transform：.peek/.ask/.think 的入场动画
// keyframes 结尾就是 `transform: none`，位移会被动画擦掉。也不用 margin —— margin
// 会挤压兄弟节点、把整列的布局宽度推出去（2026-09-16 的教训）。relative 的 left
// 和 transform 一样只在绘制期偏移、不参与布局，所以不会喂回帧宽。
//
// 气泡尾巴不会跟丢：--tip-x 是从 getBoundingClientRect 反算的，relative 偏移已经
// 含在那个矩形里，尾巴自动跟着指回猫。
//
// 2026-09-18（H3）：这里只**算**，不施加。总位移拆成两半：popShift 由 --pop-shift
// 在帧内挪弹窗，catShift 由 applyCatShift 在帧内挪猫、再由主进程的帧移抵掉。两半的
// 落地时机不同（catShift 必须在 anchoredLayoutPayload 量 rect 之前），所以计算和
// 施加分开。返回 null 表示「没有可见弹窗 / 几何不可用」，两半都归零。
function popupShiftPlan(petScreenX, petWidth) {
  if (!stage || !stage.style) return null;
  const wa = browserWorkArea();
  const petCenterX = Number(petScreenX) + Number(petWidth) / 2;
  if (window.PetGeometry && Number.isFinite(petCenterX)) {
    // 2026-09-17：capsuleShift 现在按 (弹窗宽 - 猫宽)/2 封顶，所以位移最多把弹窗
    // 挪到与猫齐缘。传 petWidth 是必须的 —— 不传就按默认 120 算，猫宽本来也恒是
    // 120，但显式传值才能保证隐藏猫身等特殊态下上限跟着实际锚点走。
    //
    // 2026-09-18（H2）：上一版这里写「已验（逐 1px 全扫）…任何位置都不会被裁」——
    // **那是错的**，而且错在关键处：那次全扫只看弹窗的**屏幕**坐标，从没看过它在
    // 自己那个 POPUP_W 宽的窗口帧里的坐标。真正在裁内容的是 renderer/pet.css:3-7 的
    // html,body{overflow:hidden}，它裁的是帧。#stage 的 align-items:center 先把弹窗
    // 居中在 520 帧里（每侧余量 (520-弹窗宽)/2），--pop-shift 再往一侧加位移，位移
    // 一旦超过那点余量就被帧裁 —— 裁的是位移**去向**那一侧，也就是**远离屏幕边缘**
    // 那一侧，正是用户说的「不是靠近屏幕边缘不完整，而是另一边」。
    //   peek 320：余量 100 < 旧上限 104 → 最多裁 4px
    //   ask/bubble 340：余量 90 < 旧上限 114 → 最多裁 24px
    // 这两个数**真机实测过**（probes/probeEdge.py 靶 A、probes/probeAsk.py A/B），不是纯算术：
    //   peek 修前 catX=0    → popShift=104px  L=204 R=524  clipRight=4
    //   ask  修前 catX=0    → popShift=114px  L=204 R=544  clipRight=24  修后 90px  L=180 R=520  clip 0
    //   ask  修前 catX=1560 → popShift=-114px L=-24 R=316  clipLeft =24  修后 -90px L=0   R=340  clip 0
    // 猫在**左**缘裁**右**边、猫在**右**缘裁**左**边 —— 正是用户说的那一侧。
    //
    // 2026-09-18（H3）：H2 当时把位移按 frameWidth 一压了事，并断言剩下的代价
    // 「属于预期」。**那两条断言都被用户的眼睛和随后的实测推翻了**，记在这里免得再犯：
    //   (1) 「猫贴死屏幕缘时那 4px 屏幕留白必然丢掉」——	不必然。帧可以动。
    //   (2) 「340 宽的弹窗探出屏幕 20px，实测是出屏、不是帧裁，帧内内容完整，
    //        所以不动 POPUP_W」—— 前半句（是出屏不是帧裁）对，**结论错**：用户看到的
    //        是「贴边那一侧的圆弧没了」，圆弧就长在那 20px 里，出屏和被裁在眼睛看来
    //        一模一样。而且它根本不用改 POPUP_W 就能归零。
    //   (3) H2 还顺手压掉了**阴影**：位移一顶到 (520-弹窗宽)/2，盒子就贴死帧墙，
    //        而 box-shadow 画在盒子**外面** → 被 overflow:hidden 整块吃掉，这就是
    //        用户报的「喵靠在右边，左边缘的阴影也没了」。H2 钳错了矩形 —— 钳的是
    //        盒子，该钳的是「盒子 + 阴影」。
    // 三条同一个根，所以一起修：位移拆成 popShift + catShift（见上方大注释），
    // 帧内那一半按 tight（含阴影）封顶，溢出的一半交给帧移。实测（probeRealPath2.py，
    // 全部走真实 fitPopup → setRequestedPetSize → IPC → applyPetSize 链路）：
    //   .peek 贴右缘 ideal=-104 tight=74 → popShift=-74 catShift=+30 帧 1360→1330
    //         盒子屏幕 [1360,1680]→[1356,1676]  近侧阴影 0→21.5px  远侧 21.5 不变
    //   .ask  贴右缘 ideal=-114 tight=64 → popShift=-64 catShift=+50 帧 1360→1310
    //         盒子屏幕 [1360,1700]→[1336,1676]  近侧阴影 0→21px    远侧 21 不变
    //         **出屏 20→0**（圆弧回来了），且 H2 丢掉的那 4px 屏幕留白也一并回来
    //   .ask  贴左缘 ideal=+114 → popShift=+64 catShift=-50 帧 -200→-150 出屏 20→0
    //   四组里猫的屏幕 x 恒定（1560/1560/0）、帧宽恒 520、#compact-row.scrollWidth 不变
    // POPUP_W 仍然**不动** —— 它压根不是瓶颈。
    const widest = widestVisiblePopup();
    if (widest > 0) {
      // ideal：**不传 frameWidth**。这是「刚好不出屏 + 4px 留白」的完整需求量，
      // 不再在这里被帧宽压掉 —— 压掉的那部分现在由 catShift 交给帧移去吸收。
      const ideal = window.PetGeometry.capsuleShift({
        petCenterX,
        capsuleWidth: widest,
        workArea: wa,
        petWidth: Number(petWidth),
      });
      // tight：帧内能安全容纳的位移上限。居中余量 (520-弹窗宽)/2 再**扣掉阴影扩散**，
      // 这是 H2 漏掉的那一项 —— 盒子贴到帧墙时阴影就被 overflow:hidden 吃了。
      const tight = Math.max(0, (POPUP_W - widest) / 2 - POPUP_SHADOW_SPREAD);
      const popShift = Math.max(-tight, Math.min(tight, ideal));
      // 不变式：popShift - catShift ≡ ideal。总位移一分不少，只是换了承担者 ——
      // 注意是**减**：弹窗在帧内右移 popShift，猫在帧内左移 |catShift|（catShift 是
      // 负数），两者叠加出的「弹窗相对猫的位移」才是 capsuleShift 要的那个 ideal。
      return { ideal, tight, widest, popShift, catShift: Math.round(popShift - ideal) };
    }
  }
  return null;
}

// 当前可见弹窗里**最宽**的那个的宽度（没有可见弹窗时 0）。取最宽的那个：它需要的
// 位移最大，按它算能保证所有弹窗都在屏幕内（窄的那些本来就在宽的覆盖范围里，多挪
// 一点也不会探出另一侧 —— capsuleShift 的口径是「刚好不出屏」，不会过冲）。
function widestVisiblePopup() {
  let widest = 0;
  for (const el of [peekEl, askEl, bubble, thinkEl]) {
    if (!el || el.hidden || el.classList.contains('hidden')) continue;
    if (typeof el.getBoundingClientRect !== 'function') continue;
    const w = Number(el.getBoundingClientRect().width);
    if (Number.isFinite(w) && w > widest) widest = w;
  }
  return widest;
}

// 把算好的帧内那一半位移写进 CSS 变量。另一半（catShift）**不在这里施加** ——
// 它必须在 anchoredLayoutPayload 里、量 rect 之前落地，见那里的注释。
function applyPopupShift(petScreenX, petWidth) {
  if (!stage || !stage.style) return;
  const plan = popupShiftPlan(petScreenX, petWidth);
  stage.style.setProperty('--pop-shift', (plan ? plan.popShift : 0) + 'px');
}

// 弹窗需要的位移超出帧内安全余量时，超出的那部分给**猫那一列**加帧内偏移：猫在帧内
// 往中心挪 catShift，主进程随后按锚点把整个帧反向挪 catShift（main.js:333 的
// `inset = anchor.screenX - anchored.x` 会把这个偏移读回去），净效果是猫在屏幕上
// 一动不动，而弹窗多拿到 |catShift| 的帧内余量 —— 阴影和圆弧就都装得下了。
//
// 为什么非得动帧：.ask 340 宽、猫贴死右缘时，「不出屏且留 4px」要求盒子落在帧内
// [-20, 320]，左端在帧的左墙**外面**。单靠 --pop-shift 在数学上做不到，帧必须动。
//
// 两个进程、无法原子提交：渲染进程改 left、主进程改 setBounds，中间理论上可能有一帧
// 猫跳 catShift。**实测没有**（probes/probeRealPath2.py，rAF 逐帧采 window.screenX +
// rect.left 的和，开窗 200 帧、关窗 278 帧，|Δ|>2 计一次跳变，结果 0）。
//
// 用 position:relative + left，理由和 .peek/.ask 那边完全同源（见 pet.css:37-51）：
// 不能用 margin（挤兄弟、喂回 measuredRestingWidth），也不用 transform（会把祖先的
// scrollWidth 撑大，实测 shift=204 时 #compact-row.scrollWidth 275→479，直接喂回帧宽）。
// relative 只在绘制期偏移 —— 实测四组靶里 #compact-row.scrollWidth 一个字节都没变。
//
// 绘制层：#compact-row 在 pet.html 里排在所有弹窗**之后**（:120 vs peek:45/ask:18），
// position:relative 会把它的绘制层提到 .bubble/.peek/.ask/.think 之上（z-index 都是
// auto）。几何上它们从不重叠，所以无害；#radial(20)/#action-pop(30)/#notepad(6) 都有
// 显式 z-index 压在它上面，也不受影响。
function applyCatShift(px) {
  if (!compactRow || !compactRow.style) return;
  const v = Number(px) || 0;
  appliedCatShift = v;
  // 归零时两个属性都清干净、让它退回 static：留着 position:relative 就白白保持
  // 那层绘制层提升。归零本身是靠 fitRestingFrame 的去重第三项才跑得到的，见那里。
  compactRow.style.position = v ? 'relative' : '';
  compactRow.style.left = v ? (v + 'px') : '';
}

// .bubble/.peek/.ask/.think 的 box-shadow 向外扩散量，单位 px。
// 实测（probes/probeShadow2.py，capturePage → getBitmap 逐列扫 alpha；
// getBoundingClientRect **不含** box-shadow，只能这么量）：.peek 21.5、.ask 21。
// 取 26 留 ~5px 余量。这个常数只决定「总位移怎么在 popShift / catShift 之间拆」，
// 不影响盒子最终落点 —— 实测 SHADOW=24 得 popShift=-66、SHADOW=26 得 -64，
// 盒子两次都落在屏幕 [1336,1676]，逐字节相同。所以改阴影样式**不必**回来改这个数。
const POPUP_SHADOW_SPREAD = 26;
// 当前施加在 #compact-row 上的帧内偏移。fitRestingFrame 的去重要读它 —— 关窗时
// 横向几何在两个状态下完全相同（静息帧宽也是 520），去重会一命中就早退，把归零
// 一起吞掉。
let appliedCatShift = 0;

// 「猫本体上方至少要留多少屏幕空间给气泡」。低于这个数就把气泡翻到猫下方
// （#stage.edge-below）。拖动途中的同一个判据在 PetGeometry.chooseDragVerticalLayout。
//
// 2026-09-17（E2）：旧实现拿的是**猫在帧内的 y 偏移**，再减一个
// `wr.height - BASE_PET_FRAME_H` 的「弹窗多出来的高度」修正项。那个代理量成立的前提
// 是「静息帧高恰好裹住内容」—— 帧高 340、整列贴帧底排，于是「帧顶到猫顶」正好等于
// 内容给气泡留的那一截。帧高恒定（744）之后前提没了：猫上方恒有 ~600px 透明留白，
// 那个偏移恒等于 597，而修正项恒等于 404，减完只是把一个常数换成另一个常数，语义全丢。
// 现在直接按**静息帧高**反算同一个数：340 - 猫高 - 猫下方那一截（胶囊）。量出来仍是
// 旧的 ~193，但每一项都是实测的，胶囊变高会跟着变。
//
// 必须在 'above' 布局下量：'below' 时整列贴帧顶，猫下方是几百像素透明留白，
// 量出来会是个负数。这次临时切 class 的手法与 measureEdgeRect 同源 —— 整段同步跑完，
// 中间不会 paint。
function restingTopRoom() {
  const measure = () => {
    const rect = curSkinEl().getBoundingClientRect();
    const viewportH = Math.max(1, window.innerHeight || BASE_PET_FRAME_H);
    const belowCat = Math.max(0, viewportH - (rect.top + rect.height));
    return BASE_PET_FRAME_H - rect.height - belowCat + 2;
  };
  if (edgeLayout.vertical !== 'below') return Math.max(24, measure());
  const previous = { ...edgeLayout };
  setStageEdgeLayout({ ...previous, vertical: 'above' });
  const room = measure();
  setStageEdgeLayout(previous);
  return Math.max(24, room);
}

function restingEdgeLayout() {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  return window.PetGeometry.chooseRestingLayout({
    ...snapshot,
    threshold: restingTopRoom(),
  });
}

// 弹窗态的上/下让位。判据是**弹窗内容**高度对猫上方余量，与帧高无关。
//
// 2026-09-17（E2）：签名从 (height, popupHeight) 收成只收 popupHeight，帧高那个
// 参数与它的兜底（`(height || 340) - POPUP_BOTTOM`）一起退役 —— 恒高之后帧高是常量，
// 反推出来的「内容高度」恒等于 544，比大多数卡片都高，会把小卡片也判成装不下、
// 一律翻到猫下方。
//
// popupHeight 缺失（fitPopup 的第一拍：那一拍只负责把帧扩到 POPUP_W，真实内容高度
// 还没量到）时**沿用当前布局**，不猜。猜错的代价是第一拍翻到 below、第二拍再翻回来，
// 屏幕上就是一次多余的跳动 —— 正是这次要消掉的那类东西。
function popupEdgeLayout(popupHeight) {
  const snapshot = petGeometrySnapshot();
  if (!snapshot || !window.PetGeometry) return edgeLayout;
  const need = Number(popupHeight);
  if (!Number.isFinite(need) || need <= 0) return edgeLayout;
  return window.PetGeometry.choosePopupLayout({
    ...snapshot,
    popupHeight: Math.max(80, need),
  });
}

function setRequestedPetSize(w, h, options = {}) {
  const width = Number(w) || 0;
  const height = Number(h) || 0;
  const nextLayout = options.popup
    ? popupEdgeLayout(options.popupHeight)
    : restingEdgeLayout();
  const anchor = anchoredLayoutPayload(nextLayout);
  // 尺寸真的要变 → resize 事件会来，flex 变更延后到那里跟窗口重排同帧落地，
  // 消除「先挪一帧再弹回」的抖动。尺寸没变（拖动贴边/复位锚点，主进程只动位置
  // 不动尺寸，不会发 resize）→ 就地应用，否则贴边状态会一直卡住。
  const willResize = Math.abs(width - (window.innerWidth || 0)) > 2
    || Math.abs(height - (window.innerHeight || 0)) > 2;
  if (willResize && anchor) {
    pendingEdgeLayout = { next: nextLayout, screenX: anchor.screenX, width: anchor.width };
  } else if (!willResize && anchor) {
    setStageEdgeLayout(nextLayout);
    applyCapsuleShift(anchor.screenX, anchor.width);
  }
  try { window.pet.setPetSize(width, height, anchor, options.popup ? 'popup' : 'resting'); } catch {}
}

// 尺寸变化落地后，把延后了的 flex 变更和胶囊内缩一次性补上。放在 resize 事件里
// 同步调用（而非 rAF）：resize 是在主进程 setBounds 之后、下一次 paint 之前触发，
// 此刻改 flex 不会产生「先挪一帧再弹回」的中间帧。
function applyPendingEdgeLayout() {
  if (!pendingEdgeLayout) return;
  const { next, screenX, width } = pendingEdgeLayout;
  pendingEdgeLayout = null;
  setStageEdgeLayout(next);
  applyCapsuleShift(screenX, width);
}

// The resting pet window used to stay at BASE_W even when the capsule grew
// past it. Keep the capsule uncompressed and let the transparent frame follow
// its real intrinsic width so the cat and the session dots remain centred on
// the same visual stack.
const CAPSULE_FRAME_MIN_W = 320;
const CAPSULE_FRAME_MAX_W = 900;
const CAPSULE_FRAME_GUTTER = 24;
let restingFitFrame = null;

// 只量**内容**元素，绝不量 #compact-row。
// .chip 带 transform: translateX(--chip-shift)：transform 不参与布局，但它**会**把
// 祖先的 scrollWidth 撑大（实测 shift=204px 时 compact-row.scrollWidth 275 → 479，
// 正好 +204，而 chip 自己仍是 275）。一旦把 compactRow 量进来，位移量就原封不动
// 喂回帧宽 → 帧宽过 360 → 横向贴边判定被关掉 → 猫被主进程钳离边缘一百多像素，
// 也就是「出现工具图标/思考中就自动往中间移动」。
// compactRow 本来也是纯冗余：猫可见（column）和猫隐藏（row）两种模式下它都恰好
// 等于 chip 的宽度，去掉零损失。
function measuredRestingWidth() {
  const widths = [];
  for (const el of [chip, sessionsEl]) {
    if (!el || el.hidden) continue;
    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    const rectWidth = rect && Number(rect.width);
    const scrollWidth = Number(el.scrollWidth);
    if (Number.isFinite(rectWidth) && rectWidth > 0) widths.push(rectWidth);
    if (Number.isFinite(scrollWidth) && scrollWidth > 0) widths.push(scrollWidth);
  }
  return widths.length ? Math.max(...widths) : CAPSULE_FRAME_MIN_W;
}

// 静息帧该有多宽。fitRestingFrame 用它决定真实帧宽，restingEdgeLayout 用它判断
// 「当前帧是不是已经比静息帧宽了」（即身处弹窗残留帧）。两处必须是同一个定义，
// 否则关闭弹窗时的贴边判定会和实际帧宽错位。
//
// 下限取「弹窗帧宽」而不是基础 320：开关气泡时**我们自己**就只下发高度变化，横向
// 几何（宽度+原点+对齐）在 JS 侧完全不变。这是对 2026-09-16 那两个横向 bug 的根治：
//   · 抖动（「关气泡猫往左挪一下再弹回」）：窗口横向「宽度+原点」的变更在 macOS
//     WindowServer 里是两笔事务（先变宽、后挪原点，各触发一次 resize），中间帧猫
//     必然可见地跳一下。横向不动，抖动在物理上不可能发生。
//   · 误吸附/形态切换（「点击后猫被搬到边缘、胶囊跟着切贴边形态」）：静息 320 /
//     弹窗 520 两种帧宽下贴边判定的输入不同，开关一轮气泡可能换对齐换帧宽。横向
//     几何恒定后这条链路整个消失，气泡和胶囊的形态天然协调。
// 弹窗帧本来就是 520 宽的透明窗，静息态也用 520 并不会多挡任何东西（命中测试
// 按元素而不是按窗口矩形），代价为零。
//
// 注意「JS 侧不变」不等于「横向真的不变」：2026-09-17 实测发现 macOS 会在窗口
// **失焦**时（closePeek → blurPet → w.blur()）用 constrainFrameRect:toScreen: 把
// 悬出屏幕的窗口原点自己钳回工作区，全程没有 will-move、没有任何 JS setBounds。
// 那正是「关气泡后猫朝屏幕中心移动 max(0, 200-离缘距离) px」的成因。修法在主进程
// 侧：桌宠窗口开 enableLargerThanScreen（见 main.js 该选项处的实测数据）。
//
// 2026-09-17（F2）：帧宽必须是**偶数**。用户实测：「喵处于大概上次那种环带区域，
// 点击出现气泡，点其他位置，气泡关闭后，喵有概率会移动位置，而且这个只在右边缘的
// 时候才出现。」
// 成因是 .5 像素被向上取整放大成每轮 +1px 的单向漂移：#stage 恒 align-items:center，
// 猫的窗内偏移 = (帧宽 - 120)/2，帧宽为奇数时它带 .5（真机 Electron 实测 F=521 时
// #cat 的 getBoundingClientRect().left = 200.5）。这个带小数的 screenX 经
// anchoredLayoutPayload 交给主进程，anchoredPetOrigin 的 Math.round(x.5) 在 JS 里
// **恒向上**，applyPetSize 再由取整后的原点反推 inset、clampCatOrigin 又取一次整 ——
// 一次 setPetSize 净 +1px。所以「有概率」= 帧宽碰巧是奇数时才有；「只在右边缘」=
// 到处都在漂，只有右缘会撞上 clampCatOrigin 的上界饱和成一次可见的跳动。
// 取偶之后 inset 恒为整数，两次 Math.round 都成了恒等变换。
// （试过「少取一次整」——用未取整的 localX 直接当 inset：仿真显示毫无改善，
// 129786 个样本里 64893 个照旧漂移、最大 8.5px。小数 inset 本身才是病根。）
// CAPSULE_FRAME_MAX_W(900) 与 POPUP_W(520) 都已是偶数，所以夹取的两端天然安全。
function restingFrameWidth() {
  const w = Math.min(
    CAPSULE_FRAME_MAX_W,
    Math.max(POPUP_W, Math.ceil(measuredRestingWidth() + CAPSULE_FRAME_GUTTER)),
  );
  return w + (w % 2);
}

function fitRestingFrame(force = false, allowOverlays = false) {
  if (restingFitFrame) cancelAnimationFrame(restingFitFrame);
  restingFitFrame = requestAnimationFrame(() => {
    restingFitFrame = null;
    if (!allowOverlays && (askActive || actionPopOpen || peekOpen || quotaPopoverOpen || radialOpen)) return;
    const width = restingFrameWidth();
    const current = Number(window.innerWidth) || CAPSULE_FRAME_MIN_W;
    // 宽**和**高都得比。只比宽的话，胶囊本身已经宽到接近 520（多会话 + 额度全开）
    // 时从气泡态收回来会在这里提前返回，窗口高度就卡在气泡的 600 下不来 ——
    // 这正是 resetPetSize 当初要 force=true 绕过它的原因。把判断补全，force 就
    // 真的冗余了：它剩下的唯一作用是在尺寸没变时强行多发一次 IPC。
    //
    // 高度侧的比较对象必须**跟着主进程削一次**：applyPetSize 是 min(PET_FRAME_H,
    // wa.height)，小屏上真实帧高恒小于 744。直接拿 744 比就永远不相等，这条去重
    // 在小屏上整个失效、每次都白发一次 IPC → 一次 setBounds → 一次窗口重排。
    const currentH = Number(window.innerHeight) || BASE_PET_FRAME_H;
    const targetH = Math.min(PET_FRAME_H, browserWorkArea().height || PET_FRAME_H);
    // 第三项 appliedCatShift（2026-09-18 H3）：猫身上还挂着帧内偏移时，宽高即使都
    // 没变也**不许**早退。关窗这条路上前两项必然同时命中 —— 静息帧宽 max(520, …)
    // 恰好也是 520、帧高也没变 —— 于是 setRequestedPetSize 不发、anchoredLayoutPayload
    // 不跑、归零的机会根本不存在。讽刺的是：正是「横向几何在两个状态下完全相同」
    // 这条让修法零成本的性质，把清理也一并吞掉了（探针 #14 实测残留 30/50/-50px）。
    //   残留不是化妆问题：main.js:398（restoreWindowOrigin）和 :1570（keepCatOnScreen）
    //   两处都写死 inset = (帧宽-120)/2 = 200、不看锚点，一旦有屏幕拓扑事件或窗口
    //   恢复，猫就按错的 inset 横跳 catShift 那么多；而 persistPos 只在
    //   st.customSize.mode === 'popup' 时早退（main.js:534-538），关窗后模式已经不是
    //   popup，下一次 'moved' 就会把偏了的帧原点存盘。
    // 和 settleEdgeLayout 传 force=true 同源：那里也是「尺寸没变但状态需要重新发一次」。
    if (!force && Math.abs(current - width) <= 2 && Math.abs(currentH - targetH) <= 2
        && appliedCatShift === 0) return;
    setRequestedPetSize(width, PET_FRAME_H);
  });
}

function fitPopup(el) {
  if (!el) return;
  const seq = ++fitPopupSeq;
  requestAnimationFrame(() => {
    const measure = () => {
      if (seq !== fitPopupSeq) return;
      const popupW = POPUP_W;
      // 关键：先临时去掉 max-height 再量，否则 scrollHeight 会被「当前小窗口算出的
      // max-height」钳住（鸡生蛋问题）→ 窗口永远只长一点点、列表只剩 1 行+滚动条。
      const prev = el.style.maxHeight;
      el.style.maxHeight = 'none';
      const contentH = el.scrollHeight;
      el.style.maxHeight = prev;
      const viewportH = el === askEl ? Math.min(contentH, ASK_VIEWPORT_MAX_H) : contentH;
      // 帧高恒定（PET_FRAME_H），**不跟内容走** —— 这就是 E2 的修法本体：开/关气泡
      // 不改帧高，屏幕上那个「往上消失再出现」的相位错帧（幅度恒等于帧高差）就没了。
      // 但 popupHeight 必须继续是**内容**真实高度：上/下让位判的是「猫上方装不装得下
      // 这张卡片」，跟着恒高变成常量的话小卡片也会被判成装不下。
      setRequestedPetSize(popupW, PET_FRAME_H, { popup: true, popupHeight: viewportH });
    };

    const targetW = POPUP_W;
    if (Math.abs((window.innerWidth || 0) - targetW) > 2) {
      // 第一拍只扩宽，第二拍在正确的横向排版下测真实高度。高度参数照发 PET_FRAME_H
      // （恒高之后它对高度是 no-op，这一拍纯粹为了改宽）。
      setRequestedPetSize(targetW, PET_FRAME_H, { popup: true });
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  });
}
function resetPetSize() {
  fitPopupSeq++;
  // 不再 force：上面的去重已经同时比宽和高，尺寸真变了照样会下发。force 只会在
  // 「已经是静息尺寸」时白发一次 IPC → 主进程一次 setBounds → macOS 一次窗口重排。
  fitRestingFrame(false);
}

function settleEdgeLayout() {
  // No screen coordinates in the headless renderer tests; the real Electron
  // window always has them. This also avoids inventing a desktop in Node.
  if (!petGeometrySnapshot()) return;
  // Keep the intrinsic capsule width while re-evaluating the edge anchor.
  // Resetting to the old 320px base here would briefly reintroduce clipping
  // after a drag or immediately before the radial menu is laid out.
  // 这里的 force 是**必要**的，与 resetPetSize 不同：本函数要重发的是 anchor
  // （拖动/贴边后猫该锚在窗口的上边还是下边），而 anchor 只随 setRequestedPetSize
  // 一起走。尺寸通常没变，去重一命中 anchor 就发不出去，贴边判定原地卡住。
  fitRestingFrame(true, true);
}

// Switch the internal top/bottom anchor *during* a drag, so气泡在猫快要贴到屏幕
// 上缘时提前翻到猫下方。可见的猫始终停在同一个屏幕像素上、手势就地 rebase，
// 下一个 pointer 帧从那里接着走，不会出现「到边 → 顿一下 → 跳」。
//
// 2026-09-17（E2）：判据换成**猫本体**离工作区上缘的距离，与静息态
// （restingEdgeLayout / restingTopRoom）完全同一条规则。旧实现判的是**帧**原点撞不撞
// 工作区上缘，那在帧高裹住内容时是个够用的代理；帧高恒定（744）之后猫上方恒有
// ~600px 透明留白且**合法**悬出屏幕上方 → 那个条件一拖动就恒真，永远判成 below。
//
// 顺带塌掉了旧的 above/below 两条不对称分支：那时 below 布局下猫的帧内偏移不同，
// 得先临时切到 above 探一次才能拿到可比的数。现在判据是猫的**屏幕**坐标，而猫的屏幕
// 坐标在布局翻转前后由锚点保持不变，两个方向天然同一个式子，也天然没有滞回缺口
// （往上拖越过阈值翻 below，往下拖越回来翻 above，翻转本身不改判据的值）。
function movePetDuringDrag(gesture, e, targetX, targetY) {
  const dragMeta = () => ({
    x: gesture.grabX,
    y: gesture.grabY,
    id: gesture.id,
    seq: ++gesture.moveSeq,
  });
  const el = curSkinEl();
  if (!el) {
    window.pet.setWinPos(targetX, targetY, dragMeta());
    return;
  }
  const before = el.getBoundingClientRect();
  const petScreenX = targetX + before.left;
  const petScreenY = targetY + before.top;
  const wa = browserWorkArea();
  const topRoom = restingTopRoom();
  const nextVertical = window.PetGeometry
    ? window.PetGeometry.chooseDragVerticalLayout({ workArea: wa, petScreenY, topRoom })
    : (petScreenY - wa.y <= topRoom + 2 ? 'below' : 'above');

  if (nextVertical !== edgeLayout.vertical) {
    setStageEdgeLayout({ ...edgeLayout, vertical: nextVertical });
  }
  const after = el.getBoundingClientRect();
  const anchoredX = petScreenX - after.left;
  const anchoredY = petScreenY - after.top;
  // When the cat changes its internal edge anchor, the grabbed pixel moves
  // inside the window. Shift the local grab point by the same amount so the OS
  // cursor remains attached to that exact pixel without a visible jump.
  gesture.grabX += after.left - before.left;
  gesture.grabY += after.top - before.top;

  if (Math.abs(anchoredX - targetX) > 0.5 || Math.abs(anchoredY - targetY) > 0.5) {
    gesture.win = [anchoredX, anchoredY];
    gesture.sx = pointerScreenX(e);
    gesture.sy = pointerScreenY(e);
  }
  // 拖动途中也要跟着算：不算的话胶囊会一路挂着上次落点的位移，直到松手才回正。
  applyCapsuleShift(petScreenX, after.width);
  window.pet.setWinPos(anchoredX, anchoredY, dragMeta());
}

// 从快照重建队列（多任务都在、且标明项目）
function refreshAsk(stats) {
  // 记事本行动中心开着时，事项在那里处理，别再另弹选项面板抢窗口
  if (actionPopOpen) { hideAsk(); return; }
  const actionSource = Array.isArray(stats.actions)
    ? stats.actions
    : (stats.sessions || []).filter((x) => (x.state === 'waiting' || x.state === 'needsinput') && x.choice);
  const items = actionSource
    .map((x) => x.choice)
    .filter(Boolean)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
  const present = new Set(items.map(choiceKey));
  for (const k of [...answered]) if (!present.has(k)) answered.delete(k); // 已消失=已答完，清理
  const fresh = items.filter((c) => !answered.has(choiceKey(c)));

  // 你正在答当前卡片、且它后端仍然有效 → 不重渲(保住勾选/输入)，但仍静默对账队列其余项，
  // 这样已解决的卡片不会残留、新卡片不会被你的“交互中”状态永久挡在外面。
  const cur = askActive ? askQueue[askIdx] : null;
  if (isInteracting() && cur && present.has(choiceKey(cur))) {
    askQueue = fresh;
    const i = fresh.findIndex((c) => choiceKey(c) === choiceKey(cur));
    askIdx = i >= 0 ? i : 0;
    return;
  }

  askQueue = fresh;
  if (!askQueue.length) { hideAsk(); return; }
  if (askIdx >= askQueue.length) askIdx = 0;
  const sig = askQueue.map(choiceKey).join(',');
  if (askActive && sig === lastAskSig) return; // 内容没变，别重渲（保住正在输入/勾选的）
  lastAskSig = sig;
  showAskPanel();
}

function enqueueChoice(c) {
  if (!c || (!(c.options && c.options.length) && !c.allowInput)) return;
  answered.delete(choiceKey(c));
  const i = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  if (i < 0) askQueue.push(c);
  // 记事本行动中心开着 → 新事项在那里显示，不另弹面板
  if (actionPopOpen) { renderActionPop(); return; }
  // 你正在答当前面板时，新任务先进队列、不抢面板（等你答完再显示），避免打断
  if (isInteracting() && askActive) return;
  askIdx = askQueue.findIndex((x) => choiceKey(x) === choiceKey(c));
  showAskPanel();
}

function showAskPanel() {
  const c = askQueue[askIdx];
  if (!c) { hideAsk(); return; }
  if (quotaPopoverOpen) closeQuotaPopover();
  if (peekOpen) closePeek();
  const sess = c.sessionId ? ' · #' + String(c.sessionId).slice(-3) : '';
  const queue = askQueue.length > 1 ? `${askIdx + 1}/${askQueue.length} · ` : '';
  askSess.textContent = queue + (c.project || '?') + sess;

  if (c.kind === 'ask') {
    if (!elic || elic.key !== choiceKey(c)) {
      elic = { key: choiceKey(c), questions: Array.isArray(c.questions) ? c.questions : [], qIdx: 0, answers: {}, selected: null, selSet: [], multi: false, otherOn: false };
    }
    renderElicitation(c);
  } else {
    elic = null;
    if (c.kind === 'perm' && c.permId) renderPerm(c);
    else if (c.kind === 'plan' && c.permId) renderPlan(c);
    else renderContinue(c);
  }

  bubble.classList.add('hidden');
  askEl.classList.remove('hidden');
  lastAskSig = askQueue.map(choiceKey).join(',');
  askActive = true;
  fitPopup(askEl); // 富卡片：固定头尾、中部滚动，动态定高 + 520 宽
}

function clearAskBody() {
  askScroll.scrollTop = 0;
  askOpts.innerHTML = '';
  askOpts.classList.remove('perm-row');
  askQhead.textContent = '';
  askHint.textContent = '';
  askPage.textContent = '';
  askInputRow.classList.add('hidden');
  askText.value = '';
  askTerm.textContent = t('ask.goTerminal');
}

// ① elicitation（AskUserQuestion）：多选项卡 + Other + 分页 + Submit/Back
function renderElicitation(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  const qs = elic.questions;
  const q = qs[elic.qIdx] ||
    { question: c.question || t('ask.needAnswer'), options: (c.options || []).map((o) => ({ label: o.label, description: o.desc })) };
  askQhead.textContent = q.header || '';
  askQ.textContent = q.question || '';
  const multi = !!q.multiSelect;
  elic.multi = multi;
  askHint.textContent = multi ? t('ask.multiHint') : t('ask.singleHint');

  const prior = elic.answers[q.question];
  const opts = q.options || [];
  const known = (v) => opts.some((o) => o.label === v);
  if (multi) {
    const parts = prior ? String(prior).split(/,\s*/).filter(Boolean) : [];
    elic.selSet = parts.filter(known);
    const otherText = parts.find((p) => !known(p));
    elic.otherOn = !!otherText;
    elic.selected = null;
    if (otherText) askText.value = otherText;
  } else {
    elic.selSet = [];
    elic.otherOn = false;
    elic.selected = prior != null ? (known(prior) ? prior : '__other__') : null;
  }

  for (const o of opts) askOpts.appendChild(buildRadioCard(o.label, o.description, o.label, q));
  askOpts.appendChild(buildRadioCard(t('ask.other'), '', '__other__', q));
  if (elic.selected === '__other__' || (multi && elic.otherOn)) {
    askInputRow.classList.remove('hidden');
    if (!multi && prior && !known(prior)) askText.value = prior;
  }

  askPage.textContent = `${elic.qIdx + 1} / ${qs.length || 1}`;
  askFoot.classList.remove('hidden');
  const last = elic.qIdx >= (qs.length || 1) - 1;
  askSubmit.textContent = last ? t('ask.submit') : t('ask.next');
  askBack.classList.toggle('hidden', elic.qIdx === 0);
  askTerm.classList.remove('hidden');
  updateSubmitEnabled(q);
  fitPopup(askEl); // 题目切换后内容高度变了，重新定高
}

function buildRadioCard(label, desc, value, q) {
  const multi = elic.multi;
  const isSel = multi ? (value === '__other__' ? elic.otherOn : elic.selSet.includes(value)) : elic.selected === value;
  const card = document.createElement('button');
  card.className = 'ask-opt' + (multi ? ' multi' : '') + (isSel ? ' sel' : '');
  card.innerHTML =
    '<span class="ask-radio"></span><span class="ask-ot">' +
    `<span class="ask-ol">${esc(label)}</span>` + (desc ? `<span class="ask-od">${esc(desc)}</span>` : '') +
    '</span>';
  card.addEventListener('click', () => {
    if (multi) {
      if (value === '__other__') {
        elic.otherOn = !elic.otherOn;
        card.classList.toggle('sel', elic.otherOn);
        askInputRow.classList.toggle('hidden', !elic.otherOn);
        if (elic.otherOn) setTimeout(() => askText.focus(), 0);
      } else {
        const i = elic.selSet.indexOf(value);
        if (i >= 0) elic.selSet.splice(i, 1); else elic.selSet.push(value);
        card.classList.toggle('sel');
      }
    } else {
      elic.selected = value;
      askInputRow.classList.toggle('hidden', value !== '__other__');
      if (value === '__other__') setTimeout(() => askText.focus(), 0);
      [...askOpts.children].forEach((el) => el.classList.remove('sel'));
      card.classList.add('sel');
    }
    updateSubmitEnabled(q);
  });
  return card;
}

function updateSubmitEnabled() {
  let ok;
  if (elic && elic.multi) ok = elic.selSet.length > 0 || (elic.otherOn && (askText.value || '').trim());
  else ok = elic && elic.selected && (elic.selected !== '__other__' || (askText.value || '').trim());
  askSubmit.classList.toggle('disabled', !ok);
}

// 自定义输入为空时按回车：不发送，抖一下 + 提示别忘了填（2.6s 后复原 placeholder）
let emptyWarnTimer = null;
function warnEmptyInput() {
  askText.focus();
  askText.classList.add('warn');
  if (!askText.dataset.ph) askText.dataset.ph = askText.placeholder || t('ask.placeholder');
  askText.placeholder = t('ask.emptyWarn');
  clearTimeout(emptyWarnTimer);
  emptyWarnTimer = setTimeout(() => {
    askText.classList.remove('warn');
    if (askText.dataset.ph) { askText.placeholder = askText.dataset.ph; delete askText.dataset.ph; }
  }, 2600);
}

function elicNextOrSubmit(c) {
  const qs = elic.questions;
  const q = qs[elic.qIdx];
  let val;
  if (elic.multi) {
    const parts = [...elic.selSet];
    if (elic.otherOn && (askText.value || '').trim()) parts.push((askText.value).trim());
    val = parts.join(', ');
  } else {
    val = elic.selected === '__other__' ? (askText.value || '').trim() : elic.selected;
  }
  if (!val) return; // 必须先选/填
  if (q && q.question) elic.answers[q.question] = val;
  else elic.answers[c.question || '_'] = val;
  if (elic.qIdx < (qs.length || 1) - 1) { elic.qIdx++; renderElicitation(c); return; }
  decideChoice(c, { type: 'elicitation-submit', answers: { ...elic.answers } }, t('ask.submitted'));
}

function elicBack(c) {
  if (elic && elic.qIdx > 0) { elic.qIdx--; renderElicitation(c); }
}

// ② 授权：允许(绿)/拒绝(红) + 可选「始终允许」建议按钮(中性)
function renderPerm(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needPerm');
  askQhead.textContent = c.header || '';
  askQ.textContent = c.question || t('ask.needPermQ');
  const opts = c.options || [];
  if (opts.length === 2) askOpts.classList.add('perm-row'); // 仅允许/拒绝时并排
  opts.forEach((opt) => {
    const kind = opt.key === 'allow' ? 'allow' : opt.key === 'deny' ? 'deny' : 'sugg';
    const card = document.createElement('button');
    card.className = 'ask-opt act ' + kind;
    card.innerHTML = `<span class="ask-ot"><span class="ask-ol">${esc(opt.label)}</span></span>`;
    card.addEventListener('click', () => submitPerm(opt.key, c, opt.label));
    askOpts.appendChild(card);
  });
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ③ 纯回复（无选项）：只读问题 + Go to Terminal
function renderContinue(c) {
  clearAskBody();
  askLabel.textContent = t('ask.needsInput');
  askQ.textContent = c.question || t('ask.waitingReply');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

// ④ ExitPlanMode 方案评审：展示方案 + 批准 / 打回并反馈
function renderPlan(c) {
  clearAskBody();
  askLabel.textContent = t('ask.planLabel');
  askQhead.textContent = c.project ? '📂 ' + c.project : '';
  askQ.textContent = c.question || t('ask.planQ');
  const approve = document.createElement('button');
  approve.className = 'ask-opt act allow';
  approve.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.approve')) + '</span></span>';
  approve.addEventListener('click', () => submitPerm('allow', c, t('ask.approved')));
  askOpts.appendChild(approve);
  const reject = document.createElement('button');
  reject.className = 'ask-opt act deny';
  reject.innerHTML = '<span class="ask-ot"><span class="ask-ol">' + esc(t('ask.reject')) + '</span></span>';
  reject.addEventListener('click', () => {
    decideChoice(c, { type: 'plan-feedback', feedback: (askText.value || '').trim() }, t('ask.rejected'));
  });
  askOpts.appendChild(reject);
  askInputRow.classList.remove('hidden');
  askText.placeholder = t('ask.rejectPlaceholder');
  askFoot.classList.add('hidden');
  askTerm.classList.remove('hidden');
}

function finishChoice(choice, bubbleMsg) {
  answered.add(choiceKey(choice));
  elic = null;
  askQueue = askQueue.filter((c) => choiceKey(c) !== choiceKey(choice));
  if (askQueue.length) {
    // 还有下一题：直接展示，不弹确认气泡盖住选项面板
    askIdx = 0; showAskPanel();
  } else {
    // 先关面板（置 askActive=false），确认气泡才不会被 showBubble 的 askActive 早退拦掉
    hideAsk();
    showBubble(bubbleMsg, 2600);
  }
}
const decisionsInFlight = new Set();
async function decideChoice(choice, behavior, successMsg) {
  const key = choiceKey(choice);
  if (!choice || !choice.permId || decisionsInFlight.has(key)) return false;
  decisionsInFlight.add(key);
  try {
    const accepted = await window.pet.decidePermission(choice.permId, behavior);
    if (accepted === true) {
      finishChoice(choice, successMsg);
      return true;
    }
    // The held request disconnected/expired before the click. Remove the stale
    // local card, but explicitly say that no authorization was applied.
    finishChoice(choice, t('ask.expired'));
    return false;
  } catch {
    showBubble(t('ask.decisionFailed'), 4200, true);
    return false;
  } finally {
    decisionsInFlight.delete(key);
  }
}
function submitPerm(key, choice, label) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  decideChoice(choice, key, msg);
}
// Go to Terminal：去会话终端自己答（授权/elicitation 都回 deny，让 CC 在终端重问）
async function gotoSession(choice) {
  if (choice.permId) await decideChoice(choice, 'deny', t('ask.toTerminal'));
  else finishChoice(choice, t('ask.toTerminal'));
  requestSessionFocus(choice.sessionId || '');
}

function hideAsk() {
  lastAskSig = '';
  elic = null;
  askEl.classList.add('hidden');
  askHover = false;
  if (askText) askText.value = ''; // 清掉草稿，避免关闭后仍被判为「交互中」冻住状态
  if (askActive) { askActive = false; resetPetSize(); window.pet.blurPet(); }
}

// ---------- 记事本 / 行动中心 ----------
let curSessions = [];
let curActions = [];
let actionPopOpen = false;

// 当前需要你处理的事项：有 choice、还没答过的 waiting/needsinput 会话
function actionableItems() {
  const source = curActions.length
    ? curActions
    : curSessions.filter((x) => x.state === 'waiting' || x.state === 'needsinput');
  return source
    .filter((x) => x.choice && !answered.has(choiceKey(x.choice)))
    .map((x) => x.choice)
    .filter((c) => (c.options && c.options.length) || c.allowInput);
}

function updateNotepad(s) {
  curSessions = s.sessions || [];
  curActions = Array.isArray(s.actions) ? s.actions : [];
  const acts = actionableItems();
  if (!acts.length) {
    notepad.classList.add('hidden');
    if (actionPopOpen) closeActionPop();
    return;
  }
  notepad.classList.remove('hidden');
  npBadge.textContent = acts.length;
  npBadge.classList.add('urgent');
  // 弹层开着、且用户没在弹层里打字 → 同步刷新内容
  if (actionPopOpen && !actionPop.contains(document.activeElement)) { renderActionPop(); fitPopup(actionPop); }
}

function renderActionPop() {
  const acts = actionableItems();
  // 需要你处理
  if (acts.length) {
    acActSec.classList.remove('hidden');
    acActs.innerHTML = '';
    acts.forEach((c) => acActs.appendChild(buildActCard(c)));
  } else {
    acActSec.classList.add('hidden');
    acActs.innerHTML = '';
  }
}

// 一张「需要你处理」卡片：问题 + 选项按钮(可点即答) + 自定义输入
function buildActCard(c) {
  const card = document.createElement('div');
  card.className = 'ac-act';
  const kindTag = c.kind === 'perm' ? t('ask.kindPerm')
    : c.kind === 'continue' ? t('ask.kindContinue')
      : c.kind === 'plan' ? t('ask.kindPlan') : t('ask.kindChoice');
  const head = document.createElement('div');
  head.className = 'ac-act-proj';
  head.textContent = `📂 ${c.project || '?'} · ${kindTag}`;
  card.appendChild(head);
  const q = document.createElement('div');
  q.className = 'ac-act-q';
  q.textContent = (c.header ? '【' + c.header + '】 ' : '') + (c.question || t('ask.needHandling'));
  card.appendChild(q);

  const opts = document.createElement('div');
  opts.className = 'ac-act-opts';
  if (c.kind === 'perm' && c.permId) {
    // 授权：允许/拒绝 → HTTP 原生通道回 CC
    (c.options || []).forEach((opt) => {
      const b = document.createElement('button');
      b.textContent = opt.label;
      if (opt.desc) b.title = opt.desc;
      b.addEventListener('click', (e) => { e.stopPropagation(); popPerm(c, opt.key); });
      opts.appendChild(b);
    });
  } else {
    // 对话类：选项只读展示 + 「去回复」按钮（桌宠不替你打字）
    (c.options || []).forEach((opt) => {
      const label = typeof opt === 'string' ? opt : opt.label;
      const desc = typeof opt === 'string' ? '' : opt.desc || '';
      const d = document.createElement('div');
      d.className = 'ac-act-ro';
      d.textContent = label;
      if (desc) d.title = desc;
      opts.appendChild(d);
    });
    const go = document.createElement('button');
    go.className = 'ac-act-go';
    go.textContent = t('ask.goReply');
    go.addEventListener('click', (e) => { e.stopPropagation(); popGoto(c); });
    opts.appendChild(go);
  }
  card.appendChild(opts);
  return card;
}

// 授权：回 CC 决策
async function popPerm(choice, key) {
  const msg = key === 'allow' ? t('ask.allowed') : key === 'deny' ? t('ask.denied') : t('ask.remembered');
  await decideChoice(choice, key, msg);
  renderActionPop();
  maybeCloseEmptyPop();
}
// 对话类：定位并唤起该会话窗口
async function popGoto(choice) {
  // AskUserQuestion and ExitPlanMode also hold a PermissionRequest connection.
  // Deny it before handing control to the terminal so the request cannot stay
  // parked invisibly behind the action-center acknowledgement.
  if (choice.permId) await decideChoice(choice, 'deny', t('ask.toTerminal'));
  else answered.add(choiceKey(choice));
  requestSessionFocus(choice.sessionId || '');
  renderActionPop();
  maybeCloseEmptyPop();
}
function maybeCloseEmptyPop() {
  if (!actionableItems().length) closeActionPop();
}

function openActionPop() {
  if (askActive) hideAsk(); // 别和选项面板抢窗口
  if (peekOpen) closePeek();
  if (quotaPopoverOpen) closeQuotaPopover();
  renderActionPop();
  actionPop.classList.remove('hidden');
  actionPopOpen = true;
  fitPopup(actionPop);
}
function closeActionPop() {
  // 早退守卫：有几个调用点（maybeCloseEmptyPop、面板按钮）不检查 actionPopOpen 就调过来。
  // 没有它，关着的弹层也会白走一遍 blurPet() + resetPetSize()：多余的失焦会掐断
  // mousemove（见 main.js releaseClickThrough 的 G1 注释），而 window 上的 blur 监听
  // 又会回调这些 closer —— 「blur 递归靠调用顺序偶然终止」由此变成显式不变量。
  if (!actionPopOpen) return;
  actionPop.classList.add('hidden');
  actionPopOpen = false;
  window.pet.blurPet();
  // 和 closePeek 同款守卫：ask 卡片还开着时不许缩回静息尺寸，否则卡片被帧裁到视口外，
  // 而 HIT_SEL 对视口外的 #ask 做 elementFromPoint 拿到 null → 对用户还看得见的区域设穿透。
  if (!askActive && !peekOpen) resetPetSize();
}

// 状态标签仅用于猫猫头顶的状态点。
const SESS_META_ICON = {
  waiting: '✋ ', needsinput: '💬 ', working: '⚙️ ', juggling: '🤹 ',
  sweeping: '🧹 ', thinking: '💭 ', loafing: '🍦 ', error: '😵 ',
  idle: '', sleeping: '💤 ',
};
const SESS_META_KEY = {
  waiting: 'state.waiting', needsinput: 'state.needsinput', working: 'state.working',
  juggling: 'state.juggling', sweeping: 'state.sweeping', thinking: 'state.thinking',
  loafing: 'state.loafingLong', error: 'state.error', idle: 'state.idle',
  sleeping: 'state.sleeping',
};
function sessMeta(state) {
  const key = SESS_META_KEY[state];
  return key ? (SESS_META_ICON[state] || '') + t(key) : null;
}
const SESS_SORT = { waiting: 0, needsinput: 0, error: 1, working: 2, juggling: 2, sweeping: 2, thinking: 2, loafing: 3, idle: 4, sleeping: 5 };

const isBaseVisibleSession = (s) => !!s && !s.headless && s.state !== 'sleeping';
// 单一配色：完成→绿、中断→红，否则按状态。
function sessionDotClass(s) {
  if (s.state === 'idle' && s.badge === 'done') return 'done';
  if (s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return s.state || 'idle';
}

// ---------- 左键工作速览 ----------
const PEEK_AUTO_CLOSE_MS = 8000;
const PEEK_BUSY_STATES = new Set(['waiting', 'needsinput', 'error', 'working', 'juggling', 'sweeping', 'thinking', 'loafing']);
let peekOpen = false;
let peekTimer = null;
let peekLayoutSig = '';
let peekPrimarySessionId = '';

// s.agent 已经是短 key（claude / codex / …），但历史数据里可能是完整的
// agentId（'claude-code'）。shortKey() 两种都吃，未知值回落 'claude'。
function peekAgentKey(agent) {
  try {
    if (window.WorkMeowAgents && typeof window.WorkMeowAgents.shortKey === 'function') {
      if (window.WorkMeowAgents.isKnownKey(agent)) return agent;
      return window.WorkMeowAgents.shortKey(agent);
    }
  } catch {}
  return agent || 'claude';
}

function peekAgentLabel(agent) {
  try {
    if (window.WorkMeowAgents && typeof window.WorkMeowAgents.shortLabel === 'function') {
      return window.WorkMeowAgents.shortLabel(agent);
    }
  } catch {}
  return ({ claude: 'Claude', codex: 'Codex', trae: 'TRAE', workbuddy: 'WorkBuddy', opencode: 'opencode' })[agent] || 'AI';
}

// 图标来自 renderer/icons.js（pet.html:148 已加载）。拿不到就回空串：
// .peek-row-agent 那一格会塌成 0 宽，行还是完整的 —— 比整个速览炸掉好。
function peekAgentSvg(agent) {
  try {
    if (window.WorkMeowIcons && typeof window.WorkMeowIcons.agentIcon === 'function') {
      return window.WorkMeowIcons.agentIcon(agent);
    }
  } catch {}
  return '';
}

// 速览右侧的持续时间：只留数字 + 单位（s/m/h/d），不再写「会话已持续」这类
// 前缀——状态点已经说明是「进行中」，重复一遍「会话已持续」纯属占地方。
function peekTime(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return '0s';
  if (value < 60 * 1000) return `${Math.max(1, Math.floor(value / 1000))}s`;
  if (value < 60 * 60 * 1000) return `${Math.max(1, Math.floor(value / 60000))}m`;
  if (value < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(value / 3600000))}h`;
  return `${Math.max(1, Math.floor(value / 86400000))}d`;
}

function peekSessionState(s) {
  if (s && s.state === 'idle' && s.badge === 'done') return 'done';
  if (s && s.state === 'idle' && s.badge === 'interrupted') return 'error';
  return (s && s.state) || 'idle';
}

function peekSessionDetail(s) {
  const effective = peekSessionState(s);
  if (effective === 'done') return t('peek.done');
  if (s && s.state === 'idle' && s.badge === 'interrupted') return t('peek.interrupted');
  if (effective === 'waiting') return waitPhrase(s.reason);
  if (effective === 'needsinput') return (s.choice && s.choice.question) || t('state.needsinput');
  if (effective === 'error') return t('peek.errorDetail');
  const background = backgroundStatus(s);
  if (background) return background;
  if (s.op) return s.op;
  const key = SESS_META_KEY[effective];
  return key ? t(key) : t('state.idle');
}

function peekSessionTime(s) {
  const effective = peekSessionState(s);
  const turnStartedAt = Number(s && s.turnStartedAt) || 0;
  if (turnStartedAt > 0 && PEEK_BUSY_STATES.has(effective)) {
    return t('peek.elapsed', { time: peekTime(Date.now() - turnStartedAt) });
  }
  return t('peek.updated', { time: peekTime(s && s.idleMs) });
}

function peekSessions(stats) {
  const visible = (stats.sessions || []).filter((s) => s && !s.headless && s.state !== 'sleeping');
  const active = visible.filter((s) => PEEK_BUSY_STATES.has(s.state));
  const list = active.length
    ? active
    : visible
      .filter((s) => s.badge === 'done' || s.badge === 'interrupted')
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, 1);
  return list.slice().sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 4;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 4;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
}

function makePeekRow(s) {
  const effective = peekSessionState(s);
  const focusable = s.focusable !== false;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'peek-row' + (focusable ? '' : ' not-focusable');
  row.title = focusable ? t('peek.focus') : t('peek.viewOnly');

  const dot = document.createElement('span');
  dot.className = 'peek-row-dot ' + effective;
  dot.setAttribute('aria-hidden', 'true');

  // Agent 用图标而不是文字前缀。原来这里是「Codex · WorkMeow」，固定前缀在
  // 180px 出头的标题列里能吃掉 ~65px，真正的项目名反而先被省略号截掉。
  // 2026-09-16 换成图标，全名只进 title / aria-label（读屏和悬停仍拿得到）。
  //
  // 图标是 .peek-row 网格的第 2 格，**不塞进 .peek-row-main** —— 后者靠
  // min-width:0 + overflow:hidden 撑省略号，往里加同级元素会把那套约束搅乱。
  // 单独一格还能和状态点对齐成一条竖线。
  const agentKey = peekAgentKey(s.agent);
  const agentIcon = document.createElement('span');
  agentIcon.className = 'peek-row-agent';
  agentIcon.innerHTML = peekAgentSvg(agentKey);
  // 图标本身对读屏无意义（SVG 里已经 aria-hidden），名字挂在容器的 label 上。
  agentIcon.setAttribute('aria-label', peekAgentLabel(agentKey));
  agentIcon.title = peekAgentLabel(agentKey);

  const main = document.createElement('span');
  main.className = 'peek-row-main';
  const project = document.createElement('span');
  project.className = 'peek-row-project';
  project.textContent = s.project || t('peek.unknownProject');
  // title 仍带上 Agent 名：图标认不出来时，悬停能问出「这是哪个」。
  project.title = `${peekAgentLabel(agentKey)} · ${project.textContent}`;
  const detail = document.createElement('span');
  detail.className = 'peek-row-detail';
  detail.textContent = peekSessionDetail(s);
  main.appendChild(project);
  main.appendChild(detail);

  const time = document.createElement('span');
  time.className = 'peek-row-time';
  time.textContent = peekSessionTime(s);

  row.appendChild(dot);
  row.appendChild(agentIcon);
  row.appendChild(main);
  row.appendChild(time);
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const sessionId = s.sessionId || '';
    closePeek();
    if (focusable && sessionId) requestSessionFocus(sessionId);
    else window.pet.openPanel(AGENT);
  });
  return row;
}

function renderPeek(stats) {
  if (!stats) return;
  const restingState = stats.idleMs == null || stats.idleMs > IDLE_SLEEP_MS ? 'sleeping' : 'idle';
  const rows = peekSessions(stats);
  const attention = (stats.sessions || []).filter((s) => !s.headless && (s.state === 'waiting' || s.state === 'needsinput'));
  const errors = (stats.sessions || []).filter((s) => !s.headless && s.state === 'error');
  const running = (stats.sessions || []).filter((s) => !s.headless && ['working', 'juggling', 'sweeping', 'thinking', 'loafing'].includes(s.state));
  const primary = rows[0] || null;
  const headlineState = attention.length ? attention[0].state
      : errors.length ? 'error'
      : primary ? peekSessionState(primary)
        : restingState;

  if (attention.length) peekTitle.textContent = t('peek.attentionTitle', { count: attention.length });
  else if (errors.length) peekTitle.textContent = t('peek.errorTitle', { count: errors.length });
  else if (running.length > 1) peekTitle.textContent = t('peek.multiTitle', { count: running.length });
  else if (primary && PEEK_BUSY_STATES.has(primary.state)) peekTitle.textContent = t(SESS_META_KEY[primary.state] || 'state.working');
  else peekTitle.textContent = t('peek.idleTitle');

  if (rows.length > 1) {
    peekSubtitle.textContent = rows.some((s) => s.focusable === false)
      ? t('peek.multiSubDetails')
      : t('peek.multiSub');
  }
  else if (primary && PEEK_BUSY_STATES.has(primary.state)) {
    // 只剩项目名，不再带 Agent 前缀 —— 这一支只在**单会话**时走到，下面那唯一
    // 一行里已经有 Agent 图标了，标题再重复一遍纯属挤地方。
    peekSubtitle.textContent = t('peek.sessionSub', {
      project: primary.project || t('peek.unknownProject'),
    });
  } else {
    peekSubtitle.textContent = restingState === 'sleeping' ? t('peek.sleepingSub') : t('peek.idleSub');
  }

  peekState.className = 'peek-state ' + headlineState;
  peekList.innerHTML = '';
  rows.slice(0, 3).forEach((s) => peekList.appendChild(makePeekRow(s)));

  const today = stats.today || {};
  const rounds = Number(today.messages != null ? today.messages : today.msgs) || 0;
  if (running.length || attention.length || errors.length) {
    let summary = t('peek.running', { running: running.length, waiting: attention.length, rounds });
    if (rows.length > 3) summary += ' · ' + t('peek.more', { count: rows.length - 3 });
    peekSummary.textContent = summary;
  } else {
    peekSummary.textContent = t('peek.today', {
      rounds,
      tokens: compactTokens(today.tokens || 0),
      cost: '$' + (Number(today.cost) || 0).toFixed(3),
    });
  }

  const showPurrHint = !running.length && !attention.length && !errors.length;
  peekHint.hidden = !showPurrHint;
  if (showPurrHint) peekHint.textContent = t('purr.hint');

  peekPrimarySessionId = primary && primary.focusable !== false && primary.sessionId ? primary.sessionId : '';
  peekFocus.classList.toggle('hidden', !peekPrimarySessionId);
  peekPanel.style.flex = peekPrimarySessionId ? '' : '1';

  const layoutSig = [attention.length ? 'attention' : errors.length ? 'error' : running.length ? 'running' : 'idle', Math.min(rows.length, 3), !!peekPrimarySessionId, showPurrHint].join(':');
  if (peekOpen && layoutSig !== peekLayoutSig) fitPopup(peekEl);
  peekLayoutSig = layoutSig;
}

function clearPeekTimer() {
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = null;
}

function armPeekTimer() {
  clearPeekTimer();
  if (peekOpen) peekTimer = setTimeout(closePeek, PEEK_AUTO_CLOSE_MS);
}

function openPeek() {
  if (!lastStats || askActive || actionPopOpen || radialOpen) return;
  if (quotaPopoverOpen) closeQuotaPopover();
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubble.classList.add('hidden');
  renderPeek(lastStats);
  peekEl.classList.remove('hidden');
  peekOpen = true;
  fitPopup(peekEl);
  armPeekTimer();
}

function closePeek() {
  if (!peekOpen) return;
  clearPeekTimer();
  peekEl.classList.add('hidden');
  peekOpen = false;
  peekLayoutSig = '';
  peekPrimarySessionId = '';
  // ⚠️ 这里**刻意不调** window.pet.blurPet()（H1）。blurPet 现在只剩「把焦点还给用户
  // 原来在用的编辑器」这一重职责，而 #peek 里没有任何输入框（全仓库只有 #ask 有
  // textarea），它从来就没有焦点可还。
  //
  // 而主动失焦本身有两个已实测的代价：
  //  1. 透明窗失焦 → visibilityState=hidden → 合成器停止提交帧 = 猫在屏幕上消失再出现
  //     （用户原话「左键气泡消失后的时候，喵也没了。然后再出现」；上游已由 petWin 的
  //     backgroundThrottling:false 堵住，这里是第二道正交的保险）；
  //  2. w.blur() 会让主进程单方面 releaseClickThrough(st)，而渲染端的 mouseIgnoring
  //     不知情 → 双向 desync，窗口永久停在「该穿透时不穿透」（实测：desync 后每个
  //     mousemove 都被早退守卫吞成 SKIP，IPC 一次都不发）。
  //
  // 曾经以为它不能删，因为它是 F4（贴边开关气泡后猫朝屏幕中心漂）的触发源 —— 已被
  // A/B 12 例证伪：两组 frameChanges 全 0，真正修掉 F4 的是 enableLargerThanScreen。
  // ⚠️ hideAsk() 里的 blurPet() 不许照此删除：那里有真输入框，删了会一直霸占焦点。
  if (!askActive && !actionPopOpen) resetPetSize();
}

function handleCatClick() {
  if (radialOpen) { closeRadial(); return; }
  if (askActive) { hideAsk(); return; }
  if (actionPopOpen) { closeActionPop(); return; }
  if (quotaPopoverOpen) { closeQuotaPopover(); return; }
  if (peekOpen) { closePeek(); return; }

  const acts = actionableItems();
  if (acts.length > 1) { openActionPop(); return; }
  if (acts.length === 1) {
    const i = askQueue.findIndex((c) => choiceKey(c) === choiceKey(acts[0]));
    if (i >= 0) askIdx = i;
    else { askQueue = [acts[0]]; askIdx = 0; }
    showAskPanel();
    return;
  }
  openPeek();
}

// 工具 -> 干活动作；道具 emoji 的运动变体
const TOOL_ACT = {
  Edit: 'type', MultiEdit: 'type', Write: 'type', NotebookEdit: 'type',
  Read: 'read',
  Bash: 'crank',
  Grep: 'search', Glob: 'search',
  WebSearch: 'web', WebFetch: 'web',
  Task: 'summon', Agent: 'summon',
  TodoWrite: 'check',
};
const ACT_CLASSES = ['act-type', 'act-read', 'act-search', 'act-crank', 'act-web', 'act-summon', 'act-check', 'act-work'];
const PROP_MOTION = { crank: 'spin', web: 'spin', search: 'hunt', type: 'jit' };
let actTimer = null;

let state = 'idle';
let bubbleTimer = null;
let transientUntil = 0;   // 短暂状态（happy/error）持续到的时间
let transientState = null;
let radialOpen = false;

const IDLE_SLEEP_MS = 6 * 60 * 1000;
const PURR_HOLD_MS = 1100;
const PURR_DISPLAY_MS = 6200;
// 点击容差（屏幕像素，曼哈顿距离）。拖动手势一旦越过 4px 阈值就置 moved，而且
// 不可回退；但真人点击（触控板尤其）在按下到松开之间常有几像素漂移，于是整次
// 点击被误判成拖动吞掉 —— 用户看到的就是「频繁点击喵，气泡有时不弹、喵毫无反应」。
// 所以在松手时用**最终**位移复核一次：指针回到起点附近就仍按点击处理，过程中的
// 窗口漂移交给 settleEdgeLayout 归位。取值必须 < 10，否则会破坏既有的
// 「拖动超过 4px 不误打开速览」语义（那条用例的最终位移正好是 10px）。
const CLICK_SLOP = 8;
const PURR_DAY_STORAGE_KEY = 'workmeow.purr-payday-day';
// 额度详情采用显式点击，而不是原生 title。离开触发区/详情卡后留一点缓冲，
// 让鼠标可以从胶囊移动到卡片；卡片打开期间每 30 秒刷新一次倒计时文案。
const QUOTA_POPOVER_LEAVE_MS = 900;
const QUOTA_POPOVER_REFRESH_MS = 30 * 1000;
let catVisible = true;
let purrPaydayUntil = 0;
let purrPaydaySummary = null;
let purrPaydayTimer = null;
let quotaPopoverOpen = false;
let quotaPopoverCloseTimer = null;
let quotaPopoverRefreshTimer = null;
let quotaPopoverPointerInside = false;
const stateEls = [cat];
// ---------- 状态机（固定使用打工喵形象） ----------
// 前端会 setState 的全部状态词（聚合态 + 短暂态 + 情绪态）——统一取自
// shared/states.js（pet.html 以 <script> 在 pet.js 之前加载它）。classList.remove
// 必须覆盖此全集，漏一个就会 class 残留在皮肤元素上。
const STATE_WORDS = (window.WorkMeowStates && window.WorkMeowStates.RENDER_STATE_WORDS) || [];
function setState(s) {
  if (state === s) {
    // 语义状态没变，限时视觉层仍可能刚刚到期；同状态快照也要让猫
    // 重新选图，否则 30s 的高压工作姿态会一直拖到下一次状态切换。
    updateCat(s);
    return;
  }
  for (const el of stateEls) {
    el.classList.remove(...STATE_WORDS);
    el.classList.add(s);
  }
  state = s;
  thinkEl.classList.toggle('on', s === 'thinking');
  sleepEl.classList.toggle('on', s === 'sleeping');
  if (s === 'thinking' || s === 'sleeping') bubble.classList.add('hidden');
  if (s === 'working') {
    // 进入干活态 → 立刻挂上「持续忙碌」基线动作，不等具体 tool 事件，
    // 任何时刻都显得在忙（具体 tool 动作会在它之上叠加，结束后回落到这里）。
    for (const el of stateEls) el.classList.add('act-work');
  } else {
    clearAction(); // 离开干活态才清掉动作
  }
  // 注意：不要在这里 hideAsk()！面板显隐只由 refreshAsk(按是否有待答事项) 管。
  // 之前「s!=='waiting' 就 hideAsk」会在聚合态变 working/thinking 时把 needsinput 的面板闪掉。
  updateCat(s);
}

function positionProp() {
  const el = curSkinEl();
  if (!el || !propEl) return;
  const stageRect = stage.getBoundingClientRect();
  const petRect = el.getBoundingClientRect();
  const sessionRect = !catVisible && sessionsEl && sessionsEl.children.length
    ? sessionsEl.getBoundingClientRect()
    : null;
  const size = 28;
  const gap = 7;
  const viewportW = Math.max(1, stageRect.width || window.innerWidth || 320);
  const viewportH = Math.max(1, stageRect.height || window.innerHeight || 340);
  const petLeft = petRect.left - stageRect.left;
  const petTop = petRect.top - stageRect.top;
  const petRight = petLeft + petRect.width;
  // 道具能落在哪一段，必须按**屏幕**算，不能只按窗口视口算。
  // 2026-09-17 起横向钳的是猫本体，窗口原点合法地可以悬出屏幕（单侧最多 (帧宽-120)/2
  // ≈ 200px）。猫贴住屏幕左缘时，窗口左边那 200px 透明留白整块在屏幕外 —— 按视口算
  // 会觉得「左边还有 200px 空位」，把道具放到屏幕外。所以把可用区间取成
  // 「窗口视口 ∩ 工作区」，再换算成 stage 局部坐标。
  const stageScreenX = Number.isFinite(window.screenX) ? window.screenX + stageRect.left : null;
  const wa = browserWorkArea();
  const minLeft = stageScreenX === null ? 4 : Math.max(4, wa.x - stageScreenX + 4);
  const maxRight = stageScreenX === null
    ? viewportW - 4
    : Math.min(viewportW - 4, wa.x + wa.width - stageScreenX - 4);
  // 哪边屏幕余量大就往哪边放。之前这里先看 edgeLayout.horizontal（贴左缘→只能放
  // 右侧），横向贴边态退役后改成直接比余量，语义一致且不依赖任何贴边状态。
  const roomRight = maxRight - (petRight + gap + size);
  const roomLeft = (petLeft - gap) - minLeft;
  const preferRight = roomRight >= roomLeft;
  // In compact mode the row is [session dots][capsule]. The tool prop must
  // sit before that whole cluster, not between the dots and the capsule.
  // Read the live dots rect each time so a changing parallel-session count
  // moves the prop with the first dot instead of covering it.
  const insideViewport = (value) => value >= minLeft && value + size <= maxRight;
  let left;
  if (sessionRect && sessionRect.width > 0) {
    const beforeDots = sessionRect.left - stageRect.left - size - gap;
    const afterCapsule = petRight + gap;
    const beforeCapsule = petLeft - size - gap;
    // The first candidate is the requested position. The fallbacks keep the
    // prop away from the dots when there is no outside room at an edge.
    left = [beforeDots, afterCapsule, beforeCapsule].find(insideViewport) ?? beforeDots;
  } else {
    left = preferRight ? petRight + gap : petLeft - size - gap;
  }
  if (!insideViewport(left)) {
    left = preferRight ? petLeft - size - gap : petRight + gap;
  }
  const top = Math.max(4, Math.min(viewportH - size - 4, petTop + petRect.height * 0.18));
  propEl.style.left = Math.round(Math.max(minLeft, Math.min(maxRight - size, left))) + 'px';
  propEl.style.top = Math.round(top) + 'px';
  propEl.style.right = 'auto';
  propEl.style.bottom = 'auto';
}

// 按工具播放专属动作 + 头顶道具
function playAction(toolName, icon) {
  if (state === 'waiting' || state === 'sleeping') return;
  const act = TOOL_ACT[toolName] || 'work';
  for (const el of stateEls) {
    el.classList.remove(...ACT_CLASSES);
    el.classList.add('act-' + act); // 通用 work 也有身体动作（不再只闪图标）
  }
  if (icon) {
    positionProp();
    propEl.textContent = icon;
    propEl.className = 'prop';
    void propEl.offsetWidth; // 重启动画
    const pm = PROP_MOTION[act];
    propEl.className = 'prop on' + (pm ? ' ' + pm : '');
  }
  if (act === 'summon') {
    sidekickEl.classList.remove('on');
    void sidekickEl.offsetWidth;
    sidekickEl.classList.add('on');
  }
  clearTimeout(actTimer);
  actTimer = setTimeout(clearAction, 2200);
}
function clearAction() {
  for (const el of stateEls) el.classList.remove(...ACT_CLASSES);
  propEl.classList.remove('on');
  // 具体 tool 动作结束后，仍在干活 → 回落到「持续忙碌」基线，别安静下来
  if (state === 'working') for (const el of stateEls) el.classList.add('act-work');
}

// 短暂状态：happy/error/greet…，到点后由 applyStats 接管。
// 到期不再干等下一个快照（周期推送最坏 ~4s，短暂态会拖尾）——
// 定时用最近一次快照主动重算聚合态，到点即回落。
let transientTimer = null;
function transient(s, ms, text, holdMs) {
  if (state === 'waiting') return; // 等用户优先
  transientState = s;
  transientUntil = perfNow() + ms;
  setState(s);
  clearTimeout(transientTimer);
  transientTimer = setTimeout(() => { if (lastStats) applyStats(lastStats); }, ms + 30);
  if (text) showBubble(text, holdMs || ms);
}
// 高优先级稳态（waiting/needsinput/error）接管时清掉残留短暂态，
// 否则 talking/thinking 会在下个快照借 transientUntil 复活盖回来。
function clearTransient() {
  transientUntil = 0;
  clearTimeout(transientTimer);
}

// 大任务完成的彩带
function confetti() {
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height * 0.35;
  const emojis = ['🎉', '✨', '⭐', '🧡', '🎊'];
  for (let i = 0; i < 12; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.textContent = emojis[i % emojis.length];
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 1.8; // 向上扇形
    const dist = 45 + Math.random() * 70;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = 12 + Math.random() * 12 + 'px';
    s.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    s.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    s.style.animationDelay = Math.random() * 0.12 + 's';
    stage.appendChild(s);
    setTimeout(() => s.remove(), 1300);
  }
}

function positionBubbleTip() {
  if (!bubble || bubble.classList.contains('hidden')) return;
  const el = curSkinEl();
  if (!el) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (bubble.classList.contains('hidden')) return;
      const sr = stage.getBoundingClientRect();
      const petRect = el.getBoundingClientRect();
      const bubRect = bubble.getBoundingClientRect();
      const petCenterX = petRect.left - sr.left + petRect.width / 2;
      const bubLeft = bubRect.left - sr.left;
      const relX = petCenterX - bubLeft;
      // Keep the triangle inside the bubble's rounded corners.
      const minX = 14;
      const maxX = Math.max(minX + 1, bubRect.width - 14);
      const tipX = Math.min(Math.max(relX, minX), maxX);
      bubble.style.setProperty('--tip-x', tipX + 'px');
    });
  });
}

function positionQuotaPopoverTip() {
  if (!quotaPopover || quotaPopover.classList.contains('hidden') || !quotaEl) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (quotaPopover.classList.contains('hidden')) return;
      const sr = stage.getBoundingClientRect();
      const triggerRect = quotaEl.getBoundingClientRect();
      const popRect = quotaPopover.getBoundingClientRect();
      const triggerCenterX = triggerRect.left - sr.left + triggerRect.width / 2;
      const popLeft = popRect.left - sr.left;
      const relX = triggerCenterX - popLeft;
      const minX = 14;
      const maxX = Math.max(minX + 1, popRect.width - 14);
      quotaPopover.style.setProperty('--quota-tip-x', Math.min(Math.max(relX, minX), maxX) + 'px');
    });
  });
}

function showBubble(text, holdMs = 3200, force = false) {
  if (!force && (radialOpen || askActive || peekOpen || quotaPopoverOpen)) return; // 弹层开着时不用普通气泡盖住它
  // emoji → 内联 SVG（WorkMeowIcons 在 emoji 字符与 SVG 之间做安全替换；不可识别字符原样保留）
  if (window.WorkMeowIcons && window.WorkMeowIcons.hasMappedEmoji(text)) {
    window.WorkMeowIcons.setTextWithIcons(bubbleText, text);
  } else {
    bubbleText.textContent = text;
  }
  bubble.classList.remove('hidden');
  bubble.scrollTop = 0; // 重置滚动到顶（上次长气泡可能滚到了下边）
  // 大段文字：把窗口按实际高度撑开（fitPopup 已按屏幕封顶，永远不顶出屏幕；
  // 实在超屏时由 #bubble 自身 overflow-y:auto 内滚动兜底）。
  fitPopup(bubble);
  positionBubbleTip();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, holdMs);
}

const pendingQuotaAlerts = new Map();
let quotaAlertRetryTimer = null;
let quotaAlertDisplaying = false;
function quotaAlertUiBusy() {
  return document.hidden === true || radialOpen || askActive || actionPopOpen || peekOpen || quotaPopoverOpen
    || !bubble.classList.contains('hidden');
}
function scheduleQuotaAlertRetry() {
  if (!quotaAlertRetryTimer) quotaAlertRetryTimer = setTimeout(flushQuotaAlerts, 250);
}
function flushQuotaAlerts() {
  quotaAlertRetryTimer = null;
  if (!pendingQuotaAlerts.size || quotaAlertDisplaying) return;
  if (quotaAlertUiBusy()) {
    scheduleQuotaAlertRetry();
    return;
  }
  const entries = [...pendingQuotaAlerts.entries()];
  const text = entries.map(([, alert]) => alert.text).join('\n');
  quotaAlertDisplaying = true;
  showBubble(text, 6500);
  // Do not claim on a synchronous DOM mutation alone. Wait until a paint can
  // happen, then verify the window stayed visible and the bubble was not
  // replaced by a higher-priority event.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    quotaAlertDisplaying = false;
    const visible = document.hidden !== true && !bubble.classList.contains('hidden')
      && bubbleText.textContent === text;
    if (!visible) {
      scheduleQuotaAlertRetry();
      return;
    }
    const alertIds = [];
    for (const [key, alert] of entries) {
      pendingQuotaAlerts.delete(key);
      if (alert.id) alertIds.push(alert.id);
    }
    if (alertIds.length) window.pet.quotaAlertShown(alertIds);
    if (pendingQuotaAlerts.size) scheduleQuotaAlertRetry();
  }));
}
function enqueueQuotaAlert(ev) {
  const alerts = Array.isArray(ev && ev.quotaAlerts) ? ev.quotaAlerts : [];
  for (const alert of alerts) {
    if (!alert || typeof alert.id !== 'string' || !alert.id || typeof alert.text !== 'string') continue;
    pendingQuotaAlerts.set(alert.id, alert);
  }
  if (!pendingQuotaAlerts.size && ev && ev.text) {
    // Compatibility with an in-flight event from an older main process.
    pendingQuotaAlerts.set(`legacy:${ev.ts || Date.now()}`, { id: null, text: ev.text });
  }
  if (!quotaAlertRetryTimer && !quotaAlertDisplaying) flushQuotaAlerts();
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pendingQuotaAlerts.size && !quotaAlertRetryTimer) flushQuotaAlerts();
});

function requestSessionFocus(sessionId) {
  if (!sessionId) return;
  Promise.resolve(window.pet.focusSession(sessionId))
    .then((focused) => {
      if (focused === false) showBubble(t('peek.focusFailed'), 4200, true);
    })
    .catch(() => showBubble(t('peek.focusFailed'), 4200, true));
}
function hideBubble() {
  bubble.classList.add('hidden');
  // 若没有其它弹层占用大窗口尺寸，恢复原始尺寸（避免 pet 一直停在加大窗口里）
  if (!askActive && !actionPopOpen && !peekOpen) resetPetSize();
}

const curSkinEl = () => catVisible ? cat : chip;

window.pet.onEvent((ev) => {
  if (ev.kind === 'quota-alert') {
    // Queue first: hidden windows and active popups must defer the bubble, not
    // consume the only alert for this reset cycle.
    enqueueQuotaAlert(ev);
    return;
  }
  // 需要人处理或出错时，优先让出工作速览，保持原有卡片/气泡路径。
  if (peekOpen && (ev.kind === 'waiting' || ev.kind === 'needsinput' || ev.kind === 'error')) closePeek();
  if (quotaPopoverOpen && (ev.kind === 'waiting' || ev.kind === 'needsinput' || ev.kind === 'error')) closeQuotaPopover();
  // 你正在答面板/打字时：新的待答任务只悄悄进队列(不抢面板)，其余动画/彩带/气泡/状态变化一律不打断
  if (isInteracting()) {
    if ((ev.kind === 'waiting' || ev.kind === 'needsinput') && ev.choice) enqueueChoice(ev.choice);
    return;
  }
  switch (ev.kind) {
    case 'operation': {
      // 高优先级稳态（等授权/等回复/出错/清理）不被工具事件降级成 working——
      // 之前 error 期间其它会话干活会导致 working↔error 持续闪烁。
      const hold = state === 'waiting' || state === 'needsinput' || state === 'error' || state === 'sweeping';
      // “收到任务”产生的 thinking 只是等待首个动作的过渡态；真实工具一开始就应
      // 立刻切到 working。庆祝/说话/情绪等其它 transient 仍完整播放。
      const startingWork = transientState === 'thinking' && perfNow() < transientUntil;
      if (!hold && (startingWork || perfNow() >= transientUntil)) {
        if (startingWork) clearTransient();
        setState('working');
        playAction(ev.tool, ev.icon);
      }
      showBubble(`${ev.icon || '🔧'} ${ev.detail}`);
      break;
    }
    case 'say':
      if (ev.text && ev.text.length > 2 && state !== 'waiting') {
        const dur = Math.min(6000, Math.max(2200, ev.text.length * 80));
        // Stop 会同批派生 turn-done(happy) + say(talking)：让庆祝先演完，
        // talking 排在 happy 结束后接棒，气泡文本立刻显示不用等。
        if (transientState === 'happy' && perfNow() < transientUntil) {
          showBubble(`💬 ${ev.text}`, Math.min(4200, dur));
          const token = ++sayToken;
          setTimeout(() => {
            if (token === sayToken && state !== 'waiting') transient(ev.emotion || 'talking', dur);
          }, Math.max(0, transientUntil - perfNow()));
        } else if (ev.emotion) {
          // Claude 的话里带情绪（sorry/puzzled/excited）→ 短暂表情替代 talking
          transient(ev.emotion, 2800, `💬 ${ev.text}`, Math.min(4200, ev.text.length * 80));
        } else {
          transient('talking', dur, `💬 ${ev.text}`, Math.min(4200, dur));
        }
      }
      break;
    case 'user-turn':
      // 你的输入里带情绪（loved/sad/excited）→ 打工喵即时反应；否则像以前一样进 thinking
      if (ev.emotion && state !== 'waiting') {
        const tip = ev.emotion === 'loved' ? t('bub.loved') : ev.emotion === 'sad' ? t('bub.sad') : t('bub.ack');
        transient(ev.emotion, 2800, tip, 2600);
      } else {
        // 多会话时聚合里 working > thinking，直接 setState 会在下个快照被盖掉
        // （只闪 ~150ms）。用 transient 保证「刚提交任务」的思考表情至少停留一会。
        if (state !== 'waiting') transient('thinking', 3500);
        showBubble(t('bub.newTask'), 2600);
      }
      break;
    case 'turn-done':
      transient('happy', 1800, t('bub.roundDone'), 3400);
      break;
    case 'big-done':
      transient('happy', 2200, t('bub.bigDone', { ops: ev.ops || '' }), 3800);
      confetti();
      break;
    case 'error':
      transient('error', 2600, ev.text || t('bub.error'), 3000);
      break;
    case 'waiting':
      clearTransient(); // 残留的 talking/thinking 短暂态不得盖过等授权
      setState('waiting');
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice); // 直接弹出选项/输入
      } else {
        showBubble(t('bub.waitYou', { project: ev.project || '', wait: waitPhrase(ev.reason) }), 6000);
      }
      break;
    case 'needsinput':
      // Claude 在末尾问「要不要继续」之类，等你回复 → 黄点 + 可在桌宠上继续/回复
      if (state !== 'waiting') { clearTransient(); setState('needsinput'); }
      if (ev.choice && ((ev.choice.options && ev.choice.options.length) || ev.choice.allowInput)) {
        enqueueChoice(ev.choice);
      } else {
        showBubble(t('bub.needReply', { project: ev.project || '' }), 6000);
      }
      break;
    case 'greet':
      transient('greet', 2000, t('bub.greet', { project: ev.project || '' }), 2600);
      break;
    case 'longcmd':
      if (state !== 'waiting') showBubble(t('bub.slowCmd'), 3000);
      break;
  }
});

function perfNow() {
  return Date.now();
}

// ---------- 统计 + 聚合状态 ----------
let lastStats = null; // 最近一次快照：transient 到期时用它立即重算聚合态
let privacyModeCache = false;
let sayToken = 0;     // say 接棒 happy 的排队令牌（新事件作废旧排队）
function compactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

const petInsights = window.WorkMeowPetInsights;
function capsuleElapsed(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return '';
  if (value < 60 * 1000) return `${Math.max(1, Math.floor(value / 1000))}秒`;
  if (value < 60 * 60 * 1000) return `${Math.max(1, Math.floor(value / 60000))}分`;
  return `${Math.max(1, Math.floor(value / 3600000))}小时`;
}

function localPurrDay(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function purrAlreadyAnnounced(day) {
  try { return window.localStorage && window.localStorage.getItem(PURR_DAY_STORAGE_KEY) === day; }
  catch { return false; }
}

function markPurrAnnounced(day) {
  try { if (window.localStorage) window.localStorage.setItem(PURR_DAY_STORAGE_KEY, day); }
  catch {}
}

function purrCanRun(stats) {
  if (!stats || !petInsights || typeof petInsights.hasActiveWork !== 'function') return false;
  if (askActive || actionPopOpen || radialOpen || peekOpen || quotaPopoverOpen) return false;
  // Do not cut across a real completion/error/reply animation.
  if (perfNow() < transientUntil) return false;
  return !petInsights.hasActiveWork(stats, { sleepMs: IDLE_SLEEP_MS });
}

function purrEnvironmentClear(stats) {
  if (!stats || !petInsights || typeof petInsights.hasActiveWork !== 'function') return false;
  if (askActive || actionPopOpen || radialOpen || peekOpen || quotaPopoverOpen) return false;
  return !petInsights.hasActiveWork(stats, { sleepMs: IDLE_SLEEP_MS });
}

function clearPurrPayday() {
  purrPaydayUntil = 0;
  purrPaydaySummary = null;
  clearTimeout(purrPaydayTimer);
  purrPaydayTimer = null;
}

function quotaRemainingPercent(w) {
  if (!w || typeof w !== 'object') return null;
  if (Number.isFinite(w.remainingPercent)) {
    return Math.max(0, Math.min(100, Number(w.remainingPercent)));
  }
  return Number.isFinite(w.usedPercent)
    ? Math.max(0, Math.min(100, 100 - Number(w.usedPercent)))
    : null;
}

function quotaLevel(remaining) {
  return remaining === null ? 'unknown' : remaining <= 5 ? 'red' : remaining <= 20 ? 'amber' : 'normal';
}

// ── 每个 Agent 一份额度徽标 ──────────────────────────────────────────────────
// 以前是「一个槽位」：接 WorkBuddy 画积分徽标，否则画 Codex 的 5h/7d（归属由
// 主进程 quotaSlot() 决定）。2026-09-15 改成**每个检测到的 Agent 一份**，和
// 设置页的开关、托盘的行一一对应 —— 于是「设置页写 Codex、托盘写 WorkBuddy」
// 这种自相矛盾不再可能出现。显示与否由 chipDisplay.quotaAgents[id] 逐个控制。
function activeQuotaAgents(s) {
  const display = s && s.chipDisplay ? s.chipDisplay : {};
  const map = display.quotaAgents && typeof display.quotaAgents === 'object' ? display.quotaAgents : {};
  const rows = Array.isArray(s && s.quotaAgents) ? s.quotaAgents : [];
  return rows.filter((row) => row && map[row.id] !== false);
}

// 积分形态：Agent 的余额只在服务端、本机拿不到，只能由用户手填每期总量、
// 再用本机已用反推剩余（见 backend/credit-cycle.js）。
// 底部展示栏里有没有积分型 Agent —— 决定 aria-label 讲不讲「剩余积分」。
function isCreditSlot(s) {
  const row = primaryQuotaAgent(s);
  return !!(row && row.quota && row.quota.kind === 'credit');
}

// 每个 Agent 一组徽标：Codex 画 5h/7d 百分比，积分型画剩余积分。
// 行数 = 设置页里打开开关的有效 Agent 数，和托盘的行一一对应。
function activeAgentBadges(s) {
  const quota = s && s.codexQuota ? s.codexQuota : {};
  const badges = [];
  for (const row of activeQuotaAgents(s)) {
    const kind = row.quota && row.quota.kind;
    if (kind === 'credit') {
      badges.push(createCreditBadge({ ...row.quota, label: row.label }));
      continue;
    }
    if (kind !== 'codex') continue;
    for (const [key, labelKey] of quotaWindowEntries(quota)) {
      const label = labelKey === 'quota.fiveHour' ? '5h' : '7d';
      const w = quota.windows && quota.windows[key];
      const remaining = quotaRemainingPercent(w);
      const badge = document.createElement('span');
      badge.className = 'quota-badge';
      badge.dataset.level = quotaLevel(remaining);
      badge.dataset.period = label;
      badge.textContent = remaining === null ? '--' : Math.round(remaining) + '%';
      badge.style.setProperty('--quota-remaining', `${remaining === null ? 0 : remaining}%`);
      badge.setAttribute('aria-label', `${label} 剩余 ${badge.textContent}`);
      badges.push(badge);
    }
  }
  return badges;
}

// 弹层一次只讲一个 Agent 的账，这里挑「最值得讲」的那个：先积分型（它的数字
// 是本机反推的、最需要核对），没有再退到 Codex。
function primaryQuotaAgent(s) {
  const rows = activeQuotaAgents(s);
  return rows.find((row) => row.quota && row.quota.kind === 'credit')
    || rows.find((row) => row.quota && row.quota.kind === 'codex')
    || null;
}

function creditRemainingPercent(slot) {
  const monthly = Number(slot && slot.monthly);
  const remaining = slot ? slot.remaining : null;
  // remaining 先做 null 判断再转数字：Number(null) === 0，直接把 null 喂进
  // Number() 会让「还没填额度」算成 0% —— 徽标被涂成红色，看起来像额度已耗尽。
  if (remaining === null || remaining === undefined || remaining === '') return null;
  const left = Number(remaining);
  if (!Number.isFinite(monthly) || monthly <= 0 || !Number.isFinite(left)) return null;
  return Math.max(0, Math.min(100, (left / monthly) * 100));
}

// 没填每期总量时显示 '--'，不是 0 —— 「没配」和「用完了」是两回事，
// 显示 0 会让人以为额度已经耗尽。同样是 Number(null) === 0 的坑。
function creditBadgeText(slot) {
  const raw = slot ? slot.remaining : null;
  if (raw === null || raw === undefined || raw === '') return '--';
  const remaining = Number(raw);
  return Number.isFinite(remaining) ? compactTokens(remaining) : '--';
}

function createCreditBadge(slot) {
  const percent = creditRemainingPercent(slot);
  const name = slot.label || '积分';
  const badge = document.createElement('span');
  badge.className = 'quota-badge';
  badge.dataset.level = quotaLevel(percent);
  // 徽标左侧的标签由 CSS 用 attr(data-period) 渲染。Codex 那边是「5h / 7d」这种
  // 两字符记号，直接当标签很自然；积分这边得说清楚是「剩余」而不是「已用」，所以
  // 换成词。data-kind 让 CSS 认出这是词标签 —— 固定 62px 宽 + overflow:hidden 会
  // 把「剩余积分 1.8K」裁掉，见 pet.css 里对应的那条规则。
  badge.dataset.kind = 'credit';
  badge.dataset.period = t('quota.creditBadgeLabel');
  badge.textContent = creditBadgeText(slot);
  badge.style.setProperty('--quota-remaining', `${percent === null ? 0 : percent}%`);
  badge.setAttribute('aria-label', percent === null
    ? t('quota.creditAriaUnset', { name })
    : t('quota.creditAria', { name, value: badge.textContent }));
  return badge;
}

function quotaDurationText(ms) {
  const minutes = Math.max(1, Math.ceil(Math.max(0, ms) / 60000));
  if (minutes < 60) return t('quota.durationMinutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes
      ? t('quota.durationHoursMinutes', { hours, minutes: restMinutes })
      : t('quota.durationHours', { count: hours });
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours
    ? t('quota.durationDaysHours', { days, hours: restHours })
    : t('quota.durationDays', { count: days });
}

function quotaDateText(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  if (!Number.isFinite(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function quotaResetText(w, now = Date.now()) {
  if (!w || !Number.isFinite(w.resetsAt)) return t('quota.resetUnknown');
  const resetAt = Number(w.resetsAt) * 1000;
  if (!Number.isFinite(resetAt)) return t('quota.resetUnknown');
  const remainingMs = resetAt - now;
  if (remainingMs <= 0) return t('quota.resetSoon');
  return `${t('quota.resetIn', { time: quotaDurationText(remainingMs) })} · ${quotaDateText(w.resetsAt)}`;
}

function quotaUpdatedText(updatedAt) {
  const date = new Date(Number(updatedAt));
  if (!Number.isFinite(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function quotaWindowEntries(quota) {
  const windows = quota && quota.windows && typeof quota.windows === 'object' ? quota.windows : {};
  const weekly = windows.weekly;
  const hasWeekly = quotaRemainingPercent(weekly) !== null;
  const fiveHour = windows.fiveHour;
  const hasFiveHour = quotaRemainingPercent(fiveHour) !== null;
  // Pro accounts expose a weekly window but no 5h window. Do not leave a
  // misleading empty badge/card beside the real 7d value in that case.
  return [
    ['fiveHour', 'quota.fiveHour'],
    ['weekly', 'quota.weekly'],
  ].filter(([key]) => key !== 'fiveHour' || hasFiveHour || !hasWeekly);
}

function quotaCostText(value) {
  if (value === null || value === undefined) return '--';
  const n = Number(value);
  return Number.isFinite(n) ? '$' + n.toFixed(3) : '--';
}

function quotaPlanText(quota) {
  const plan = quota && quota.account && typeof quota.account.planType === 'string'
    ? quota.account.planType.trim()
    : '';
  return plan ? ` · ${plan.slice(0, 1).toUpperCase()}${plan.slice(1)}` : '';
}

function renderQuotaEstimate(quota) {
  if (!quotaPopoverInsight) return;
  const estimate = quota && quota.estimate;
  quotaPopoverInsight.innerHTML = '';
  quotaPopoverInsight.hidden = !estimate;
  if (!estimate) return;
  const add = (parent, tag, className, text) => {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    parent.appendChild(el);
    return el;
  };
  const ready = Number.isFinite(estimate.estimatedTotalCost) && estimate.estimatedTotalCost > 0;
  const head = add(quotaPopoverInsight, 'div', 'quota-estimate-head', '');
  add(head, 'span', '', t('quota.estimateTitle'));
  add(head, 'span', 'quota-estimate-badge', t(ready
    ? (estimate.confidence === 'early' ? 'quota.estimateEarly' : 'quota.estimateDynamic') : 'quota.estimateCollecting'));
  if (ready) {
    const grid = add(quotaPopoverInsight, 'div', 'quota-estimate-grid', '');
    for (const [label, value] of [
      ['quota.estimateFull', estimate.estimatedTotalCost],
      ['quota.estimateRemaining', estimate.estimatedRemainingCost],
    ]) {
      const card = add(grid, 'div', 'quota-estimate-card', '');
      add(card, 'div', 'quota-estimate-label', t(label));
      add(card, 'div', 'quota-estimate-number', Number.isFinite(value) ? '≈ $' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '--');
      add(card, 'div', 'quota-estimate-unit', t('quota.estimateUnit'));
    }
    add(quotaPopoverInsight, 'div', 'quota-estimate-detail', t(estimate.basis === 'cycle' ? 'quota.estimateCycleEvidence' : 'quota.estimateEvidence', {
      percent: Number.isFinite(estimate.samplePercent) ? +estimate.samplePercent.toFixed(1) : '--',
      cost: quotaCostText(estimate.cost),
    }));
    if (Number.isFinite(estimate.rangeLow) && Number.isFinite(estimate.rangeHigh)) {
      add(quotaPopoverInsight, 'div', 'quota-estimate-detail', t('quota.estimateRange', {
        low: '$' + estimate.rangeLow.toFixed(2), high: '$' + estimate.rangeHigh.toFixed(2),
      }));
    } else if (estimate.confidence === 'early') {
      add(quotaPopoverInsight, 'div', 'quota-estimate-detail', t('quota.estimateEarlyHint'));
    }
  } else {
    const pending = add(quotaPopoverInsight, 'div', 'quota-estimate-pending', t('quota.estimateObserved', {
      cost: quotaCostText(estimate.cost),
      used: Number.isFinite(estimate.usedPercent) ? +estimate.usedPercent.toFixed(1) : '--',
    }));
    add(pending, 'div', 'quota-estimate-detail', t(estimate.reason === 'no-percent'
      ? 'quota.estimateAwaitPercent' : 'quota.estimateAwaitCost'));
  }
  add(quotaPopoverInsight, 'div', 'quota-estimate-note', t('quota.estimateNote'));
}

// 弹层里的一行。bar 只在需要显示百分比的场合给，没有就不塞第三个格子。
function createQuotaPopRow(label, value, percent = null) {
  const row = document.createElement('div');
  row.className = 'quota-pop-row';
  row.dataset.level = quotaLevel(percent);
  const period = document.createElement('div');
  period.className = 'quota-pop-period';
  period.textContent = label;
  const main = document.createElement('div');
  main.className = 'quota-pop-main';
  const valueEl = document.createElement('div');
  valueEl.className = 'quota-pop-value';
  valueEl.textContent = value;
  main.appendChild(valueEl);
  row.appendChild(period);
  row.appendChild(main);
  if (percent !== null) {
    const bar = document.createElement('div');
    bar.className = 'quota-pop-bar';
    const fill = document.createElement('div');
    fill.className = 'quota-pop-bar-fill';
    fill.style.setProperty('--quota-remaining', `${percent}%`);
    bar.appendChild(fill);
    row.appendChild(bar);
  }
  return row;
}

// 积分形态的弹层。原先只有 Codex 一套，切到积分后若还渲染 5h/7d 就是错的。
function renderCreditPopover(slot) {
  const name = slot.label || '积分';
  quotaPopoverTitle.textContent = t('quota.creditTitle', { name });
  quotaPopoverStatus.textContent = Number.isFinite(Number(slot.monthly)) && Number(slot.monthly) > 0
    ? t('quota.creditReset', { day: slot.resetDay, start: slot.cycleStart || '--' })
    : t('quota.creditUnset');
  quotaPopoverRows.replaceChildren();
  const percent = creditRemainingPercent(slot);
  const rows = [
    [t('quota.creditToday'), compactTokens(Number(slot.today) || 0), null],
    [t('quota.creditUsed'), Number.isFinite(Number(slot.cycleUsed)) ? compactTokens(slot.cycleUsed) : '--', null],
    [t('quota.creditRemaining'), creditBadgeText(slot), percent],
  ];
  if (Number.isFinite(Number(slot.monthly)) && Number(slot.monthly) > 0) {
    rows.push([t('quota.creditMonthly'), compactTokens(slot.monthly), null]);
  }
  for (const [label, value, host] of rows) quotaPopoverRows.appendChild(createQuotaPopRow(label, value, host));
  quotaPopoverUpdated.textContent = t('quota.creditSource', { name });
  quotaPopoverHint.textContent = t('quota.dismissHint');
}

function renderQuotaPopover(s) {
  if (!quotaPopoverRows || !quotaPopoverStatus || !s) return;
  if (isCreditSlot(s)) {
    renderCreditPopover(primaryQuotaAgent(s));
    return;
  }
  const quota = s.codexQuota || {};
  quotaPopoverTitle.textContent = t('quota.title');
  quotaPopoverStatus.textContent = quota.status === 'ready'
    ? t('quota.synced') + quotaPlanText(quota)
    : (quota.statusText || t('quota.unavailable'));
  quotaPopoverRows.innerHTML = '';

  const windows = quotaWindowEntries(quota);
  for (const [key, labelKey] of windows) {
    const w = quota.windows && quota.windows[key];
    const remaining = quotaRemainingPercent(w);
    const row = document.createElement('div');
    row.className = 'quota-pop-row';
    row.dataset.level = quotaLevel(remaining);

    const period = document.createElement('div');
    period.className = 'quota-pop-period';
    period.textContent = t(labelKey);

    const main = document.createElement('div');
    main.className = 'quota-pop-main';
    const value = document.createElement('div');
    value.className = 'quota-pop-value';
    value.textContent = t('quota.remaining', {
      percent: remaining === null ? '--' : Math.round(remaining) + '%',
    });
    const reset = document.createElement('div');
    reset.className = 'quota-pop-reset';
    reset.textContent = quotaResetText(w);
    main.appendChild(value);
    main.appendChild(reset);

    const bar = document.createElement('div');
    bar.className = 'quota-pop-bar';
    const fill = document.createElement('div');
    fill.className = 'quota-pop-bar-fill';
    fill.style.setProperty('--quota-remaining', `${remaining === null ? 0 : remaining}%`);
    bar.appendChild(fill);

    row.appendChild(period);
    row.appendChild(main);
    row.appendChild(bar);
    quotaPopoverRows.appendChild(row);
  }

  renderQuotaEstimate(quota);
  quotaPopoverUpdated.textContent = Number.isFinite(quota.updatedAt)
    ? t('quota.updatedAt', { time: quotaUpdatedText(quota.updatedAt) })
    : (quota.statusText || t('quota.unavailable'));
  quotaPopoverHint.textContent = t('quota.dismissHint');
}

function clearQuotaPopoverCloseTimer() {
  if (quotaPopoverCloseTimer) clearTimeout(quotaPopoverCloseTimer);
  quotaPopoverCloseTimer = null;
}

function keepQuotaPopoverOpen() {
  quotaPopoverPointerInside = true;
  clearQuotaPopoverCloseTimer();
}

function scheduleQuotaPopoverClose() {
  clearQuotaPopoverCloseTimer();
  if (!quotaPopoverOpen || quotaPopoverPointerInside) return;
  quotaPopoverCloseTimer = setTimeout(() => {
    const focused = document.activeElement;
    const focusInside = focused === quotaEl || (quotaPopover && quotaPopover.contains(focused));
    if (!quotaPopoverPointerInside && !focusInside) closeQuotaPopover();
  }, QUOTA_POPOVER_LEAVE_MS);
}

function startQuotaPopoverClock() {
  if (quotaPopoverRefreshTimer) clearInterval(quotaPopoverRefreshTimer);
  quotaPopoverRefreshTimer = setInterval(() => {
    if (quotaPopoverOpen && lastStats) renderQuotaPopover(lastStats);
  }, QUOTA_POPOVER_REFRESH_MS);
  if (quotaPopoverRefreshTimer && typeof quotaPopoverRefreshTimer.unref === 'function') quotaPopoverRefreshTimer.unref();
}

function closeQuotaPopover() {
  clearQuotaPopoverCloseTimer();
  if (quotaPopoverRefreshTimer) clearInterval(quotaPopoverRefreshTimer);
  quotaPopoverRefreshTimer = null;
  quotaPopoverPointerInside = false;
  if (quotaPopover) quotaPopover.classList.add('hidden');
  if (quotaEl) quotaEl.setAttribute('aria-expanded', 'false');
  // 定时器/DOM 收尾对没开的弹窗也是幂等的，所以早退守卫放在这里：只挡下面那两笔
  // 有副作用的调用（理由同 closeActionPop）。
  if (!quotaPopoverOpen) return;
  quotaPopoverOpen = false;
  window.pet.blurPet();
  if (!askActive && !actionPopOpen && !peekOpen) resetPetSize();
}

function openQuotaPopover() {
  if (!lastStats || !quotaEl || quotaEl.hidden || askActive) return false;
  if (quotaPopoverOpen) return true;
  if (radialOpen) closeRadial();
  if (actionPopOpen) closeActionPop();
  if (peekOpen) closePeek();
  clearTimeout(bubbleTimer);
  bubbleTimer = null;
  bubble.classList.add('hidden');
  renderQuotaPopover(lastStats);
  quotaPopover.classList.remove('hidden');
  quotaPopoverOpen = true;
  quotaPopoverPointerInside = true;
  quotaEl.setAttribute('aria-expanded', 'true');
  startQuotaPopoverClock();
  fitPopup(quotaPopover);
  positionQuotaPopoverTip();
  return true;
}

function toggleQuotaPopover() {
  if (quotaPopoverOpen) closeQuotaPopover();
  else openQuotaPopover();
}

function renderContextCapsule(s) {
  if (!chip || !chipContext || !s || !petInsights || typeof petInsights.context !== 'function') return;
  // quotaAgents 缺省是空表，语义为「全部放行」；只有当某个 agent 被显式关掉才隐藏。
  const display = s.chipDisplay
    || { showCat: true, showStatus: true, showTokens: false, showCost: true, quotaAgents: {} };
  const showCat = display.showCat !== false;
  catVisible = showCat;
  stage.classList.toggle('cat-hidden', !showCat);
  cat.setAttribute('aria-hidden', String(!showCat));
  const showStatus = display.showStatus !== false;
  // 额度不再是「一个总开关」——按 Agent 逐个开关。可见性必须按**徽标数**判断，
  // 不能按「开着的 Agent 数」：像 Claude 这种 quota 为 null 的 Agent 会被计入行数
  // 却产不出任何徽标（见 activeAgentBadges 的 kind 分支），于是整段被显示成一个
  // 只有 padding 的空格子 —— 用户看到的就是「开关打开了但什么也没有」。
  const quotaBadges = activeAgentBadges(s);
  const showQuota = quotaBadges.length > 0;
  const showTokens = display.showTokens === true;
  const showCost = display.showCost === true;
  chipContext.hidden = !showStatus;
  chipTokens.hidden = !showTokens;
  chipCost.hidden = !showCost;
  quotaEl.hidden = !showQuota;
  if (!showQuota && quotaPopoverOpen) closeQuotaPopover();
  // Separators belong to the item that follows them. This keeps the capsule
  // clean when the user hides the state and/or quota while retaining tokens
  // or cost on their own.
  document.getElementById('chip-tokens-sep').hidden = !showTokens || !(showStatus || showQuota);
  document.getElementById('chip-cost-sep').hidden = !showCost || !(showStatus || showQuota || showTokens);
  quotaEl.innerHTML = '';
  for (const badge of quotaBadges) quotaEl.appendChild(badge);
  quotaEl.setAttribute('aria-label', isCreditSlot(s) ? t('quota.creditOpen') : t('quota.open'));
  chip.removeAttribute('title');
  if (quotaPopoverOpen) {
    renderQuotaPopover(s);
    fitPopup(quotaPopover);
    positionQuotaPopoverTip();
  }
  const now = perfNow();
  const purrVisible = purrPaydaySummary && purrPaydayUntil > now && purrEnvironmentClear(s);
  if (purrVisible) {
    const purr = purrPaydaySummary;
    chip.dataset.context = 'purr';
    chipContext.textContent = t('purr.title');
    chipTokens.textContent = `${compactTokens(purr.tokens)} tokens`;
    chipCost.textContent = '$' + (Number(purr.cost) || 0).toFixed(3);
    chip.setAttribute('aria-label', purr.copy || t('purr.ariaLabel'));
    fitRestingFrame();
    return;
  }
  if (purrPaydayUntil && !purrEnvironmentClear(s)) clearPurrPayday();

  const info = petInsights.context(s, { sleepMs: IDLE_SLEEP_MS });
  const usage = typeof petInsights.usage === 'function' ? petInsights.usage(s) : {
    rounds: Number(s.today && (s.today.messages || s.today.msgs)) || 0,
    tokens: Number(s.today && s.today.tokens) || 0,
    cost: Number(s.today && s.today.cost) || 0,
  };
  const detail = [showTokens ? `${compactTokens(usage.tokens)} tokens` : '',
    showCost ? `API 等价估算 $${usage.cost.toFixed(3)}` : ''].filter(Boolean).join(' · ');
  let label = '';
  let title = '';
  // A done badge is only the primary capsule state when no higher-priority
  // attention/active state is present. It can coexist with another session's
  // work, so do not let the badge leak into the data-state styling there.
  const showDone = info.recentDone && (info.kind === 'idle' || info.kind === 'sleeping');

  if (info.kind === 'waiting') {
    const total = info.count + (info.needsinput || 0);
    label = `✋ ${total} 件等你`;
    title = `等你处理：${info.count} 项授权${info.needsinput ? ` · ${info.needsinput} 项回复` : ''}`;
  } else if (info.kind === 'needsinput') {
    label = `💬 ${info.count} 件待回复`;
    title = `等你回复：${info.count} 项`;
  } else if (info.kind === 'error') {
    label = `😵 ${info.count} 项异常`;
    title = `任务异常：${info.count} 项`;
  } else if (info.kind === 'active') {
    const icon = SESS_META_ICON[info.state] || '⚙️';
    const stateText = backgroundStatus(info.primary) || t(SESS_META_KEY[info.state] || 'state.working');
    const elapsed = info.primary && info.primary.turnStartedAt
      ? capsuleElapsed(now - Number(info.primary.turnStartedAt))
      : '';
    // 多任务时保留状态词，只把计数缀在后面（「🧹清理上下文 ×2」）。
    // 旧写法是 `${icon}${activeCount} 个任务`，状态词被整段吃掉 —— 于是「压缩
    // 上下文」在两个会话同时忙时看不见，单会话才看得见，正是用户说的
    // 「有时候又是对的」（2026-09-16）。计数比耗时更值钱，多任务时让位。
    const multi = info.activeCount > 1;
    const tail = multi
      ? t('capsule.multiSuffix', { count: info.activeCount })
      : (elapsed ? ` · ${elapsed}` : '');
    label = `${icon}${stateText}${tail}`;
    title = multi ? t('capsule.multiTitle', { state: stateText, count: info.activeCount }) : stateText;
  } else if (showDone) {
    label = '✅ 刚刚完成';
    title = '最近一轮任务已完成';
  } else if (info.kind === 'sleeping') {
    label = '💤 休息中';
    title = '没有活动任务，喵正在休息';
  } else {
    label = '🌿 待命';
    title = '当前没有活动任务';
  }

  if (s.privacyMode) {
    label = `🔒 ${label}`;
    title = `${t('privacy.enabled')} · ${title}`;
  }

  chip.dataset.context = showDone
    ? 'done'
    : (info.kind === 'active' ? `active-${info.state}` : info.kind);
  chipContext.textContent = label;
  chipTokens.textContent = compactTokens(usage.tokens) + ' tokens';
  chipCost.textContent = '$' + usage.cost.toFixed(3);
  chip.setAttribute('aria-label', `${title}${detail ? ` · 今日 ${detail}` : ''}`);
  fitRestingFrame();
}

function triggerPurrPayday() {
  if (!purrCanRun(lastStats)) return false;
  const usage = petInsights.usage(lastStats);
  const day = localPurrDay();
  const firstToday = !purrAlreadyAnnounced(day);
  if (firstToday) markPurrAnnounced(day);
  const copy = firstToday
    ? (usage.rounds || usage.tokens
      ? t('purr.first', {
        rounds: usage.rounds,
        tokens: compactTokens(usage.tokens),
        cacheRate: usage.cacheRate == null ? '—' : usage.cacheRate.toFixed(0),
      })
      : t('purr.empty'))
    : t('purr.repeat');
  purrPaydaySummary = { ...usage, copy };
  purrPaydayUntil = perfNow() + PURR_DISPLAY_MS;
  clearTimeout(purrPaydayTimer);
  purrPaydayTimer = setTimeout(() => {
    clearPurrPayday();
    if (lastStats) renderContextCapsule(lastStats);
  }, PURR_DISPLAY_MS + 50);
  if (purrPaydayTimer && typeof purrPaydayTimer.unref === 'function') purrPaydayTimer.unref();
  renderContextCapsule(lastStats);
  transient('loved', 2500, copy, 5200);
  if (firstToday) confetti();
  return true;
}

function applyStats(s) {
  if (!s) return;
  privacyModeCache = s.privacyMode === true;
  const enteringPrivacy = s.privacyMode === true && !(lastStats && lastStats.privacyMode === true);
  if (enteringPrivacy) {
    clearPurrPayday();
    clearTransient();
    hideBubble();
    if (askActive) hideAsk();
    if (actionPopOpen) closeActionPop();
  }
  lastStats = s;
  renderContextCapsule(s);
  renderSessions(s.sessions || []);
  // The status dots and the capsule are siblings in the same intrinsic-width
  // stack. Measure after both have been refreshed so a long amount or a new
  // parallel task is included in the next BrowserWindow size.
  fitRestingFrame();
  updateNotepad(s); // 记事本：行动中心

  // 选项面板：按快照重建队列（多任务都在、标明项目；防漏事件/启动时已在等待）
  refreshAsk(s);
  // 速览不冻结状态机：快照到来时就地更新文字，不关闭/重开。
  if (peekOpen) renderPeek(s);

  // 你正在看面板/打字 → 不再改打工喵状态(别动来动去打断你)，安静等你答完
  if (isInteracting()) return;

  // 聚合梯子，对齐 STATES.md 的优先级表：
  //   waiting > 短暂态 > error(8) > needsinput/notification(7) > sweeping(6)
  //   > juggling(4) > working(3) > thinking(2) > idle(1) > sleeping(0)
  // 之前 working 排在 needsinput 前面，多会话时「等你回复」被干活态彻底盖住。
  if (s.waitingCount > 0) {
    setState('waiting');
  } else if (perfNow() < transientUntil) {
    setState(transientState);
  } else if (s.errorCount > 0) {
    setState('error'); // 有会话卡在 API 错误 → 瘫倒，直到该会话恢复或 oneshot 衰减
  } else if (s.needsinputCount > 0) {
    setState('needsinput');
  } else if (s.sweepingCount > 0) {
    setState('sweeping');
  } else if (s.jugglingCount > 0) {
    setState('juggling');
  } else if (s.workingCount > 0) {
    setState('working');
  } else if (s.thinkingCount > 0) {
    setState('thinking');
  } else if (s.loafingCount > 0) {
    setState('loafing'); // 工具间隙：上一步干完等下一步 → 摸鱼
  } else if (s.idleMs == null || s.idleMs > IDLE_SLEEP_MS) {
    // idleMs=null 表示已无任何活跃会话——什么都没发生就该睡觉；
    // 之前 null 落到 idle，桌宠永不入睡，睡着后会话被回收还会凭空惊醒。
    setState('sleeping');
  } else if (s.doneCount > 0) {
    // 完成常驻：有会话刚完成（badge=done）且还没到入睡阈值 → 保持「完成庆祝」
    // 表情，直到下一条指令清除完成标志、或 6 分钟入睡。之前「完成」是 1.8s
    // 短暂态，闪一下就被 talking/idle 盖掉，常用状态反而几乎看不到。
    setState('done');
  } else {
    setState('idle');
  }
}
window.pet.onXiabanSchedule((schedule) => applyXiabanSchedule(schedule));
if (window.pet.onPetAssets) window.pet.onPetAssets((catalog) => applyPetAssetCatalog(catalog));
window.pet.onStats(applyStats);

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  // 头顶状态点只展示可见会话，并按状态优先级排列。
  const list = (sessions || []).filter(isBaseVisibleSession).sort((a, b) => {
    const pa = SESS_SORT[a.state] != null ? SESS_SORT[a.state] : 3;
    const pb = SESS_SORT[b.state] != null ? SESS_SORT[b.state] : 3;
    return pa !== pb ? pa - pb : (a.idleMs || 0) - (b.idleMs || 0);
  });
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess-dot ' + sessionDotClass(s);
    const label = s.state === 'waiting' ? waitPhrase(s.reason) : (sessMeta(s.state) || s.state);
    d.title = `${s.project} · ${label}`;
    d.setAttribute('aria-hidden', 'true');
    sessionsEl.appendChild(d);
  }
  if (propEl && propEl.classList.contains('on')) positionProp();
}

// Static markup carries Chinese text inline; data-i18n keeps the shared wording
// consistent across the pet and detail panel.
function applyStaticI18n() {
  document.documentElement.lang = 'zh-CN';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh);
    delete el.dataset.ph; // drop the cached original so the warn/restore pair re-seeds
  }
}

// ====================================================================
// 拖动 + 右键菜单（拖动=移动窗口）
// ====================================================================
let g = null; // 当前手势（同步建立，保证快速点击也能识别）
let dragGestureSeq = 0;
function pointerScreenX(e) {
  const value = Number(e && e.screenX);
  if (Number.isFinite(value)) return value;
  return (Number(window.screenX) || 0) + (Number(e && e.clientX) || 0);
}
function pointerScreenY(e) {
  const value = Number(e && e.screenY);
  if (Number.isFinite(value)) return value;
  return (Number(window.screenY) || 0) + (Number(e && e.clientY) || 0);
}
function currentWindowScreenPosition() {
  const x = Number(window.screenX);
  const y = Number(window.screenY);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}
function pointerClientX(e) {
  const value = Number(e && e.clientX);
  if (Number.isFinite(value)) return value;
  return pointerScreenX(e) - (Number(window.screenX) || 0);
}
function pointerClientY(e) {
  const value = Number(e && e.clientY);
  if (Number.isFinite(value)) return value;
  return pointerScreenY(e) - (Number(window.screenY) || 0);
}

function cancelQueuedDragMove(gesture) {
  if (!gesture) return;
  if (gesture.moveFrame !== null) cancelAnimationFrame(gesture.moveFrame);
  gesture.moveFrame = null;
  gesture.pendingMove = null;
}

function flushQueuedDragMove(gesture) {
  if (!gesture) return;
  if (gesture.moveFrame !== null) cancelAnimationFrame(gesture.moveFrame);
  gesture.moveFrame = null;
  const pending = gesture.pendingMove;
  gesture.pendingMove = null;
  if (!pending || g !== gesture || !gesture.moved) return;
  movePetDuringDrag(gesture, pending, pending.targetX, pending.targetY);
}

function queueDragMove(gesture, e, targetX, targetY) {
  // BrowserWindow movement can produce a burst of pointermove events itself.
  // Keep only the newest physical-cursor sample per paint frame; together with
  // main's same-position guard this makes the feedback chain terminate.
  gesture.pendingMove = {
    screenX: pointerScreenX(e),
    screenY: pointerScreenY(e),
    targetX,
    targetY,
  };
  if (gesture.moveFrame !== null) return;
  gesture.moveFrame = requestAnimationFrame(() => flushQueuedDragMove(gesture));
}

function finishDrag(el, e, cancelled) {
  if (!g || g.el !== el) return;
  if (e && Number.isFinite(e.pointerId) && e.pointerId !== g.pid) return;
  const gesture = g;
  const wasPurr = gesture.purrTriggered;
  // 拖动的「是否成立」用松手时的**最终**位移复核，而不是过程中那个不可回退的
  // moved 标志：手抖/触控板漂移几像素不该把一次点击吞掉。cancelled 时一律按
  // 拖动收尾（保持原有语义：打断就是打断）。判为点击时，过程中已发生的窗口
  // 漂移 ≤ CLICK_SLOP 像素，随后由 settleEdgeLayout 归位。
  const endSlop = e
    ? Math.abs(pointerScreenX(e) - gesture.sx) + Math.abs(pointerScreenY(e) - gesture.sy)
    : Infinity;
  const dragged = gesture.moved && (cancelled || endSlop > CLICK_SLOP);
  clearTimeout(gesture.holdTimer);
  if (dragged && !cancelled) flushQueuedDragMove(gesture);
  else cancelQueuedDragMove(gesture);
  el.classList.remove('dragging');
  g = null;
  try { el.releasePointerCapture(gesture.pid); } catch {}
  try { window.pet.endWinDrag(gesture.id); } catch {}
  if (dragged) {
    if (peekOpen) closePeek();
    // END_WIN_DRAG is sent after the final position, so the queued size/anchor
    // settlement cannot revive an already released movement gesture.
    setTimeout(settleEdgeLayout, 0);
  } else {
    // 点击救回：手势曾越线但松手时已回到起点附近，窗口可能被拖偏了几像素，
    // 同样要 settle 回静息锚点。
    if (gesture.moved) setTimeout(settleEdgeLayout, 0);
    // 左键短按 = 按当前优先级打开待处理卡/行动中心/工作速览；
    // 拖动仍由上面的 4px 阈值独立裁决，不会误触点击。
    if (!wasPurr && !cancelled) handleCatClick();
  }
}

function attachDrag(el, options = {}) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (options.hiddenOnly && catVisible) return;
    // In compact mode the capsule remains a drag handle, but its quota group
    // is a separate deliberate click target and must not start a drag gesture.
    if (el === chip && e.target && e.target.closest && e.target.closest('#chip-quota')) return;
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('dragging');
    const gesture = {
      el,
      pid: e.pointerId,
      sx: pointerScreenX(e),
      sy: pointerScreenY(e),
      moved: false,
      purrTriggered: false,
      holdTimer: null,
      id: `${Date.now().toString(36)}-${++dragGestureSeq}`,
      moveSeq: 0,
      moveFrame: null,
      pendingMove: null,
      // Main combines this stable in-window grab point with the authoritative
      // OS cursor. Window-generated pointer events cannot accumulate movement.
      grabX: pointerClientX(e),
      grabY: pointerClientY(e),
      // Prefer the synchronous BrowserWindow coordinates. The IPC result is
      // only a fallback and is ignored once this gesture has a window origin.
      win: currentWindowScreenPosition(),
    };
    g = gesture;
    gesture.holdTimer = setTimeout(() => {
      if (g !== gesture || gesture.moved) return;
      gesture.purrTriggered = triggerPurrPayday();
    }, PURR_HOLD_MS);
    window.pet.getWinPos().then(([wx, wy]) => {
      if (g !== gesture || gesture.win) return;
      if (Number.isFinite(wx) && Number.isFinite(wy)) gesture.win = [wx, wy];
    }).catch(() => {});
  });
  el.addEventListener('pointermove', (e) => {
    if (!g) return;
    if (Number.isFinite(e.pointerId) && e.pointerId !== g.pid) return;
    const dx = pointerScreenX(e) - g.sx;
    const dy = pointerScreenY(e) - g.sy;
    if (!g.moved && Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
    if (g.moved && g.holdTimer) {
      clearTimeout(g.holdTimer);
      g.holdTimer = null;
    }
    if (g.moved && !g.win) g.win = currentWindowScreenPosition();
    if (g.moved && g.win) {
      if (radialOpen) closeRadial();
      queueDragMove(g, e, g.win[0] + dx, g.win[1] + dy);
    }
  });
  el.addEventListener('pointerup', (e) => finishDrag(el, e, false));
  el.addEventListener('pointercancel', (e) => finishDrag(el, e, true));
  el.addEventListener('lostpointercapture', (e) => finishDrag(el, e, true));
  // 右键 = 泡泡菜单
  el.addEventListener('contextmenu', (e) => {
    if (options.hiddenOnly && catVisible) return;
    e.preventDefault();
    toggleRadial();
  });
}
stateEls.forEach(attachDrag);
// When the cat is hidden the capsule becomes the visible drag handle. It uses
// the exact same gesture, edge anchoring, click and context-menu behaviour.
attachDrag(chip, { hiddenOnly: true });
cat.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    handleCatClick();
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    toggleRadial();
  }
});

// 卡片按钮：Submit/Next、Back、Go to Terminal、Other 输入
askSubmit.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicNextOrSubmit(c); });
askBack.addEventListener('click', () => { const c = askQueue[askIdx]; if (c && c.kind === 'ask') elicBack(c); });
askTerm.addEventListener('click', () => { const c = askQueue[askIdx]; if (c) gotoSession(c); });
askText.addEventListener('input', () => updateSubmitEnabled());
// 自定义输入里按回车直接发送（仅 elicitation）；空内容不发、提示别忘了填
askText.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const c = askQueue[askIdx];
  if (!c || !elic) return;
  if (!(askText.value || '').trim()) { warnEmptyInput(); return; }
  if (askSubmit.classList.contains('disabled')) { warnEmptyInput(); return; }
  elicNextOrSubmit(c);
});
// 鼠标在面板上 = 交互中（配合 isInteracting 冻结轮询）
askEl.addEventListener('pointerenter', () => { askHover = true; });
askEl.addEventListener('pointerleave', () => { askHover = false; });

// 记事本：点击开/关 行动中心弹层
notepad.addEventListener('click', (e) => { e.stopPropagation(); actionPopOpen ? closeActionPop() : openActionPop(); });
notepad.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault(); e.stopPropagation();
  actionPopOpen ? closeActionPop() : openActionPop();
});
notepad.addEventListener('contextmenu', (e) => e.stopPropagation());
document.getElementById('ac-close').addEventListener('click', (e) => { e.stopPropagation(); closeActionPop(); });

actionPop.querySelectorAll('.ac-ops button').forEach((b) => {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const op = b.dataset.op;
    if (op === 'panel') window.pet.openPanel(AGENT);
    closeActionPop();
  });
});

peekClose.addEventListener('click', (e) => { e.stopPropagation(); closePeek(); });
peekFocus.addEventListener('click', (e) => {
  e.stopPropagation();
  const sessionId = peekPrimarySessionId;
  closePeek();
  requestSessionFocus(sessionId);
});
peekPanel.addEventListener('click', (e) => {
  e.stopPropagation();
  closePeek();
  window.pet.openPanel(AGENT);
});
peekEl.addEventListener('pointerenter', clearPeekTimer);
peekEl.addEventListener('pointerleave', armPeekTimer);
peekEl.addEventListener('contextmenu', (e) => e.stopPropagation());
quotaEl.addEventListener('click', (e) => { e.stopPropagation(); toggleQuotaPopover(); });
quotaEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  e.stopPropagation();
  toggleQuotaPopover();
});
quotaEl.addEventListener('pointerenter', keepQuotaPopoverOpen);
quotaEl.addEventListener('pointerleave', () => {
  quotaPopoverPointerInside = false;
  scheduleQuotaPopoverClose();
});
quotaEl.addEventListener('focus', keepQuotaPopoverOpen);
quotaPopover.addEventListener('pointerenter', keepQuotaPopoverOpen);
quotaPopover.addEventListener('pointerleave', () => {
  quotaPopoverPointerInside = false;
  scheduleQuotaPopoverClose();
});
quotaPopover.addEventListener('focusin', keepQuotaPopoverOpen);
quotaPopover.addEventListener('focusout', scheduleQuotaPopoverClose);
quotaPopoverClose.addEventListener('click', (e) => { e.stopPropagation(); closeQuotaPopover(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && quotaPopoverOpen) {
    e.preventDefault();
    closeQuotaPopover();
    return;
  }
  if (e.key === 'Escape' && peekOpen) {
    e.preventDefault();
    closePeek();
  }
});

// ---------- 泡泡菜单 ----------
let radialOpenSeq = 0;
let lastRadialMetrics = null;

function privacyModeEnabled() {
  return privacyModeCache;
}

async function readPrivacyMode() {
  const result = await window.pet.getPrivacyMode();
  if (result && result.ok && typeof result.enabled === 'boolean') privacyModeCache = result.enabled;
  return privacyModeCache;
}

async function togglePrivacyMode() {
  try {
    const current = await readPrivacyMode();
    const result = await window.pet.setPrivacyMode(!current);
    if (result && result.ok && typeof result.enabled === 'boolean') privacyModeCache = result.enabled;
  } catch {}
}

// labelKey (not label): buildRadial resolves Chinese labels at render time.
const MENU = [
  { ic: 'chart',  labelKey: 'menu.panel', act: () => window.pet.openPanel(AGENT) },
  // 收起只隐藏桌宠（托盘可重新显示）；应用退出保留在托盘中。
  { ic: 'minus',  labelKey: 'menu.collapse', act: () => window.pet.closePet() },
  { labelKey: 'menu.privacy', status: () => privacyModeEnabled() ? 'ON' : 'OFF', act: togglePrivacyMode },
];
// The compact toolbar reads naturally from state/privacy to detail to hide.
// Keep the cat-facing radial menu's original MENU order unchanged.
const COMPACT_MENU = [MENU[2], MENU[0], MENU[1]];

function usableRadialMetrics(metrics) {
  if (!metrics || !metrics.window || !metrics.workArea) return null;
  const wr = metrics.window;
  const wa = metrics.workArea;
  if (![wr.x, wr.y, wr.width, wr.height, wa.x, wa.y, wa.width, wa.height].every(Number.isFinite)) return null;
  if (wr.width <= 0 || wr.height <= 0 || wa.width <= 0 || wa.height <= 0) return null;
  return metrics;
}

function radialFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function settledRadialMetrics() {
  if (!window.pet || typeof window.pet.getWindowMetrics !== 'function') return null;
  let metrics = null;
  try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()); } catch { return null; }
  // setPetSize/resetPetSize 在主进程同步落 bounds，但 renderer 的 resize 与
  // flex 重排会晚一拍。等到 DOM viewport 也追上主进程尺寸后再取 pet rect。
  for (let i = 0; metrics && i < 6; i++) {
    const wr = metrics.window;
    const settled = Math.abs((window.innerWidth || 0) - wr.width) <= 1
      && Math.abs((window.innerHeight || 0) - wr.height) <= 1;
    if (settled) break;
    await radialFrame();
    try { metrics = usableRadialMetrics(await window.pet.getWindowMetrics()) || metrics; } catch {}
  }
  await radialFrame();
  return metrics;
}

function makeRadialItem(it, i, compact = false) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'radial-item';
  b.style.transitionDelay = i * 0.03 + 's';
  const status = typeof it.status === 'function' ? it.status() : '';
  if (status) {
    const enabled = status === 'ON';
    b.classList.add('radial-toggle');
    b.dataset.enabled = String(enabled);
    b.setAttribute('aria-pressed', String(enabled));
    b.setAttribute('aria-label', `${t(it.labelKey)} ${status}`);
    b.innerHTML = compact
      ? `<span class="ri-lb">${esc(t(it.labelKey))}</span><span class="ri-state">${esc(status)}</span>`
      : `<span class="ri-state">${esc(status)}</span><span class="ri-lb">${esc(t(it.labelKey))}</span>`;
  } else {
    const icHtml = (window.WorkMeowIcons && window.WorkMeowIcons.icon(it.ic)) || '';
    b.innerHTML = `<span class="ri-ic oi">${icHtml}</span><span class="ri-lb">${esc(t(it.labelKey))}</span>`;
  }
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    closeRadial();
    it.act();
  });
  return b;
}

function positionCompactRadial() {
  if (!radial || !chip || catVisible) return;
  const bar = radial.children && [...radial.children].find((child) =>
    child.classList && child.classList.contains('radial-compact'));
  if (!bar) return;
  const sr = stage.getBoundingClientRect();
  const chipRect = chip.getBoundingClientRect();
  const barRect = bar.getBoundingClientRect();
  const viewportW = Math.max(1, sr.width || window.innerWidth || 320);
  const barWidth = Math.max(0, Number(barRect.width) || 0);
  const halfBar = barWidth / 2;
  const desiredCenter = chipRect.left - sr.left + chipRect.width / 2;
  const minCenter = 8 + halfBar;
  const maxCenter = viewportW - 8 - halfBar;
  const center = minCenter <= maxCenter
    ? Math.max(minCenter, Math.min(maxCenter, desiredCenter))
    : viewportW / 2;
  const chipTop = chipRect.top - sr.top;
  const chipBottom = chipTop + chipRect.height;
  bar.style.left = Math.round(center) + 'px';
  bar.style.top = Math.round(edgeLayout.vertical === 'below' ? chipBottom + 8 : chipTop - 8) + 'px';
  bar.style.transform = edgeLayout.vertical === 'below'
    ? 'translateX(-50%)'
    : 'translate(-50%, -100%)';
}

function buildCompactRadial() {
  radial.dataset.layout = 'compact';
  radial.dataset.direction = edgeLayout.vertical === 'below' ? 'below' : 'above';
  const bar = document.createElement('div');
  bar.className = 'radial-compact';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '桌宠操作');
  COMPACT_MENU.forEach((it, i) => bar.appendChild(makeRadialItem(it, i, true)));
  radial.appendChild(bar);
  // Set a useful first position before the browser has measured the toolbar;
  // the open step and the next paint both refine it against the chip bounds.
  const sr = stage.getBoundingClientRect();
  const r = chip.getBoundingClientRect();
  bar.style.left = Math.round(r.left - sr.left + r.width / 2) + 'px';
  bar.style.top = Math.round(edgeLayout.vertical === 'below'
    ? r.top - sr.top + r.height + 8
    : r.top - sr.top - 8) + 'px';
  bar.style.transform = edgeLayout.vertical === 'below'
    ? 'translateX(-50%)'
    : 'translate(-50%, -100%)';
}

function buildRadial(metrics = lastRadialMetrics) {
  radial.innerHTML = '';
  const exact = usableRadialMetrics(metrics);
  if (exact) lastRadialMetrics = exact;
  if (!catVisible) {
    buildCompactRadial();
    return;
  }
  radial.dataset.layout = 'radial';
  const el = curSkinEl();
  const sr = stage.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const cx = r.left - sr.left + r.width / 2;
  const cy = r.top - sr.top + r.height / 2;
  const items = MENU;
  const n = items.length;
  const frame = exact && exact.window;
  const viewportW = Math.max(1, frame ? frame.width : (window.innerWidth || 320));
  const viewportH = Math.max(1, frame ? frame.height : (window.innerHeight || 340));
  const wa = exact ? exact.workArea : browserWorkArea();
  const winX = frame ? frame.x : (Number.isFinite(window.screenX) ? window.screenX : wa.x);
  const winY = frame ? frame.y : (Number.isFinite(window.screenY) ? window.screenY : wa.y);
  const pad = 5;
  // Intersect the BrowserWindow viewport with the actually visible work area.
  // This protects old saved positions that may still have part of the
  // transparent window off-screen before the first drag normalises them.
  const safeRect = {
    x: Math.max(pad, wa.x - winX + pad),
    y: Math.max(pad, wa.y - winY + pad),
    width: Math.max(46, Math.min(viewportW - pad, wa.x + wa.width - winX - pad) - Math.max(pad, wa.x - winX + pad)),
    height: Math.max(46, Math.min(viewportH - pad, wa.y + wa.height - winY - pad) - Math.max(pad, wa.y - winY + pad)),
  };
  // 只喂竖直偏好。横向让 cornerMenuLayout 自己按 roomLeft/roomRight 打分 —— 上面的
  // safeRect 已经和工作区求过交，所以「贴左缘时左侧没有屏幕」这件事它算得出来，
  // 不需要（也已经无法）从 edgeLayout 里读横向贴边态。
  const preferred = [];
  if (edgeLayout.vertical === 'below') preferred.push('below');
  else preferred.push('above');
  preferred.push(edgeLayout.vertical === 'below' ? 'above' : 'below');
  const petLocalRect = { x: r.left - sr.left, y: r.top - sr.top, width: r.width, height: r.height };
  const layout = window.PetGeometry
    ? window.PetGeometry.cornerMenuLayout({
      count: n,
      center: { x: cx, y: cy },
      petRect: petLocalRect,
      safeRect,
      preferred,
      itemRadius: 26,
      gap: 10,
    })
    : { direction: 'top-right', points: [] };
  radial.dataset.direction = layout.direction || 'top-right';
  items.forEach((it, i) => {
    const point = layout.points[i] || { x: cx, y: cy };
    const b = makeRadialItem(it, i);
    b.style.left = point.x + 'px';
    b.style.top = point.y + 'px';
    radial.appendChild(b);
  });
}

async function openRadial() {
  const seq = ++radialOpenSeq;
  if (actionPopOpen) closeActionPop();
  if (peekOpen) closePeek();
  if (quotaPopoverOpen) closeQuotaPopover();
  radialOpen = true;
  bubble.classList.add('hidden');
  try { await readPrivacyMode(); } catch {}
  if (seq !== radialOpenSeq || !radialOpen) return;
  // closeActionPop 会异步把 BrowserWindow 从弹层尺寸缩回基础
  // 尺寸。必须等窗口和 DOM 都归位后再布局，否则菜单会按旧大窗坐标生成，
  // 随后的缩窗会把按钮直接裁出可见区域。
  let metrics = await settledRadialMetrics();
  if (seq !== radialOpenSeq || !radialOpen) return;
  settleEdgeLayout();
  metrics = await settledRadialMetrics() || metrics;
  if (seq !== radialOpenSeq || !radialOpen) return;
  buildRadial(metrics);
  radial.classList.remove('hidden');
  if (!catVisible) {
    positionCompactRadial();
    requestAnimationFrame(() => {
      if (seq === radialOpenSeq && radialOpen) positionCompactRadial();
    });
  }
}
function closeRadial() {
  radialOpenSeq++;
  radial.classList.add('hidden');
  radial.removeAttribute('data-layout');
  radial.removeAttribute('data-direction');
  radialOpen = false;
}
function toggleRadial() {
  if (radialOpen) closeRadial();
  else openRadial().catch(() => closeRadial());
}
// 点遮罩空白处关闭
radial.addEventListener('click', () => closeRadial());
window.addEventListener('blur', () => {
  if (radialOpen) closeRadial();
  if (peekOpen) closePeek();
  if (quotaPopoverOpen) closeQuotaPopover();
  if (actionPopOpen) closeActionPop();
  // askHover 只靠 mousemove 命中测试（:3463）和 pointerleave 维护，而失焦之后 macOS 不再
  // 投递 mousemove（见 main.js releaseClickThrough 的 G1 注释）—— 光标恰好停在 #ask 上时
  // 失焦，askHover 会永久卡在 true，isInteracting() 随之永真，状态更新被冻住。
  askHover = false;
  // 刻意**不**关 ask 卡片：askActive 有真实草稿（hideAsk 会清掉 #ask-text 的内容），
  // 而「切到别的应用查点东西再切回来接着敲」是常规操作，失焦丢字是破坏性的。
  // 卡片留着不会锁死交互 —— 上面清了 askHover，穿透态由主进程的失焦复位兜住。
});

// ---------- 初始化 ----------
(async () => {
  // 单宠：无名牌、无按工具切换的唤起按钮（打工喵一只盯全部）。
  // Convert positions saved by older builds that anchored the transparent
  // window rather than the visible pet.
  requestAnimationFrame(settleEdgeLayout);
  applyStaticI18n();
  if (window.pet.getPetAssets) {
    try { applyPetAssetCatalog(await window.pet.getPetAssets()); } catch {}
  }
  // 预热高频状态各一张。启动这会儿本来就在等 getStats 的 IPC，解码搭这段空闲跑完，
  // 第一次真正切状态就是命中缓存的瞬时切换，而不是「旧姿势卡一下」。
  // 只挑 3 个：全部 28 张一起解码是 3.2MB 的位图，启动期抢 CPU 反而更差。
  for (const name of ['idle', 'thinking', 'working']) {
    const pool = stateAssetUrls(name);
    if (pool.length) warmAsset(pool[0]);
  }
  const s = await window.pet.getStats();
  // 有快照就按真实聚合态亮相；之前无条件 setState('idle') 会把刚算出的
  // working/waiting 盖掉，启动瞬间总是先闪一下空闲。getStats 落空但推送
  // 已先到时（lastStats 已有值）同样不能清。
  if (s) applyStats(s);
  else if (!lastStats) setState('idle');
  // 启动正好落在下班窗口时，保留更有时效性的干饭播报，
  // 不再立刻用“上线”气泡覆盖它。
  if (!(XIABAN_STATES.has(state) && xiabanWindow())) showBubble(t('bub.online'), 3000);
})();

// ---------- 透明区域点击穿透（命中测试）----------
// 桌宠窗口是透明矩形，空白处不该拦住后面的应用。光标在内容(打工喵/卡片/菜单/记事本)
// 上 → 接收点击；在透明区 → 让窗口穿透。forward:true 使穿透时 mousemove 仍回传，
// 因此一旦光标回到内容上即可恢复可点。拖动中(g)始终保持可点。
// The capsule is still the drag handle when the cat is hidden, while the
// quota group is a deliberate click target in either layout. The rest of the
// visible capsule remains click-through so hovering it never creates a popup.
const HIT_SEL = '#cat,#stage.cat-hidden #chip,#chip-quota,#quota-popover,#radial,#notepad,#action-pop,#ask,#peek';
// ⚠️ 这里**刻意没有** `if (on === mouseIgnoring) return;` 早退守卫。它看起来只是去重，
// 实际是穿透态永久锁死的后半段（实测，probeSync）：主进程的三处失焦复位
// （PET_BLUR / win 'blur' / 心跳 !isFocused()）都**单方面**把 st.mouseIgnoring 改成
// false 并下发 setIgnoreMouseEvents(false)，而渲染端毫不知情 —— 没有任何 main→renderer
// 的回传通道（shared/ipc-channels.js 里 SET_IGNORE_MOUSE 是单向的）。
//
// 于是两侧对不上之后：渲染端本地仍是 true，每个 mousemove 都算出 on=true，每次都被
// 这条守卫吞掉，IPC 一次都不发。实测 rlog 全是 SKIP（[[8032,1,'SKIP'],[8232,1,'SKIP']]），
// 窗口永久停在「该穿透时不穿透」，4s 心跳每 4 秒重新制造一次。
//
// 所以这里改成**无状态地每次都下发**：mousemove 是权威的命中测试，让它每一次都重新
// 断言真相，两侧就不可能长期对不上。去重挪到主进程侧（SET_IGNORE_MOUSE handler），
// 那里的 st.mouseIgnoring 才真的是「我们最后一次下发给 OS 的值」。
// 代价只是一个布尔量的 IPC，量级远小于这个回调里本来就有的 elementFromPoint + closest。
let mouseIgnoring = false;
function setMouseIgnore(on) {
  mouseIgnoring = on;
  try { window.pet.setIgnoreMouse(on); } catch {}
}
window.addEventListener('mousemove', (e) => {
  if (g) { setMouseIgnore(false); return; } // 拖动中保持可点
  const el = document.elementFromPoint(e.clientX, e.clientY);
  // 命中测试权威同步悬停态：穿透切换时 pointerleave 可能漏发，会把 askHover 卡在 true，
  // 进而让 isInteracting() 永远为真、refreshAsk 永不对账（旧卡片冻结、新卡片进不来）。
  askHover = !!(el && el.closest('#ask'));
  if (quotaPopoverOpen) {
    const quotaHit = !!(el && (el.closest('#chip-quota') || el.closest('#quota-popover')));
    if (quotaHit) keepQuotaPopoverOpen();
    else {
      quotaPopoverPointerInside = false;
      scheduleQuotaPopoverClose();
    }
  }
  setMouseIgnore(!(el && el.closest(HIT_SEL)));
}, true);
// 启动即默认穿透（透明区不挡），光标移到内容上时由上面的命中测试恢复
setMouseIgnore(true);

// 气泡和窗口自适应都可能改变本体在透明窗里的局部位置。
window.addEventListener('resize', () => {
  applyPendingEdgeLayout();
  requestAnimationFrame(() => {
    positionBubbleTip();
    positionQuotaPopoverTip();
    if (propEl && propEl.classList.contains('on')) positionProp();
    if (radialOpen && !catVisible) positionCompactRadial();
    if (!askActive && !actionPopOpen && !peekOpen && !quotaPopoverOpen && !radialOpen) fitRestingFrame();
  });
});
