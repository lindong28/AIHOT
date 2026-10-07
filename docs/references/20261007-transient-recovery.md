# 暂态请求恢复与计数边界

读者：维护付费调用、实时任务与历史回填的开发者。运营入口见[回执恢复](../operations/receipt-recovery.md)。本文记录 2026-10-07 的实现边界与生产部署；业务恢复不表示历史费用已经核清。

## 采用的恢复方式

目标是让 `ledger_unavailable` 和暂态网络失败在有界范围内自动继续，同时保留每次实际 provider attempt 和未知费用。Gateway SDK 的 `requestRecovery` 默认关闭；AIHOT 显式启用它，环境变量 `LLM_GATEWAY_REQUEST_RECOVERY_ENABLED=false` 可关闭。SDK 先检查 `/api/capabilities` 的 `request_recovery_versions` 是否含 `1`，请求带 `X-LLM-Request-Recovery: 1`。不支持时拒绝派发，不静默退成无保护重放。

恢复信息绑定确切的 `logical_request_id`，AIHOT 验证版本、action 与退避秒数；格式错误或 UUID 不符不能授予再次调用权。明确的可恢复传输异常只允许重送原 UUID，不能自行升级为新 generation。

| 恢复 action | AIHOT 行为 | 计数与历史 |
| --- | --- | --- |
| `retry_same_request` | 保存退避时间，任务再次进入时使用数据库里的原 UUID | 同 generation、同 `receipt_attempts` 行，增加 `recovery_sends`；含首次最多三次发送 |
| `retry_new_request` | 退避后建立新 UUID，仍执行预算检查 | 新增 generation / receipt attempt；与 JSON 校验失败共用生成上限，旧 unknown 不改写为成功或免费 |
| `stop` | 停止该回执的自动业务恢复 | 保留 attempt、错误与未知费用，不把永久拒绝变成暂态重试 |

`LLM_JSON_MAX_ATTEMPTS` 默认三次 generation，Gateway `maxAttempts` 默认每个逻辑请求三个 provider attempt；默认合计最多九次 provider attempt。HTTP 发送重试用于恢复同一逻辑请求，不额外乘出二十七次 provider attempt。现有模型、provider、funding 和路由限制继续生效，不新增 fallback 授权。

## Gateway 与 AIHOT 各自保存什么

Gateway 对项目、UUID、请求体、endpoint 和调用方控制字段建立 fingerprint；同 UUID 的不同输入不能借恢复改成另一笔请求。已存在但没有 fingerprint 的旧 ledger UUID 不接受新协议重放。Gateway 保存响应 checkpoint，重入时先恢复可补齐的终态账本，再返回已保存答案；尚无答案时仍受同 UUID 原 provider attempt 预算约束。checkpoint 不是派发或费用的独立权威，账本仍拥有这些事实。

AIHOT 的迁移 `database/migrations/0047_receipt_transient_recovery.sql` 增加主回执的 `retry_after`、`recovery_exhausted`，以及 attempt 的 `recovery_sends`、`recovery_action`。退避、发送次数与生成次数落库，进程重入不会重新获得额度。未过期的 pending lease 防止并发 worker 重复派发；stale placeholder 只有原请求已持久化 recovery v1 标记时才获得同 UUID 恢复资格。

实时业务沿用队列调度，回填沿用原 runner，并以 `ReceiptRetryError.retryAfterSeconds` 设置 item 的 `retry_after`。恢复不更改回填 manifest、业务 identity 或并发配置。成功 generation 可完成主回执；其他 generation 的失败、unknown、响应与费用证据仍保留。同 UUID 的 HTTP 发送不是额外的 AIHOT generation，具体 provider attempt 以 Gateway 账本为准。

## 兼容、升级与未验证边界

先升级支持 recovery v1 的 Gateway 与配套 SDK，再应用 AIHOT 增量迁移及新版 worker。关闭 AIHOT 开关可停止采用该协议，但不会撤销已发请求、删除账本或自动放行旧 unknown。历史异常继续使用既有核账／显式授权重放入口，不能为清空后台自动开启新批次。

