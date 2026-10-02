# 历史回填启动决定（2026-10-02）

读者：开发者与迁移维护者。状态：决定已通过一轮 L1 独立审查；代码已准备、统一审查中，部署与真实执行验收尚待完成，本文不是上线完成证明。

本文替代[2026-10-01 决定](20261001-backfill-design.md)中“所有回填角色仅限 self-hosted、禁止订阅 fallback”及“本轮仅提供手动有界执行”的边界。原文完整性、固定 hash、连续 UTC 日期、排除旧衍生数据、独立预算与未知回执不得透明重试的要求保持有效。运维入口见[历史原文回填](../operations/backfill.md)。

## 用户授权与决定

用户允许回填 GLM 使用与线上相同的订阅来源，明确为 `personal_zai`、`personal_ark`，没有开放 Qwen 或 DeepSeek 的商业 API；并授权整理完整连续原始材料、建立批次、持续执行及展示进度。该授权不把待审核材料自动变成合格原文，不取消模型请求的预算和回执约束。

| 范围 | 采用的决定 |
|---|---|
| Gateway 路由限制 | 请求成对携带 `X-LLM-Allowed-Routes`（JSON 数组）与 `X-LLM-Registry-Revision`。服务端在同一个 registry snapshot 内先核 revision，再将候选限制到允许集合；保留现有默认 fallback 机制与调用方模型参数配置。 |
| 在线预检 | 提供按 project/model 限定的 HTTP discovery，只投影核验所需的安全字段；预检不发出模型调用。 |
| 回填绑定 | 允许多个候选；GLM 顺序为 self-hosted → Zai → Ark，其他模型仍只允许 self-hosted。逐个核验候选身份合法，至少一个候选可用即可；尚未部署的 GLM 自托管候选不要求 ready。 |
| 持续执行 | 有界 drain 配合 systemd timer。drain 只选 `ready`、`waiting_models`、`running`；advisory lock 忙时跳过，取得锁后才恢复 `running`。 |
| 失败处理 | 不自动重试 `needs_attention` 或未知回执；原有核账后恢复的边界继续生效。 |
| 无人值守前提 | 正式无人值守前，验收 Mac 上现有 im-notify 与 launchd 监督的真实投递链路。 |

## 备选与取舍

| 备选 | 本次未采用的原因 |
|---|---|
| AIHOT 客户端自行做 fallback | 重复 Gateway 的重试职责，并增加未知回执情况下重复请求的风险。 |
| 不固定允许路由，直接沿用默认选路 | registry 日后增加付费候选时，可能超出本次只开放两个 GLM 订阅来源的授权。 |
| 在 Mac 执行回填 | 需要新增数据库隧道作为生产执行依赖；当前决定将执行留在生产侧，Mac 负责现有监督通知。 |
| 静态 discovery 文件 | registry revision 变化时需要人工续更；按范围投影的 HTTP discovery 可直接核验服务当前快照。 |

因此采用服务端最小路由限定和 HTTP discovery，不另建客户端路由器，不改 Gateway 默认 fallback 政策。

## 审查、实现补正与验证边界

决定经独立 reviewer `/root/backfill_decision_review` 一轮 L1 审查，七项成立后放行。审查放行只覆盖上述决定，实施时必须兑现同快照核验、允许集合约束和锁取得后的状态恢复；代码和真实链路仍需各自验证。

本节运行快照来自实施主线程的现场读数：2026-10-02 06:46 UTC，回填 run 为空、receipt 为 0；生产 Qwen/DeepSeek GPU 可用，GLM 自托管探测失败。该读数不证明订阅 fallback、完整流水线或持续执行已经验收。

实施基线 `9e0483f` 的回填 gateway 是 CLI discovery、严格 self-hosted 与有界单次 run。本轮已准备多候选绑定、HTTP 预检、请求路由与 revision 绑定、响应身份核验及 drain/timer 接续，代码统一审查与部署验收尚未完成。HTTP 预检使用 `GET /v1/discovery?model=逻辑ID` 与 `X-LLM-Project`，核对 version 2 的逐模型安全投影；CLI 仅在显式配置时保留。

原始材料启动批现已由迁移主线程逐篇审核：54 候选中 44 条 `complete`、10 条 `unverified`，批准 2026-08-17/18/19（UTC）每日 9/16/19 条。清单位于 `.data/backfill-launch-20261002/first-batch-approved.jsonl`，尚未线上导入，不是处理完成量。169,805 原始行与此前 169,100 canonical 候选均不能作为批准进度分母；全历史尚未全审，后续审核归 AIHOT 迁移维护者，沿[运维待办](../operations/backfill.md#当前批准的启动批)接续。

部署主线程实测 Qwen DGX0026 4 GPU、DeepSeek DGX0022 8 GPU，均为 `max-num-seqs=16`、`max-model-len=32768`，与线上共享。回填容量取并发 8 留出实时余量；首次五角色端到端验收前逐条运行，观察到同一干净样本五角色成功后立即释放到 8，不等待整批。预筛过滤不算这次释放条件，真实吞吐仍待验证。

| 未完成项 | 归属与完成证据 |
|---|---|
| Gateway 限定与 HTTP discovery | Gateway 实施任务：实现和测试 revision 不符、集合越界、合法 fallback，并核验生产 HTTP 投影。 |
| AIHOT 多候选与 drain | AIHOT 实施任务：核验候选身份、实际响应身份、锁忙跳过与恢复，并保留未知回执阻断。 |
| 首批导入与后续原文 | AIHOT 迁移任务：启动批 44 条已批准，待生产导入冻结分母；其余历史继续审核，不沿用全量候选数。 |
| 真实模型与公开结果 | AIHOT 迁移任务：取得五角色真实响应、Gateway 账本关联、最终公开结果与批次进度。 |
| 持续运行与监督投递 | AIHOT 运维任务：验收有界 drain、timer 接续及 Mac 通知；未验收前不宣称无人值守就绪。 |
