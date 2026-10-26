# 两个公众号的近一年回填

目标：回填潜云思绪（radar-mp-3014313426）和西风的指南（radar-mp-3690410656）2025-10-26 至 2026-10-26 的文章。当前输入为已取得的群发文章子集，不代表全年目录完整。

## 执行决定

2026-10-26 用户明确选择“使用百炼订阅（推荐）”：仅本批 21 篇可用正文使用个人百炼订阅 Qwen 主路由；DeepSeek 腾讯 VOD、预算、回执及历史投影隔离沿用既有机制。独立 L1 决策审查七项成立，无 blocker、无应修。

新批的 prefilter、structure 均为 qwen3.8-flash，唯一候选 personal_bailian_token_plan/qwen3.8-flash/stream，actual model openai/qwen3.8-flash、provider bailian-token-plan、profile personal_bailian_token_plan，discovery 必须确认 personal_subscription；没有 fallbackRoutes。该能力不授权未来批次，不改变共享默认模板或旧 run，不重放 unknown/pending 回执。生产使用发布 HEAD 的专用 release 执行目录，不切换 current 或重启在线服务。

## 输入和缺口

已取得 27 篇年内候选：潜云思绪 16 篇（1 篇近期已采集，15 篇待回填），西风的指南 11 篇（6 篇正文可用，5 篇只有导语）。26 条原生历史清单包括 21 ready 和 5 original_body_incomplete；未调用模型时冻结的 SHA-256 为 a514794a44c4cdd1c19f35f5b5827f439c3dfd1ff760271c0e6a6d0d7c365272。输入及原文证据存于操作主机 ~/.local/state/aihot-wechat-year-backfill/20261026/，正文不进 Git。

5 篇缺口为《讲一期绝大多数人都看不懂的》《逆天改命的七件事》《掀桌子重开，不接老登们的盘，能否成为年轻人的新赛道？》《没背景的孩子，怎么才能给自己谋个前途？》《一代版本一代神，比阶层更重要的，是分析社会阶段》。保留失败条目，不把导语当完整正文；付费或删除原因未核实。

Wechat2RSS 的[官方说明](https://github.com/ttttmr/wechat2rss/blob/master/deploy/qa.md)限制首次拉取最近 20 篇且只覆盖群发，无历史分页。潜云思绪返回条目跨越本次起日；西风的指南仅取得 2026-08-11 起的条目，不能据此认定更早没有文章。全年目录完整性和缺正文恢复仍未完成。

## 验收状态

执行前：精确主绑定尚待实现验证和生产预检，21 篇尚未处理。运行后在本节记录真实 run、调用身份、终态和公开结果，不以代码审查或导入成功代替验收。

本机验证：typecheck、Web 构建、19 项 Web 测试和站点 smoke 通过；后端 441 项中 413 通过、27 失败、1 跳过。7 项百炼绑定/回执回归全部通过，包含本次新增的 2 项；全量失败为 26 项模型安全阀 fixture 和 1 项本机 Python SQLite 能力问题，按 [既有测试问题](../issues/general.md#issue-test-20261013-valves全量测试与关闭模型安全阀的开发约束不一致) 保留，不为全绿开启外部调用。新绑定正例在改动前因 schema 拒绝变红；独立 reviewer 复跑 4 项纯/mock 路由测试通过。测试解析到本私有 worktree 的 packages/backend，回归过程没有调用真实模型。
