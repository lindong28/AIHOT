# 文档索引

本文件供维护文档的 Agent 定位内容；人类阅读入口是 [README.md](README.md)。修改文档时，当前实现说明、两仓比较快照与未来开发方向分别放在下列对应文件中。

| 文件 | 读者与用途 |
|---|---|
| [README.md](README.md) | 所有读者：按任务选择阅读入口 |
| [CLAUDE.md](CLAUDE.md) | Agent：本文档索引 |
| [deploy.md](deploy.md) | 站点运营者：环境配置、本机和 Docker 部署 |
| [migration.md](migration.md) | 维护者：当前迁移状态、阶段记录与剩余缺口 |
| [customize.md](customize.md) | 站点定制者：调整行业、品牌、主题与模块 |
| [sources.md](sources.md) | 站点运营者：信源配置、参与方式、抓取和外部推送 |
| [operations/services.md](operations/services.md) | 维护者：生产、本机、旧站与 Wechat2RSS 服务入口 |
| [operations/production.md](operations/production.md) | 部署维护者：腾讯云发布、服务与隧道起停、公网切换及回滚 |
| [references/20261001-production-cutover.md](references/20261001-production-cutover.md) | 开发者：生产拓扑决定、停止旧链路与准备阶段记录 |
| [references/20261002-socialdata-recovery.md](references/20261002-socialdata-recovery.md) | 开发者：SocialData 增量分页、预算恢复及验证记录 |
| [operations/wechat2rss.md](operations/wechat2rss.md) | 维护者：Wechat2RSS 数据迁移、部署与原生 RSS 接入 |
| [operations/backfill.md](operations/backfill.md) | 维护者：原文审核、模型接入、有界执行与逐日进度 |
| [operations/receipt-recovery.md](operations/receipt-recovery.md) | 维护者与 Agent：旧异常的授权重放、固定批次续跑、业务结案与核账边界 |
| [references/model-configuration.md](references/model-configuration.md) | 维护者：在线/回填模型、上游参数基线与实际配置查看入口 |
| [issues/general.md](issues/general.md) | 维护者：上游未显式参数的后续配置化与 embedding 缺省分支差异 |
| [references/20261003-backfill-prefilter.md](references/20261003-backfill-prefilter.md) | 开发者：全量原文前初筛、冻结输入、回执恢复与准备计数边界 |
| [references/20261001-backfill-design.md](references/20261001-backfill-design.md) | 开发者：个人 Gateway 回填隔离与边界决定 |
| [references/20261002-backfill-launch.md](references/20261002-backfill-launch.md) | 开发者：GLM 订阅候选、限定路由、持续回填决定与待验收边界 |
| [references/20261002-receipt-recovery.md](references/20261002-receipt-recovery.md) | 开发者：Gateway 未派发判据、核账恢复边界与验证记录 |
| [selection.md](selection.md) | 站点运营者：精选逻辑、样本准备与校准 |
| [leaderboard.md](leaderboard.md) | 站点运营者：模型排行榜与 Codex 重置监控 |
| [architecture.md](architecture.md) | 开发者：当前服务、数据流、算法阶段与代码入口 |
| [development.md](development.md) | 开发者：基于 AIHOT 迭代 AI Radar 的能力迁移地图与待定边界 |
| [references/ai-radar-comparison.md](references/ai-radar-comparison.md) | 开发者：标注版本的两仓数据源、架构、算法及评测资产对比 |
| [references/20261001-history-backfill-audit.md](references/20261001-history-backfill-audit.md) | 开发者：原始历史候选、连续性、清洗边界和 AIHOT 回填 token/费用情景 |
| [assets/](assets/) | 根 README 引用的上游产品截图与展示图片 |

根目录 [README.md](../README.md) 负责项目定位和运行入口；[AGENTS.md](../AGENTS.md) 负责项目级开发约束。这里不另立或复制开发政策。
