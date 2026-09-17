'use strict';

// Single source of truth for every user-visible string.
//
// Required by the main process (main.js, backend/adapter.js) and loaded as a
// <script> by the renderer (pet.html / panel.html → window.WorkMeowI18n), mirroring
// the shared/states.js UMD shim.
//
// Localized strings shared by the pet and detail panel.
//

// Placeholders use {name} and are substituted by t(key, vars).

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.WorkMeowI18n = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  const zh = {
    // ── tray ────────────────────────────────────────────────────────────────
    'tray.tooltip': '打工喵 WorkMeow — 盯所有 AI 工具的桌宠',
    'tray.tooltipPrivate': '打工喵 WorkMeow — 隐私模式已开启',
    'tray.panel': '详情面板',
    'tray.showPet': '显示打工喵',
    'tray.hidePet': '藏起打工喵',
    'tray.quotaTitle': 'Codex　账户 {account}',
    'tray.quotaWindow': '{label}　剩余 {remaining}　{reset} 刷新',
    'tray.quotaUpdated': '更新于 {time}',
    'tray.quotaStatus': '状态　{status}',
    'tray.quotaPending': 'Codex 额度　{status}',
    'tray.quotaStatusReady': '实时同步中',
    'tray.quotaStatusConnecting': '正在同步当前账户…',
    'tray.quotaStatusCodexMissing': '未找到 Codex，正在自动重试',
    'tray.quotaStatusSignedOut': 'Codex 尚未登录 ChatGPT',
    'tray.quotaStatusChatgptRequired': '当前账户没有订阅额度',
    'tray.quotaStatusUnavailable': '暂时不可用，正在自动重试',
    // 每个「有效 agent」（检测到就算）一行，按片段拼接，超宽在片段边界折行。
    // 每个片段自带单位/名词 —— 压到一行之后光看「1696」分不清是积分还是 token。
    // 「剩余」= 用户手填的每期总量 − 本期已用；没填额度时显示 *Unset 那一条
    // （而不是一个会被读成「用完了」的 0，也不是把整行删掉）。
    'tray.rowWindow': '{label}　{percent}%',
    'tray.rowStatus': '{status}',
    'tray.rowCredit': '积分剩余 {left}',
    'tray.rowCreditUnset': '积分未设置每期总量',
    'tray.rowTokens': 'Token　{tokens}',
    'tray.rowCost': '费用 {cost}',
    'tray.rowNoData': '暂无数据',
    'tray.noSources': '尚未接入任何 AI 工具',
    // 「都关了」和「没接入」是两种空态，必须分得清：前者的解法在设置页，
    // 后者要去装 hook。共用一句会让用户以为喵坏了。
    'tray.allHidden': '所有 Agent 都已隐藏，可在设置里打开',
    'tray.settings': '设置',
    'tray.quit': '退出',

    // ── dialogs ─────────────────────────────────────────────────────────────
    'dlg.dupTitle': '打工喵已在运行',
    'dlg.dupBody': '检测到另一个打工喵实例正在端口 {port} 上服务（可能来自其他代码副本）。\n',
    'dlg.dupHint': '本实例将退出，避免抢占会话事件。\n开发需要多开时：WORKMEOW_ALLOW_MULTI=1',
    'dlg.integrationsTitle': '打工喵已准备好',
    'dlg.integrationsMessage': '便携运行环境已经就绪',
    'dlg.integrationsReady': '已接入',
    'dlg.integrationsMissing': '未检测到，安装或首次使用后会自动接入',
    'dlg.integrationsFailed': '已检测到，但接入尚未完成',
    'dlg.integrationsDisabled': '已停用，可在设置中重新接入',
    'dlg.integrationsHint': '无需安装 Node.js。以后可以在设置的 Agent 接入区域再次检查与修复。',

    // ── settings ────────────────────────────────────────────────────────────
    'settings.title': '打工喵 · 设置',
    'settings.subtitle': '调整隐私、接入、更新方式和喵咪表情',
    'settings.generalTab': '常规',
    'settings.expressionsTab': '喵咪表情',
    'settings.startupSection': '启动设置',
    'settings.autoLaunchTitle': '开机自动启动',
    'settings.autoLaunchDescription': '登录系统后自动运行打工喵',
    'settings.enabled': '已开启',
    'settings.disabled': '已关闭',
    'settings.saving': '保存中…',
    'settings.saved': '设置已更新',
    'settings.failed': '保存失败，请重试',
    'settings.unsupported': '当前系统不支持此设置',
    'settings.hint': '修改会立即生效，下次登录时自动运行。',
    // macOS 13+ 会先把新登记的登录项挂成「待批准」，必须由用户在系统设置里放行；
    // 开发态（源码运行）走的是 LaunchAgent，不进登录项列表，路径变动后会过期。
    'settings.autoLaunchApproval': '已登记，但需要在「系统设置 → 通用 → 登录项」里批准后才会生效',
    'settings.autoLaunchStale': '登录项记录的程序路径已变化（项目挪过位置或重装过依赖），请关闭后再开启一次',
    'settings.privacySection': '隐私保护',
    'settings.privacyTitle': '隐私模式',
    'settings.privacyDescription': '隐藏项目名、消息、命令和操作明细，保留状态与用量',
    'settings.privacyEnabled': '已开启，屏幕内容已遮蔽',
    'settings.privacyDisabled': '已关闭，正常显示任务详情',
    'settings.privacySaving': '正在切换隐私模式…',
    'settings.privacyFailed': '切换失败，请重试',
    'settings.privacyHint': '也可以右键打工喵，通过 ON/OFF 快速切换。',

    // 喵底部展示栏。额度那一项以前是**一个**会动态改名的槽位（接 Codex 就叫
    // 「Codex 订阅额度」，否则叫「WorkBuddy 积分」），设置页写 Codex 而托盘写
    // WorkBuddy，看起来自相矛盾。2026-09-15 改成：**每个检测到的 Agent 各一个
    // 开关**，有几个有效的就有几个按钮，和托盘的行一一对应（见 backend/tray-status.js）。
    'settings.chipSection': '喵底部展示栏',
    'settings.chipShowCat': '显示喵喵',
    'settings.chipShowCatDescription': '隐藏喵喵本体，状态小点会移动到胶囊左侧；胶囊可直接拖动',
    'settings.chipShowStatus': '任务状态',
    'settings.chipShowStatusDescription': '显示“待命、休息中、干活中、刚刚完成”等当前状态',
    'settings.chipShowTokens': '今日 Tokens',
    'settings.chipShowTokensDescription': '显示全部工具今日累计 Token 消耗',
    'settings.chipShowCost': '今日 API 等价费用',
    'settings.chipShowCostDescription': '按 API 价格估算，不代表订阅实际扣费',
    'settings.chipHint': '修改立即生效并自动保存；完整用量仍可在统计面板查看。',
    // 按 Agent 拆开的开关。每个 Agent 有**两个独立开关**：底部展示栏（额度徽标）
    // 和托盘菜单（那一行信息），2026-09-16 拆开 —— 之前一组开关同时管两处。
    'settings.quotaAgentsKicker': '显示哪些 Agent',
    'settings.quotaAgentCodexDescription': '提供 5h、7d 剩余百分比',
    'settings.quotaAgentCreditDescription': '提供剩余积分（在下面填每期总量）',
    'settings.quotaAgentNoneDescription': '不提供额度数据，只有今日 Token 与费用',
    'settings.agentChipLabel': '底部展示栏',
    'settings.agentTrayLabel': '托盘菜单',
    'settings.agentChipToggle': '在底部展示栏显示 {name}',
    'settings.agentTrayToggle': '在托盘菜单显示 {name}',
    'settings.quotaAgentsLoading': '正在检查接入的 Agent…',

    // 积分额度（手填）。WorkBuddy 的余额只在服务端、本机无副本，所以由用户填每期
    // 总量、本机用已用反推剩余。见 backend/credit-cycle.js。
    'settings.creditQuotaSection': '积分额度',
    'settings.creditQuotaDescription': '填「{name}」套餐每期的积分总量，打工喵会用本机统计的消耗反推剩余；留空则不显示剩余。',
    'settings.creditQuotaMonthly': '每期积分总量',
    'settings.creditQuotaResetDay': '每月重置日',
    'settings.creditQuotaSave': '保存额度',
    'settings.creditQuotaClear': '清除',
    'settings.creditQuotaHint': '剩余 = 每期总量 − 本期已用（本机统计，按本地自然日）；「本期」从重置日算起。',
    'settings.creditQuotaSaving': '保存中…',
    'settings.creditQuotaSaved': '额度已保存，托盘已更新',
    'settings.creditQuotaCleared': '额度已清除，托盘不再显示「剩余」',
    'settings.creditQuotaFailed': '保存失败，请重试',
    'settings.creditQuotaInvalid': '请填一个大于 0 的积分总量',
    'settings.creditQuotaOn': '当前每期 {monthly}（每月 {day} 日重置）',
    'settings.integrationsSection': 'Agent 接入',
    'settings.integrationsTitle': '接入健康检查',
    'settings.integrationsDescription': '核对各工具的 Hook、插件或只读监听器是否正常',
    'settings.integrationsChecking': '正在检查接入状态…',
    'settings.integrationsNone': '尚未检测到支持的 AI 工具',
    'settings.integrationsHealthy': '已检测 {detected} 个，接入正常',
    'settings.integrationsIssues': '{ready}/{detected} 个正常 · {issues} 个待修复',
    'settings.integrationsReady': '正常',
    'settings.integrationsRepair': '待修复',
    'settings.integrationsDisabled': '已停用',
    'settings.integrationsMissing': '未检测到',
    'settings.integrationsHook': '生命周期 Hook',
    'settings.integrationsWatcher': '本地只读监听',
    'settings.integrationsPlugin': '本地插件',
    'settings.integrationsLastEvent': '最后事件 {time}',
    'settings.integrationsNoEvent': '尚无会话事件',
    'settings.integrationsRefresh': '重新检查',
    'settings.integrationsUninstall': '卸载接入',
    'settings.integrationsRepairAll': '一键修复',
    'settings.integrationsRepairing': '正在修复接入…',
    'settings.integrationsRepaired': '接入已恢复',
    'settings.integrationsPartial': '仍有接入未恢复，请重启对应工具后再检查',
    'settings.integrationsCheckFailed': '检查失败，请重试',
    'settings.integrationsEnvDisabled': '当前运行模式禁止修改 Hook',
    'settings.integrationsUninstallConfirm': '卸载 WorkMeow 已写入的 Hook 和插件吗？\n\n不会卸载 AI Agent 本身；之后可以通过“一键修复”重新接入。',
    'settings.integrationsUninstalling': '正在卸载 WorkMeow 接入…',
    'settings.integrationsUninstalled': 'WorkMeow 接入已卸载，可随时一键修复',
    'settings.integrationsUninstallPartial': '部分接入未能卸载，请关闭对应 Agent 后重试',
    'settings.integrationsHint': '修复只处理已检测工具；卸载只移除 WorkMeow 写入的 Hook 和插件，不影响 Agent 本身。',
    'settings.updateSection': '版本更新',
    'settings.autoUpdateTitle': '自动检查更新',
    'settings.installerUpdateDescription': '自动检查并下载 EXE 安装版更新，安装前会请你确认',
    'settings.portableUpdateDescription': '自动检查新版本；发现后引导下载最新版 ZIP',
    'settings.developmentUpdateDescription': '开发模式不执行在线更新',
    'settings.currentVersion': '当前版本',
    'settings.latestVersion': '最新版本',
    'settings.checkUpdate': '立即检查',
    'settings.downloadUpdate': '下载更新',
    'settings.openDownload': '前往下载',
    'settings.restartUpdate': '立即重启更新',
    'settings.updateIdle': '尚未检查更新',
    'settings.updateChecking': '正在检查更新…',
    'settings.updateLatest': '当前已经是最新版本',
    'settings.updateAvailable': '发现新版本 {version}',
    'settings.updateDownloading': '正在下载更新 {percent}%',
    'settings.updateDownloaded': '新版本已下载，等待重启安装',
    'settings.updateFailed': '检查更新失败：{message}',
    'settings.updateDevelopment': '开发模式无法检查发布版本',
    'settings.updateUnsupported': '当前系统不支持自动更新',
    'settings.updateInstallerHint': '自动更新不会强制退出；下载完成后由你决定何时重启安装。',
    'settings.updatePortableHint': 'ZIP 免安装版不会自动覆盖当前目录，下载后请解压新版。',
    'update.readyTitle': '打工喵更新已就绪',
    'update.readyMessage': 'WorkMeow {version} 已下载完成',
    'update.readyDetail': '现在重启即可完成更新；正在运行的 AI 任务不会被终止。',
    'update.restartNow': '立即重启更新',
    'update.later': '稍后',
    'settings.xiabanSection': '下班彩蛋',
    'settings.xiabanDescription': '在指定时间播放下班动画和提示语',
    'settings.lunchTime': '午间彩蛋',
    'settings.eveningTime': '晚间彩蛋',
    'settings.saveTime': '保存时间',
    'settings.resetTime': '恢复默认',
    'settings.timeSaving': '保存中…',
    'settings.timeSaved': '下班时间已更新',
    'settings.timeInvalid': '请输入有效的时间',
    'settings.timeSaveFailed': '下班时间保存失败，请重试',
    'settings.timeHint': '彩蛋持续 10 分钟，仅在打工喵空闲或休息时播放。',
    'settings.expressionsTitle': '自定义每一种喵咪状态',
    'settings.expressionsDescription': '选择状态和具体表情后，可以新增、替换或移出。导入后会自动透明化、等比缩放并适配到 120×120。',
    'settings.removeBackground': '自动清理纯色背景',
    'settings.allStates': '全部状态',
    'settings.allStatesHint': '点击卡片进行管理',
    'settings.addExpression': '＋ 新增',
    'settings.replaceExpression': '替换选中',
    'settings.removeExpression': '移出选中',
    'settings.addReplaceHint': '新增会保留当前列表；替换和移出只作用于选中的表情。每个状态至少保留一个表情。',
    'settings.currentExpressions': '当前播放列表',
    'settings.restoreStateDefault': '恢复这个状态的默认表情',
    'settings.close': '关闭',

    // ── waiting reasons ─────────────────────────────────────────────────────
    // 完整短语直接使用中文，避免把中文语序拆成两段。
    'wait.reply': '等你回复',
    'wait.plan': '等你审方案',
    'wait.perm': '等你授权',
    'wait.default': '等你处理',
    'reason.reply': '回复',
    'reason.plan': '审方案',
    'reason.perm': '授权',
    'reason.default': '处理',

    // ── session states ──────────────────────────────────────────────────────
    'state.working': '干活中',
    'state.juggling': '并行子任务',
    'state.sweeping': '清理上下文',
    'state.thinking': '思考中',
    'state.loafing': '摸鱼中',
    'state.loafingLong': '摸鱼中(等下一步)',
    'state.waiting': '等你处理',
    'state.needsinput': '等你回复',
    'state.error': '出错了',
    'state.done': '刚完成',
    'state.idle': '空闲',
    'state.sleeping': '休息中',
    'state.greet': '新会话',
    'state.talking': '回应中',

    // ── background work ─────────────────────────────────────────
    'background.tasks': '后台任务 {count} 项',
    'background.crons': '定时等待 {count} 项',
    'background.mixed': '后台 {tasks} 项 · 定时 {crons} 项',

    // ── privacy mode ───────────────────────────────────────────────
    'privacy.project': '私密任务',
    'privacy.hiddenDetail': '详情已隐藏',
    'privacy.newMessage': '收到一条新消息',
    'privacy.enabled': '隐私模式已开启',

    // ── tool labels ─────────────────────────────────────────────────────────
    'tool.Edit': '编辑文件',
    'tool.Write': '写文件',
    'tool.NotebookEdit': '编辑笔记本',
    'tool.Read': '读取文件',
    'tool.Bash': '运行命令',
    'tool.Grep': '搜索代码',
    'tool.Glob': '查找文件',
    'tool.WebSearch': '联网搜索',
    'tool.WebFetch': '抓取网页',
    'tool.Task': '派出子 agent',
    'tool.TodoWrite': '更新待办',
    'tool.Js': '跑 JS 代码',
    'tool.Wait': '等命令输出',
    'tool.default': '处理中',

    // ── error bubbles ───────────────────────────────────────────────────────
    'err.rateLimit': '🚦 被限流了，稍等…',
    'err.server': '🌐 服务器开小差了，正在重试…',
    'err.billing': '💳 账单/额度异常',
    'err.auth': '🔑 鉴权失败',
    'err.model': '🤖 模型不可用',
    'err.maxTokens': '✂️ 输出超长被截断',
    'err.default': '😵 出了点状况，在想办法…',

    // ── Codex subscription quota ───────────────────────────────────────────
    'quota.alertFiveHour': 'Codex 5 小时额度剩余 {remaining}，{reset} 刷新',
    'quota.alertWeekly': 'Codex 周额度剩余 {remaining}，{reset} 刷新',
    'quota.title': 'Codex 订阅额度',
    'quota.open': '查看 Codex 订阅额度与刷新时间',
    'quota.synced': '实时同步中',
    'quota.unavailable': '额度暂不可用',
    'quota.fiveHour': '5h',
    'quota.weekly': '7d',
    'quota.remaining': '剩余 {percent}',
    'quota.resetUnknown': '刷新时间暂不可用',
    'quota.resetSoon': '即将刷新',
    'quota.resetIn': '约 {time}后刷新',
    'quota.durationMinutes': '{count}分钟',
    'quota.durationHoursMinutes': '{hours}小时{minutes}分',
    'quota.durationHours': '{count}小时',
    'quota.durationDaysHours': '{days}天{hours}小时',
    'quota.durationDays': '{count}天',
    'quota.estimateTitle': '7d 金额预估',
    'quota.estimateDynamic': '动态参考',
    'quota.estimateEarly': '初步估算',
    'quota.estimateCollecting': '记录中',
    'quota.estimateFull': '满额 100%',
    'quota.estimateRemaining': '当前剩余',
    'quota.estimateUnit': 'USD · API 价格折算',
    'quota.estimateEvidence': '采样金额 {cost} / 消耗 {percent}% → 推算满额 100%',
    'quota.estimateCycleEvidence': '本周期已记录 {cost} / 已用 {percent}% · 随用量动态更新',
    'quota.estimateObserved': '当前已用 {used}% · 已记录金额 {cost}',
    'quota.estimateAwaitPercent': '金额持续更新；额度出现下一次有效下降后自动估算。',
    'quota.estimateAwaitCost': '本机尚无可用金额记录，读取到用量后自动估算。',
    'quota.estimateEarlyHint': '额度消耗较少，当前估算波动较大。',
    'quota.estimateRange': '取整参考 {low}–{high}（额度 ±1 个百分点）',
    'quota.estimateNote': '按本周期本机金额外推的 API 等价价值，非订阅余额；其他设备、模型组合及额度同步延迟会影响结果。',
    'quota.updatedAt': '上次更新 {time}',
    'quota.dismissHint': '鼠标移开后自动收起，也可按 Esc 关闭',
    // 额度槽位切到「积分」形态时（接 WorkBuddy 这类）用的文案。上面的
    // quota.title / quota.open / quota.estimate* 都是 Codex 专属，不能复用。
    'quota.creditBadgeLabel': '剩余积分',
    'quota.creditTitle': '{name} 积分',
    'quota.creditOpen': '查看积分消耗与剩余',
    'quota.creditToday': '今日消耗',
    'quota.creditUsed': '本期已用',
    'quota.creditRemaining': '剩余',
    'quota.creditMonthly': '每期总量',
    'quota.creditReset': '每月 {day} 日重置（本期自 {start} 起）',
    'quota.creditUnset': '还没填每期积分总量 —— 在「设置 → 积分额度」里填一次，这里就会显示剩余。',
    'quota.creditSource': '{name} 的积分由本机计量台账统计，不含其它 Agent。',
    'quota.creditAria': '{name} 积分剩余 {value}',
    'quota.creditAriaUnset': '{name} 积分：还没填每期总量',

    // ── permission / ask cards ──────────────────────────────────────────────
    'perm.runCommand': '运行命令：',
    'perm.editFile': '修改文件：',
    'perm.readFile': '读取文件：',
    'perm.fetchUrl': '抓取网页：',
    'perm.webSearch': '联网搜索：',
    'perm.needsApproval': ' 需要授权',
    'perm.modePlan': '🅿️ 切到计划模式',
    'perm.modeAcceptEdits': '✍️ 自动接受编辑',
    'perm.modeOther': '设为 ',
    'perm.alwaysAllow': '🔓 始终允许：',
    'perm.thisAction': '此操作',
    'perm.allow': '✅ 允许',
    'perm.deny': '⛔ 拒绝',
    'perm.planHeader': '方案评审',
    'perm.planQuestion': '请审阅这个方案',
    'perm.planApprove': '✅ 批准方案',
    'perm.askQuestion': '需要你回答',
    'perm.continueQuestion': '{who} 在等你回复',

    // ── ask panel (renderer) ────────────────────────────────────────────────
    'ask.needAnswer': '需要你回答',
    'ask.multiHint': '可多选（点选多个）',
    'ask.singleHint': '单选一项',
    'ask.placeholder': '输入自定义回答…',
    'ask.emptyWarn': '⚠️ 还没输入内容，是不是忘了填？',
    'ask.submitted': '✅ 已提交回答',
    'ask.needPerm': '需要授权',
    'ask.needPermQ': '需要你授权',
    'ask.waitingReply': 'Claude 在等你回复',
    'ask.planLabel': '方案评审',
    'ask.planQ': '请审阅这个方案',
    'ask.approve': '✅ 批准方案',
    'ask.approved': '✅ 已批准方案',
    'ask.reject': '✏️ 打回并反馈',
    'ask.rejected': '✏️ 已打回方案',
    'ask.rejectPlaceholder': '可写修改意见，打回让 Claude 改…',
    'ask.allowed': '✅ 已允许',
    'ask.denied': '⛔ 已拒绝',
    'ask.remembered': '🔓 已记住（始终允许）',
    'ask.toTerminal': '💬 已带你去终端',
    'ask.expired': '⚠️ 请求已失效，没有执行授权',
    'ask.decisionFailed': '⚠️ 未能提交决定，请重试',
    'ask.needsInput': '需要输入',
    'ask.back': '返回',
    'ask.submit': '提交回答',
    'ask.next': '下一步 ›',
    'ask.other': '其他',
    'ask.goTerminal': '💬 去终端',
    'ask.kindPerm': '授权',
    'ask.kindContinue': '回复',
    'ask.kindPlan': '方案',
    'ask.kindChoice': '选择',
    'ask.needHandling': '需要你处理',
    'ask.goReply': '💬 去这个会话回复 →',

    // ── session labels ──────────────────────────────────────────────────────
    'sess.fallbackName': '会话',

    'bub.loved': '🥰 谢谢夸奖！',
    'bub.sad': '😢 别生气…',
    'bub.ack': '✨ 收到！',
    'bub.newTask': '📨 收到新任务！',
    'bub.roundDone': '✅ 这一轮搞定啦！',
    'bub.bigDone': '🎉 大任务搞定！({ops}步)',
    'bub.error': '😵 出了点状况，在想办法…',
    'bub.waitYou': '✋ {project} {wait}',
    'bub.needReply': '💬 {project} 等你回复',
    'bub.greet': '👋 {project} 新会话，你好！',
    'bub.slowCmd': '💦 这条命令有点久，稍等…',
    'bub.online': '打工喵上线，开始盯所有 AI 任务啦！',

    // ── purr payday easter egg ──────────────────────────────────────────────
    'purr.title': '🐾 今日工资条',
    'purr.first': '呼噜……今天陪你跑了 {rounds} 轮，处理 {tokens} tokens，缓存命中 {cacheRate}%。摸鱼许可已批准五分钟。',
    'purr.empty': '呼噜……今天还没开工，喵先陪你坐会儿。',
    'purr.repeat': '呼噜……今日工资条已经发过啦，喵继续陪你待命。',
    'purr.hint': '长按喵，可查看今日陪伴工资条',
    'purr.ariaLabel': '今日陪伴工资条',

    // ── radial menu ─────────────────────────────────────────────────────────
    'bub.xiabanLunch1': '🍚 午饭铃响啦！保存好进度，先去干饭～',
    'bub.xiabanLunch2': '🍱 上午巡逻结束，工位我看着，你去吃饭吧！',
    'bub.xiabanLunch3': '🥢 到饭点啦，代码不会趁你吃饭时长腿跑掉的。',
    'bub.xiabanEvening1': '🍜 下班时间到！今天的 bug 留给明天，先去干饭～',
    'bub.xiabanEvening2': '🌃 工位已由喵接管，放心下班，记得按时吃饭！',
    'bub.xiabanEvening3': '🔔 收工收工！再不走，晚饭就要开始等你回复了。',

    // ── left-click work peek ───────────────────────────────────────────────
    'peek.aria': '工作速览',
    'peek.close': '关闭工作速览',
    'peek.focus': '打开当前会话',
    'peek.focusFailed': '没能打开这个会话，请在对应 Agent 中手动打开',
    'peek.viewOnly': '该会话没有可用的窗口定位信息，点击查看详情',
    'peek.panel': '查看详情',
    'peek.idleTitle': '暂时没有任务',
    'peek.idleSub': '打工喵正在待命',
    'peek.sleepingSub': '工位已由喵接管',
    'peek.multiTitle': '{count} 个任务正在进行',
    'peek.attentionTitle': '{count} 件事需要你处理',
    'peek.errorTitle': '{count} 个任务遇到问题',
    'peek.multiSub': '点击任务可定位到对应会话',
    'peek.multiSubDetails': '部分任务没有窗口定位信息，可点击查看详情',
    // 2026-09-16：去掉了 {agent} 前缀。Agent 由速览行首的彩色图标表示，
    // 标题这里只留项目名（这一支只在单会话时出现，下面那行已经有图标了）。
    'peek.sessionSub': '{project}',
    'peek.today': '今日 {rounds} 轮 · {tokens} tokens · API 等价 {cost}',
    'peek.running': '运行中 {running} · 等待你 {waiting} · 今日 {rounds} 轮',
    'peek.more': '另有 {count} 个任务，可在详情中查看',
    'peek.elapsed': '{time}',
    'peek.updated': '{time}前更新',
    'peek.errorDetail': '任务执行异常，可打开会话查看',
    'peek.done': '刚完成',
    'peek.interrupted': '已中断',
    'peek.unknownProject': '未命名会话',

    'menu.panel': '详情',
    'menu.privacy': '隐私',
    'menu.collapse': '收起',

    // ── 状态胶囊（喵头顶那条）────────────────────────────────────────────────
    // 多任务时把「×N」缀在状态词后面，而不是拿「N 个任务」把状态词整段换掉 ——
    // 后者会让「清理上下文」在两个会话同时忙时彻底消失（2026-09-16 实测）。
    'capsule.multiSuffix': ' ×{count}',
    'capsule.multiTitle': '{state} · 共 {count} 个任务',

    // ── action center ───────────────────────────────────────────────────────
    'action.title': '🗒️ 行动中心',
    'action.close': '关闭',
    'action.needYou': '🔔 需要你处理',
    'action.panel': '📊 详情',
    'action.notepadTitle': '行动中心',

    // ── detail panel ────────────────────────────────────────────────────────
    'panel.waitingSession': '等待会话…',
    'panel.close': '关闭',
    'panel.usageTrend': '用量趋势',
    'panel.metricTokens': 'Token',
    'panel.metricCost': '费用',
    'panel.rangeToday': '今日',
    'panel.range7d': '7天',
    'panel.range30d': '30天',
    'panel.hourUnit': '点',
    'panel.tokIn': '输入',
    'panel.tokOut': '输出',
    'panel.tokCacheWrite5m': '缓存写入（5m）',
    'panel.tokCacheWrite1h': '缓存写入（1h）',
    'panel.tokCacheRead': '缓存读取',
    'panel.msgRounds': '消息轮次',
    'panel.activeTasks': '进行中的任务',
    'panel.noActiveSession': '暂无活跃会话',
    'panel.byModel': '按模型（分）',
    'panel.noData': '暂无数据',
    'panel.liveOps': '实时操作',
    'panel.waitingOps': '等待操作…',

    // 新增统计相关
    'panel.cacheHitRate': '缓存命中率',
    'panel.cacheTokens': '缓存读取',
    'panel.cacheInputTotal': '输入总量',
    'panel.lifetimeStats': '累计统计',
    'panel.lifetimeCost': '累计费用',
    'panel.lifetimeTokens': '累计 Tokens',
    'panel.lifetimeMsgs': '累计轮次',


  };

  const DICT = { zh };

  function fill(str, vars) {
    if (!vars) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  }

  // Missing keys fall back to the key itself rather than to a blank label.
  function t(key, vars) {
    const raw = DICT.zh[key];
    if (raw === undefined) return key;
    return fill(raw, vars);
  }

  function backgroundStatus(session) {
    const normalize = (value) => {
      const count = Number(value);
      return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    };
    const tasks = normalize(session && session.backgroundTasksCount);
    const crons = normalize(session && session.sessionCronsCount);
    if (tasks > 0 && crons > 0) return t('background.mixed', { tasks, crons });
    if (tasks > 0) return t('background.tasks', { count: tasks });
    if (crons > 0) return t('background.crons', { count: crons });
    return '';
  }

  return { DICT, t, backgroundStatus };
});
