# 上游更新取舍（2026-10-09）

本仓库的 `fresh-main` 与 `upstream/main` 没有共同 Git 祖先。同步时先将 `origin/main` 快进到 `4f6e35c`，再对照 `upstream/main` 的 `6997003`，按功能移植而非合并无关历史。

已移植的跨平台修复：Codex 重复额度快照不再重复计算 token 和费用、Claude 嵌套子代理 transcript 的用量扫描、WorkBuddy 流式缓存用量的费用修正、opencode 显式零费用、统计中空 `inputTotal` 的处理，以及上游的 sharp / libvips 和构建依赖安全更新。Codex 会话目录与启动状态的 macOS 修复来自本分支，不依赖上游重命名。

未直接移植 AgentPaw 1.9.x 的品牌更换、多角色素材、任务中心和用量分析 UI：这些变动覆盖 macOS 分支的桌宠布局、发布脚本和大量测试，不能当作独立补丁安全套用。ZCode 与 TRAE 新版日志的功能主要面向尚未适配的 Windows 客户端；保留在上游，待对应 macOS 接入项目单独评估。上游 Codex 历史账本 v5 涉及已有用户数据迁移，本次只移植新事件去重，不自动重建或重置现有账本。