旧协议暂态积压另有 `scripts/recover-receipts.ts --transient-only`：`legacyTransientReceiptIds(jsonMaxAttempts())` 仅筛选更新时间早于十分钟前、有 Gateway UUID、未启用 recovery v1 的 unknown；要求累计 generation 未到上限、当前 attempt 未被冻结，且安全错误详情或旧版固定错误格式提供已知暂态依据。默认只读预览，显式 apply 仍需固定批次名和授权 note，沿用既有冻结与业务重放流程，保留原 attempt 和未知费用；它不授予旧 UUID 的协议重放能力。命令和续跑边界见[运维入口](../operations/receipt-recovery.md#仅筛选旧协议暂态异常)。

实现定位：`packages/backend/src/providers/gateway.ts`、`gateway-error.ts`、`receipts.ts` 负责协商、恢复信息校验和持久化边界；`packages/backend/src/backfill/runs.ts` 负责回填退避；`packages/backend/src/admin/receipt-batch-recovery.ts` 负责旧协议暂态候选筛选。Gateway 对应实现在其仓库 `clients/typescript/index.js`、`src/llm_gateway/request_recovery.py` 与 `src/llm_gateway/server.py`。

离线验证用例见 `tests/receipt-transient-recovery.test.ts`，涵盖两个重试 action、共享生成上限、stop、无效恢复信息、并发 lease、stale placeholder 与未启用协议的保护；`tests/gateway.test.ts` 包含实时和固定路由回填的 HTTP 恢复用例，`tests/backfill.test.ts` 包含 pending 退避后继续处理用例。执行结果及生产观察范围如下，不外推为所有 provider 故障组合或无人值守告警均已验收。

本轮恢复机制不等于修复了账本锁竞争根因。本次文档同步与离线用例未定位生产持锁者，也未取得生产锁问题消失的读数，不能由新恢复路径倒推出根因已修复。

## 部署与验证记录

2026-10-07，个人 Gateway 部署提交 `79fb8816024e62a649cbeff046a85d74c7abc5fa`，复用原 registry、credentials 与 Web 配置；运行时返回 `request_recovery_versions: [1]`，安装文件与该提交一致。AIHOT 发布目录为 `/home/ubuntu/aihot/releases/transient-recovery-20261007-971dee99`，来源 Git tree `971dee991fc2c49dca2f51d8ee8ed595a1ec446d`；后续本次文档验收补记不改变该发布代码。迁移 0047、Web 构建与 seed 完成，API、Web、worker 和 backfill timer 已恢复，公网 smoke 通过。部署没有更改模型、provider、funding 或并发配置。

离线测试使用隔离 PostgreSQL 与本地模型 stub，不访问外部 provider。后端全量套件在最后三项针对性修复之前为 369/369；最终源码的回执恢复用例 9/9、Gateway 用例 35/35、后台注意项用例 3/3，覆盖 action 分支、旧／新协议、同／新 UUID、stale sweep、能力协商失败与恢复耗尽；typecheck、Web 构建和 Web 测试 11/11 通过。Gateway 最终针对性 Python 套件 84/84、TypeScript 套件 21/21，包含并发重入、进程重启、参数冲突、响应复用与预算上限；没有外推为全仓测试全绿。既有 `test_audit_decode_releases_lock_and_keeps_original_snapshot` 在未改基线 `4532663` 同样失败，沿用 Gateway `docs/issues/general.md` 中 `ISSUE-GENERAL-20260916-53e3` 跟踪。

跨仓实际 HTTP 验证使用 AIHOT `chatJson`、打包后的 SDK 和 Gateway HTTP server：离线 provider 返回后人为令 `ledger.finish_attempt` 失败，第二个 Node 进程使用原 UUID 恢复；观测为 AIHOT 两次发送、Gateway 一次 provider 调用、一次成功 attempt，外部模型调用零次。该故障注入没有在生产执行。独立实现审查发现的 stale sweep 与能力协商身份问题均已修复并复审通过。

生产真实请求样本：实时 UUID `593a8b05-da95-4521-b4f5-36f3cf23f3fe` 的 `qwen3.8-flash` 经 `personal_self_hosted/qwen3.8-flash-next/stream` 成功；回填 UUID `1fb84b3a-b2a8-4481-a75a-51e7a33227e8` 的 `deepseek-v4.1-flash` 经现有约束 route `company_tencent_vod/deepseek-v4.1-flash/stream` 成功。两者 Gateway 账本各一个成功 attempt、usage reported、cost unknown；未知费用没有被归零。样本只证明这两条实际 route，不表示所有 fallback 已逐一验收。

经本轮授权，旧协议暂态异常冻结为固定批次 `transient-recovery-20261007`，共 308 条回执（291 条回填，另含普通文章、归组、综述和监控）；以普通目标上限 4、回填目标上限 100 接回既有执行器，不增加 worker 并发。2026-10-07T15:23Z 本批 308 条全部业务结案，恢复脚本退出 0；已恢复指原业务终态证据成立，不等于旧调用未计费。普通文章 `w1pua5r230eka1z1map9nowft` 已 analyzed，但公开详情返回 404，不能据 analyzed 推断对外发布；历史 item `x:2097662050826899698` 已 published，对应文章 `q8u2md01xuolt4l29riqedaqi` 的公网详情 API 和 `/items/` 页面均返回 200 并包含该文章身份。其余未知、永久拒绝或已达上限的回执不在本批自动放行范围内。同期后台注意项查询剩余 unknown 14、近期 failed 2，不宣称全站回执已核清。
