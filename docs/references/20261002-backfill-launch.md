# 历史回填启动决定（2026-10-02）

模型策略已由 [2026-10-03 决定](20261003-backfill-deepseek.md)部分替代：新回填评分与理解改用 DeepSeek V4.1 Flash，连同摘要限定腾讯 VOD 公司账户；以下 GLM 订阅路由与实测记录保留为历史快照。

读者：开发者与迁移维护者。状态：决定经一轮 L1 独立审查，AIHOT `bbbb789` 已发布为生产 `backfill-bbbb789`；个人 Gateway `2d5d4aab549ae355339509469af60703d85f11d9` 已重装运行。启动批已导入并处理，生产 timer 与 Mac 监督已启用；本记录不代表全部历史完成。

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

以下上线读数由实施主线程在生产、Gateway 账本和浏览器取得。启动前 2026-10-02 06:46 UTC 的 run 空、receipt 0 是历史起点，已被下述首批运行状态更新。

实施基线 `9e0483f` 的回填 gateway 是 CLI discovery、严格 self-hosted 与有界单次 run。本轮上线多候选绑定、HTTP 预检、请求路由与 revision 绑定、响应身份核验及 drain/timer 接续。生产 `GET /v1/discovery?model=逻辑ID` 与 `X-LLM-Project` 预检已通过，未部署的 GLM 自托管候选正确为不可用；Zai → Ark fallback 在真实运行中发生 4 次，均 HTTP 429，未证明成功后备能力。

原始材料启动批已由迁移主线程逐篇审核并导入：54 候选中 44 条 `complete`、10 条 `unverified` 被排除，批准 2026-08-17/18/19（UTC）每日 9/16/19 条。清单为 `.data/backfill-launch-20261002/first-batch-approved.jsonl`，manifest hash `7af3dcb5376c0eb80cea8a1c0b4865275546fbcbcc1f8ecabec75350c5ae188e`，批次 ID `f8ff402f-fb8c-47a2-8170-d2fb9268e641`。

原始 raw/differences 包分别为 169,936/3,265 行，按旧 ID 诊断合并为 170,191 条，排除 386 条 2026-10-01 及以后材料后为 169,805 条；未按 native identity 去重，不是原始行数。此前 canonical 169,100 候选为不同口径，不能混用，也不能作为批准进度分母。全历史尚未全审，后续审核归 AIHOT 迁移维护者，沿[运维待办](../operations/backfill.md#当前批准的启动批)接续。

部署主线程实测 Qwen DGX0026 4 GPU、DeepSeek DGX0022 8 GPU，均为 `max-num-seqs=16`、`max-model-len=32768`，与线上共享。回填现以并发 8 运行，整轮最多 64 条、4 批次、1500 秒。此前“同篇五角色”的释放表述有误：既有原生处理的理解与摘要是互斥写作分支，正确条件是同篇完整原生链路、已结算回执与公开结果；本轮未改变模型、门槛或用户范围。

首篇 `zkirb51bgptt3jyc9amb1tqni` 完整处理并 published，浏览器读到公开标题、正文、AI 导读与新评分；5 次 completed 回执按 exact request ID 对应 Gateway success（Qwen 预筛/结构、自托管；GLM 双评分、personal_zai；DeepSeek 摘要、自托管）。该篇未触发理解。其后 `wn3lc8ow41i5vcpinhqxnmljd` 触发理解并 published，completed request `0f8c5646-cd39-45c0-a523-acb26e5da977` 的 actual model 为 `openai/glm-5.3-flash`、profile `personal_zai`、provider `zhipu`。五角色已在批内覆盖，不能写成同篇覆盖。

2026-10-02 08:06 UTC，后台浏览器与批次状态均为 `needs_attention`：43/44（97.7%）、2/3 天，28 published、13 filtered、2 existing、1 failed，另 10 excluded。逐日 published/filtered/existing/failed 为 08-17：8/1/0/0，08-18：10/4/1/1，08-19：10/8/1/0。该分母只覆盖本启动批，不能外推全历史。

失败条目 `qb20oni3wgw91r0ih25hg37dh` 的 5 个模型回执都 completed，发布因 `Analysis not complete: unknown` 停止：既有 identity guard 拒绝原文未明写的 OpenAI 主体标题/摘要，fallback 后无可用中文文案。不是未知扣费或供应商超时，不自动重试，不放宽既有 guard。主体确认与受控重新写作归 AIHOT 迁移维护者，保留已结算回执。

本批 157 条应用回执全部 completed（预筛 42、结构 29、评分 58、理解 5、摘要 23），全部关联到 Gateway logical success，共 173 次 attempt：self-hosted 94 success；Zai 63 success、12 HTTP 429；Ark 4 HTTP 429、无 success。所有 attempt 均在调用方 allowlist 内，无其他按量 API，最终 GLM 均由 Zai 完成。不能由 429 推断余额耗尽或配置不支持，限速/额度归因仍未核实。原始关联保留于主 checkout `.data/backfill-launch-20261002/receipt-ledger-acceptance.json`，不入 Git；该读数不是供应商结算账单。

生产 timer 已 install、enable、restart；Mac `live.aiplanet.aihot-backfill-probe` 从主 checkout 每 300 秒监督。真实 scheduler inactive 告警于 07:59:22 UTC、恢复通知于 08:01:10 UTC 均有 im-notify `push=sent`，恢复 probe exit 0。通知只覆盖回填监督，不外推公开站点可用性。

批次 needs_attention 告警于 08:04:24 UTC `push=sent`，08:06:07 UTC 重复探测 `push=skipped(unchanged)`，去重生效。08:07 UTC timer active/waiting，service inactive/dead、Result success、ExecMainStatus 0：有界执行器正常结束，不是崩溃；该批等待内容处置，不自动重试，新 ready 批仍可执行。

| 未完成项 | 归属与完成证据 |
|---|---|
| 单条内容处置 | AIHOT 迁移维护者：确认失败条目主体并受控重新写作，不重发已完成回执、不放宽 guard；当前批次 needs_attention 不自动接续。 |
| 全历史后续原文 | AIHOT 迁移维护者：其余历史继续逐批审核，不沿用全量候选数作为合格分母。 |
| Ark 后备能力 | Gateway 维护者：4 次真实 fallback 均 429，限速/额度归因与成功后备能力未核实；最终 GLM 由 personal_zai 完成。 |
