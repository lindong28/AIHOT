# Harness 问题

## HARNESS-20261018-storage-followthrough：存储治理剩余项需要可执行的处置与验收

- 状态：open；负责人：后续存储治理 executor 与 service-workflows 维护者；优先级：medium。本轮为诊断建议，未修改运行策略或共享指令。
- 项目证据：[存储 spec](../operations/storage.md) 与 [生命周期 issue](general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大) 明确保留缓存预算、运行明细期限、备份恢复及告警等待办。生产观察截至 2026-10-17；本轮没有刷新生产。单副本与无效更新优化已完成，不代表长期容量已受控；spec 完成也不等于全部产品缺口清零。
- 当前机制：已读取 service-workflows 的 storage-analysis、audit-storage、optimize-storage、sync-storage-spec，以及 agent-harness-workflows 的 diagnose-harness、improve-skill、maintenance-validation。现有正文已要求查保留边界、调度及近期执行结果、失败重试、成本和未完成项归属；通用 Surface Choices 与交付对账已有决策和收尾责任。不能将本案例直接归因为缺少这些规则，也未还原此前每次加载和执行过程。
- 待检解释：领域入口允许把多个问题记为待定，但缺口盘点到具体处置的呈现仍可加强。项目明确的未知项是已知未完成，不是本轮新发现；未设 TTL 也不自动等于必须删除，有价值的长期资料可以继续增长。此前应否继续、哪些取舍已实际询问，需按相应原始 turn 核对，当前证据不足以断言统一根因。
- 改进候选：在现有 storage-analysis 中把每个影响目标的缺口接到明确处置（已满足、授权内实施、具体用户取舍、证据不足或明确范围外），复用既有授权规则；optimize-storage 开始和结束核同一范围，避免把局部改善代替整体目标；sync-storage-spec 区分批准要求、实现、运行观察与后续复核条件，不新增第二台账或固定 TTL。缓存需评估容量与峰值，长期保留数据需评估预算或扩容/分层触发条件；不是所有数据必须封顶。
- 后续动作：executor 先形成用途驱动的保留建议与消费者影响，真正需要用户决定时呈现具体推荐；无法立刻确认的运行效果注明观察窗口、责任方与恢复入口，不凭文档新增日期刷新观察。共享指令修订保持最窄范围，不预设新服务、OLAP、对象存储、hook 或常驻 agent。
- 验证建议：复用本案例的冻结事实检验是否能产出具体处置并区分长期有价值数据、可再生缓存、失败清理和只读请求；文本检查不能证明行为改善。本轮未运行行为实验，改进收益未验证。
- 检索：当前项目无既有 harness-issues.md；定向查询 ai-agent-config 的 open 与 archive/closed.md 中 storage/存储，已核 HARNESS-20261017-storage-lifecycle-entry 的关闭只表示组合入口已实现，不表示 AIHOT 存储问题已清零。本条保留项目特有证据，具体共享方法仍归原 owner。
