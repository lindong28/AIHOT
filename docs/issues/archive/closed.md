# 已关闭问题

## ISSUE-GATEWAY-20261003-fd64：Gateway 安装覆盖文件句柄上限

- 状态：resolved（2026-10-03）；负责人：个人 Gateway 部署维护者。
- 现场：2026-10-03 自托管 Qwen 的模型管理线程因 `Too many open files` 退出，阻塞全量回填；Mac launchd 默认 maxfiles 256，服务原无覆盖。现场 plist 设置 soft NumberOfFiles 4096 并重启后，路由及新闻终态增量恢复，详见 [回填运维](../../operations/backfill.md#qwen-路由不可用的现场恢复)。
- 原问题：共享 `llm-gateway/install.sh` 重建 Darwin plist 时会丢失现场覆盖。
- 修复：共享安装器支持可选 `LLM_GATEWAY_LAUNCHD_NOFILE`；个人 `ai-agent-config/llm-gateway/install.sh` 每次完整安装固定传入 4096。两仓须同步更新，直接运行共享安装器仍须显式传参。模型、额度与未知回执语义不变。
- 本地提交：共享 Gateway `16ddb98`、个人配置 `24f6e1bd`，均已快进整合至本地 main；未 push。
- 验证：隔离 HOME 下用合成配置从个人入口连续安装两次，生成的 soft limit 均为 4096；复用生成定义的独立 launchd 进程实际读取 RLIMIT_NOFILE soft=4096，并以 exit 0 结束。共享生命周期 52 项、个人配置 9 项测试通过，含两种有效上限、空值、7 种非法值及 Darwin/Linux 渲染分支；本轮未重装生产服务。证据在主 checkout `.data/gateway-nofile-20261003/`。4096 的长期容量尚未验证。

## HARNESS-20261018-storage-followthrough：存储治理剩余项需要可执行的处置与验收

- 状态：resolved（2026-10-18）；负责人：存储治理 executor 与 service-workflows 维护者。以下保留原诊断与优先级讨论，关闭依据见末尾。
- 项目证据：[存储 spec](../../operations/storage.md) 与 [生命周期 issue](../general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大) 明确保留缓存预算、运行明细期限、备份恢复及告警等待办。生产观察截至 2026-10-17；本轮没有刷新生产。单副本与无效更新优化已完成，不代表长期容量已受控；spec 完成也不等于全部产品缺口清零。
- 当前机制：已读取 service-workflows 的 storage-analysis、audit-storage、optimize-storage、sync-storage-spec，以及 agent-harness-workflows 的 diagnose-harness、improve-skill、maintenance-validation。现有正文已要求查保留边界、调度及近期执行结果、失败重试、成本和未完成项归属；通用 Surface Choices 与交付对账已有决策和收尾责任。不能将本案例直接归因为缺少这些规则，也未还原此前每次加载和执行过程。
- 待检解释：领域入口允许把多个问题记为待定，但缺口盘点到具体处置的呈现仍可加强。项目明确的未知项是已知未完成，不是本轮新发现；未设 TTL 也不自动等于必须删除，有价值的长期资料可以继续增长。此前应否继续、哪些取舍已实际询问，需按相应原始 turn 核对，当前证据不足以断言统一根因。
- 改进候选：在现有 storage-analysis 中把每个影响目标的缺口接到明确处置（已满足、授权内实施、具体用户取舍、证据不足或明确范围外），复用既有授权规则；optimize-storage 开始和结束核同一范围，避免把局部改善代替整体目标；sync-storage-spec 区分批准要求、实现、运行观察与后续复核条件，不新增第二台账或固定 TTL。缓存需评估容量与峰值，长期保留数据需评估预算或扩容/分层触发条件；不是所有数据必须封顶。
- 后续动作：executor 先形成用途驱动的保留建议与消费者影响，真正需要用户决定时呈现具体推荐；无法立刻确认的运行效果注明观察窗口、责任方与恢复入口，不凭文档新增日期刷新观察。共享指令修订保持最窄范围，不预设新服务、OLAP、对象存储、hook 或常驻 agent。
- 验证建议：复用本案例的冻结事实检验是否能产出具体处置并区分长期有价值数据、可再生缓存、失败清理和只读请求；文本检查不能证明行为改善。本轮未运行行为实验，改进收益未验证。
- 检索：当前项目无既有 harness-issues.md；定向查询 ai-agent-config 的 open 与 archive/closed.md 中 storage/存储，已核 HARNESS-20261017-storage-lifecycle-entry 的关闭只表示组合入口已实现，不表示 AIHOT 存储问题已清零。本条保留项目特有证据，具体共享方法仍归原 owner。

### 2026-10-18：按当前规模校准优先级

用户指出上述建议包含长尾完善，要求把当前必要性与工程完整性分开，方便快速判断。此前重点放在逐项闭合，仍可能将整份待办推入实施；本次修正为先判断是否值得现在做，再处理选中的项。项目最新读数与分级见[存储 spec](../../operations/storage.md#当前规模下的处理优先级)。

当前共享 storage-analysis 主要问用途、占用、增长和执行，audit-storage 要求按影响与依赖排序；通用 nonfunctional-requirements 与 rigor-tiers 已要求不自行加码。建议在领域分析的输出处引用现有最低充分原则，明确区分“立即修复、近期小改或确认、条件触发、暂缓/现状适用”，同时给出证据、最小动作、工作量与维护成本及升级条件；不使用机械分数，不强制每档有项目，未知项不自动判高优先。该层级是行动优先级，不替代安全、授权或数据完整性边界。

sync-storage-spec 保存当前优先级及重评条件；optimize-storage 只推进本次选中且已授权的项，暂缓项不作为交付阻塞。改进验收需包括低负载且空间充裕、清理正常时不提出大规模建设的合法结果，及真实空间/清理故障时及时升级的反例。本轮只修改诊断记录，未改共享指令、运行配置或保留策略；行为收益未验证。

### 2026-10-18：完成接续修复

核最新 harness 后复用已有基础分层、同范围验收与 improve-skill 接续，仅在 storage-analysis 补具体处置及重评条件，optimize-storage 与 sync-storage-spec 薄引用；决定见 ai-agent-config 的 docs/adr/20261018-2f19-storage-disposition.md。本轮在 AIHOT 核消费者和实际过期候选，用户分别选择暂缓新增明细期限、暂缓备份实施，已同步[当前 spec](../../operations/storage.md#2026-10-18-接续核对与具体处置)。

一轮独立变更审查提出当前备份优先级仍指向旧未知状态，已按实际回执同步该行；源码语义核对和 diff 检查通过。此为一个有既知背景的实际应用，不是独立盲验或旧新版因果比较；长期遵循效果未核实。关闭只覆盖指令接续及本案例具体处置，产品备份和其它生命周期缺口仍在[原 issue](../general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大)，没有新增生产删除或备份机制。
