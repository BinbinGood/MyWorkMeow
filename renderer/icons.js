'use strict';

// SVG icon set — replaces emoji glyphs so the UI renders identically on every
// machine and matches the WorkMeow art style (no system-font emoji jitter).
//
// Each icon is a raw SVG string sized 1em via `width=1em height=1em` so it
// inherits font-size and color (fill=currentColor) — drop them inline anywhere
// a glyph used to sit, no extra CSS class needed for default layout.
//
// USAGE:
//   const html = icon('check')                 → inline SVG string
//   const out  = withIcons('✅ 已允许')          → emoji → SVG, text otherwise
//   setTextWithIcons(el, '💬 hello')           → safe text→innerHTML pipeline
//   const svg  = agentIcon('codex')            → Agent 标识图标（固定品牌色）
//
// 例外：agentIcon() 那一组**不**吃 currentColor，颜色写死在 SVG 里 —— 那几个
// 品牌色本身就是「这是哪个 Agent」的辨识信息，跟着文字颜色变就没意义了。
//
// `withIcons` is XSS-safe IF the caller treats the OUTPUT as innerHTML AND the
// input text was previously escaped (it textContent-encodes the surrounding
// text via `escapeHtml`, only the icon name is trusted).

(function (root) {
  // 24x24 viewBox, outline+fill strokes mostly. Pure SVG, no fonts.
  // Picked to match the WorkMeow art language: clean rounded lines, no gradients.
  const ICONS = {
    // ✅ 完成/允许
    check: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 L10 17.5 L19 7"/></svg>',
    // 💬 对话/说
    chat: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5C4 5.4 4.9 4.5 6 4.5h12c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-7l-4 3.5v-3.5H6c-1.1 0-2-.9-2-2v-8z"/></svg>',
    // ✋ 等待/请示
    hand: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 11V4.8a1.3 1.3 0 0 1 2.6 0V11"/><path d="M10.6 10.4V3.5a1.3 1.3 0 0 1 2.6 0V11"/><path d="M13.2 10.4V4.2a1.3 1.3 0 0 1 2.6 0V12"/><path d="M15.8 10V6.4a1.3 1.3 0 0 1 2.6 0v8.6c0 3.6-2.7 6-6 6-2.7 0-4.6-1.4-5.6-3.6L4.6 13.4a1.4 1.4 0 0 1 2.2-1.7L8 13.2"/></svg>',
    // 💤 睡眠
    zzz: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 7h6l-6 8h6"/><path d="M13 12h5l-5 6h5"/></svg>',
    // 📊 详情/图表
    chart: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 18v-6"/><path d="M12 18V8"/><path d="M16 18v-4"/></svg>',
    // 📄 日志/文件
    doc: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>',
    // 🔔 铃铛
    bell: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 16.5V11a5.5 5.5 0 1 1 11 0v5.5l1.5 2h-14z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    // — 收起/隐藏
    minus: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>',
  };

  // ── Agent 标识图标 ──────────────────────────────────────────────────────────
  // 和上面 ICONS 的两点不同，都是刻意的：
  //   1. **固定品牌色**，不吃 currentColor —— 颜色本身就是辨识信息的一部分
  //   2. 形状之间差异明显（星形 / 箭头 / 对角线 / 猫脸 / 三角），所以在色弱
  //      或黑白截图下仍能区分；颜色是辅助，不是唯一手段
  //
  // 2026-09-16 从 renderer/panel.js 的私有 AGENT_ICON 提上来，让速览（pet）和
  // 面板（panel）共用一份。放在这里而不是 shared/agents.js：后者被
  // backend/permission.js、backend/server.js require，不该为渲染层塞 SVG。
  //
  // claude 与 trae 的原色（#d97757 / #16b8a6）在速览悬停背景 #fff1e8 上只有
  // 2.82 : 1 和 2.25 : 1，低于非文本元素 3 : 1 的下限，压深一档到 3.72 / 3.57。
  // 色相不动，看着还是同一个牌子的橙和青。
  const AGENT_ICONS = {
    claude: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="#c65f3d" aria-hidden="true"><path d="M12 1l2.2 6.3L20.5 5l-4 5.4 6.5 1.6-6.5 1.6 4 5.4-6.3-2.3L12 23l-2.2-6.3L3.5 19l4-5.4L1 12l6.5-1.6-4-5.4 6.3 2.3z"/></svg>',
    codex: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#3b82f6"/><path d="M7 8l4 4-4 4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 16.5h4.5" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
    trae: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#12907f"/><path d="M7 17L17 7M17 7H9M17 7V15" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    // WorkBuddy 官方 logo 矢量（绿渐变底 + 白猫脸），直接取自客户端本体，
    // 不是手绘近似：WorkBuddy.app/Contents/Resources/app.asar →
    // /renderer/assets/logo-workbuddy-<hash>.svg（原图 64×64，带黄色光晕滤镜）。
    // 这里 translate(2 2) scale(0.3125) 压进 20×20 方框，圆角归到 rx=5 与其他四个
    // 图标对齐，底部保留真·品牌渐变 #0EC7A8→#00C885，丢掉光晕滤镜（13px 下是噪声）。
    workbuddy: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><defs><linearGradient id="wmwbBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0EC7A8"/><stop offset="1" stop-color="#00C885"/></linearGradient><clipPath id="wmwbClip"><rect width="64" height="64" rx="16"/></clipPath></defs><rect x="2" y="2" width="20" height="20" rx="5" fill="url(#wmwbBg)"/><g transform="translate(2 2) scale(0.3125)"><g clip-path="url(#wmwbClip)"><path fill="#FFF" fill-opacity="1" transform="matrix(0.866025 -0.5 0.5 0.866025 -7.25994 37.2434)" d="M10.4632 2.7569C11.0168 1.0854 11.4183 0.4342 12.0804 0.1628C12.482 0 13.4155 0.1302 14.4249 0.4884C16.9539 1.411 21.7513 4.6672 26.755 8.8677L27.276 9.3018L29.1971 8.9111C32.3882 8.2598 34.3961 8.0211 37.9128 7.9017C41.5815 7.7714 45.4237 8.1405 49.4831 9.0196L50.7856 9.3018L52.3051 8.0645C57.7647 3.6035 62.4102 0.6729 64.798 0.1845C65.6229 0.0109 65.6663 0.0109 66.0788 0.2171C66.7517 0.5427 67.1642 1.1939 67.6418 2.6918C68.7597 6.1867 69.4978 12.4712 69.3675 17.3989L69.3133 19.3092L70.1056 20.5031C70.8654 21.6645 71.9833 23.7918 72.3741 24.8121C72.5477 25.2788 72.5912 25.3114 73.0145 25.3765C74.9248 25.6696 76.694 27.7644 77.5731 30.7926C78.3655 33.517 78.3872 37.4027 77.6382 40.203C77.508 40.648 77.1498 41.5597 76.835 42.211C75.7171 44.4903 74.0022 45.8362 72.1896 45.8471C71.8205 45.847 71.7771 45.8796 71.3864 46.5743C70.0538 48.9871 68.2229 51.1078 65.931 52.9197L65.931 18.983L12.3947 18.983L12.3947 53.6887C12.3876 53.6834 12.3806 53.6781 12.3735 53.6727C9.8011 51.7407 7.2938 48.8536 6.165 46.5308C5.872 45.9122 5.8069 45.847 5.3727 45.7385C3.0608 45.1632 1.1397 42.4932 0.3473 38.7703C0.0326 37.2833 0 34.0597 0.2822 32.5075C0.9551 28.8823 2.7352 26.2882 5.0905 25.4851C5.6983 25.2788 5.72 25.268 6.0456 24.5191C6.5775 23.2926 7.5001 21.5559 8.1947 20.4922L8.8351 19.4937L8.8677 15.8793C8.9328 10.257 9.4755 5.8177 10.4632 2.7569ZM12.5027 53.7693C16.8022 56.9564 22.7683 58.8585 31.0748 59.6967C34.5807 60.044 42.7971 60.0114 46.4874 59.6207C53.3471 58.9152 59.0672 57.2654 63.1482 54.8341C63.7166 54.4938 64.2642 54.1388 64.7905 53.7693L12.5027 53.7693Z" fill-rule="evenodd"/><path fill="#FFF" transform="matrix(0.866025 -0.5 0.5 0.866025 29.5937 50.1354)" d="M6.4145 3.2072L6.4145 10.1152Q6.4145 11.4436 5.4751 12.383Q4.5357 13.3224 3.2072 13.3224L3.2072 13.3224Q1.8788 13.3224 0.9394 12.383Q0 11.4436 0 10.1152L0 3.2072Q0 1.8788 0.9394 0.9394Q1.8788 0 3.2072 0L3.2072 0Q4.5357 0 5.4751 0.9394Q6.4145 1.8788 6.4145 3.2072Z"/><path fill="#FFF" transform="matrix(0.866025 -0.5 0.5 0.866025 46.9001 40.1434)" d="M6.4145 3.2072L6.4145 10.1152Q6.4145 11.4436 5.4751 12.383Q4.5357 13.3224 3.2072 13.3224L3.2072 13.3224Q1.8788 13.3224 0.9394 12.383Q0 11.4436 0 10.1152L0 3.2072Q0 1.8788 0.9394 0.9394Q1.8788 0 3.2072 0L3.2072 0Q4.5357 0 5.4751 0.9394Q6.4145 1.8788 6.4145 3.2072Z"/></g></g></svg>',
    opencode: '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#17181c"/><path d="M8.5 6.5v11L17.5 12z" fill="#ff5f1f"/></svg>',
  };

  // 未知 key 一律回落到 claude —— 调用点原本就是这个行为（panel.js 的
  // `AGENT_ICON[s.agent] || AGENT_ICON.claude`），保持一致，绝不返回空串：
  // 空串会让那一格塌掉，整行文字跟着左移，看着像布局坏了。
  function agentIcon(key) {
    return AGENT_ICONS[key] || AGENT_ICONS.claude;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function icon(name) {
    return ICONS[name] || '';
  }

  // emoji code-point → icon name. Add to this map as we wire more icons in.
  const EMOJI_TO_ICON = {
    '✅': 'check',
    '💬': 'chat',
    '✋': 'hand',
    '💤': 'zzz',
    '📊': 'chart',
    '📄': 'doc',
    '🔔': 'bell',
  };

  const EMOJI_SRC = '(' + Object.keys(EMOJI_TO_ICON).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
  const EMOJI_RE = new RegExp(EMOJI_SRC, 'g');       // for replace-all in withIcons
  const EMOJI_TEST_RE = new RegExp(EMOJI_SRC);       // no /g — .test() must be stateless

  // Take a plain string, escape it (HTML-safe), then swap known emoji for SVG.
  // Output is intended for innerHTML; surrounding user text is already escaped.
  function withIcons(text) {
    const escaped = escapeHtml(text);
    return escaped.replace(EMOJI_RE, (e) => '<span class="oi">' + (ICONS[EMOJI_TO_ICON[e]] || e) + '</span>');
  }

  function setTextWithIcons(el, text) {
    if (!el) return;
    el.innerHTML = withIcons(text == null ? '' : String(text));
  }

  // Detect: does this string contain any of our mapped emoji? If not, callers
  // can keep using textContent for speed — useful in hot paths.
  function hasMappedEmoji(text) {
    // Use the non-global regex: a /g regex's .test() advances lastIndex and
    // wouldn't reset, so repeated calls on the same string flip true/false/true…
    return EMOJI_TEST_RE.test(String(text == null ? '' : text));
  }

  root.WorkMeowIcons = { icon, agentIcon, withIcons, setTextWithIcons, hasMappedEmoji, EMOJI_TO_ICON };
})(typeof window !== 'undefined' ? window : globalThis);
