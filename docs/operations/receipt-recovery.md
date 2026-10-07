# 付费回执的业务恢复

后台“需要核对的付费回执”包含结果未知、近期失败及长时间未返回的请求。业务恢复和供应商核账是两件事：新闻处理成功可以结案，但不能因此推断旧调用没有计费。历史异常的授权恢复入口为 `scripts/recover-receipts.ts`，恢复关联保存在 PostgreSQL `receipt_recoveries`；原 `receipt_attempts` 和费用字段保留。新请求的有界自动恢复见下一节。

## 新请求的暂态自动恢复

新版本支持 Gateway request recovery v1：AIHOT 默认启用，可用 `LLM_GATEWAY_REQUEST_RECOVERY_ENABLED=false` 关闭。须先升级支持该能力的 Gateway 和配套 SDK，再运行 AIHOT 的 `0047_receipt_transient_recovery.sql` 增量迁移与新版 worker；能力协商不通过时不会派发模型请求。2026-10-07 已完成生产部署，验证范围见[部署记录](../references/20261007-transient-recovery.md#部署与验证记录)。

收到有效恢复指令的 `ledger_unavailable`、暂态网络错误等，由任务按持久化退避时间再进入；同一个 Gateway UUID 最多发送三次（含首次），worker 重启不会重置计数。Gateway 优先返回已保存的答案并补齐账本；尚无答案时，只能在原请求的 provider attempt 预算内继续。实时任务走原队列退避，回填 item 保持 pending 并设置 `retry_after`，不要求为每次暂态失败另建人工恢复批次。

只有 `retry_new_request` 才允许为暂态恢复创建新 UUID；它与 JSON 校验失败共享 `LLM_JSON_MAX_ATTEMPTS` 生成额度（默认三次），不能各自再取三次。默认每次生成最多三个 provider attempt，因此总上限为九次 provider attempt，同 UUID 的三次 HTTP 发送不会把它再乘三。恢复沿用既有模型、provider、funding 与路由约束，不扩大授权路线。

`stop` 或恢复额度耗尽会停止该回执的自动业务恢复；费用仍可能未知，保留原 attempt。无有效恢复指令、身份不符和未启用协议的旧 unknown 继续走核账或下文授权重放。旧 UUID 没有 Gateway fingerprint 时不能凭升级自动进入新协议。关闭开关也不清除回执或放行旧 unknown。协议、计数与验证边界见[暂态恢复说明](../references/20261007-transient-recovery.md)。

## 历史异常的预览、执行与续跑

在装好依赖并完成迁移的发布目录执行。生产连接使用 Node 的 env-file，不能 shell source 配置，也不要输出密钥。

```bash
cd /home/ubuntu/aihot/current
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts --json
```

默认只读预览，不修改数据、不调用模型。不加筛选参数时，候选为全部 unknown 和最近三天的 failed；尚在 pending 的调用不自动放行。执行必须先取得覆盖本批可能重复计费的授权，再选择一个唯一批次名并记录授权说明：

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --apply --batch receipts-20261004 \
  --note '站点所有者授权对既有异常进行一次业务重放；原费用未知保留，接受可能再次计费' \
  --limit 4 --wait-seconds 900
```

第一次执行冻结回执 ID、原 attempt 和业务目标；以后**沿用同一个批次名和命令**续跑，不会吸收后来新出现的失败，也不会再次放行本批重放后产生的新失败。进程中断后可续跑：放行、恢复记录和入队共用事务。多个恢复脚本不能同时运行。

没有候选时不创建空批次；查询不存在的批次会报错。目标缺失或无法恢复时单独标记 blocked，继续处理后续目标，不占用处理中名额。归组和综述保存实际入队或复用的 job ID，只有对应任务完成且业务结果已持久化才可据此结案。

回填 article_id 与 preparation 的候选扫描在每次预览或创建批次内合并一次，以游标每批读取 256 行，随后复用精确匹配结果，避免逐回执扫描历史库存和原文。续跑已有批次直接使用已冻结目标。

`--limit` 是本批同时在处理的业务目标上限，默认 4，范围 1–100；排队中的目标占用额度。它不是新建模型 worker 的并发数。线上分析仍由现有 worker 和预算控制，回填仍由原 runner/timer 执行；恢复会增加正常模型工作量。生产应依据共享 worker/provider 容量设置上限，不把 100 当作推荐值。`--wait-seconds` 限定本次脚本等待时间（最多一天），到期不会取消已经排入的业务任务。

只有显式传入 `--backfill-limit` 时才分开计算回填和普通任务额度：`--limit` 管普通目标，`--backfill-limit` 管回填目标，二者范围均为 1–100；不传时仍是原全局额度。2026-10-04 独立决策审查通过本批使用 `--limit 4 --backfill-limit 64`：生产普通 worker 并发为 6、回填并发及单轮上限为 64，分池不增加执行器或模型并发。目标可能关联多个 item，不能把目标额度当成调用数或单轮完成数。回退可去掉新参数，已排入的目标自然消化，不撤销任务。

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --status --batch receipts-20261004 --json
```

`--status` 核验业务结果并结案，不放行或排新任务。退出码 `0` 表示预览完成或该批全部结案；`2` 表示还有待排队、处理中或未解决项；`1` 表示执行错误。`--json` 提供逐条剩余目标和原 attempt，供 Codex／Claude 定向诊断。不能把“脚本正常退出了”或“已经排队”当作全部恢复。

## 仅筛选旧协议暂态异常

`--transient-only` 用于一次性筛选旧协议的暂态积压，不把旧 UUID 冒充 recovery v1 请求。候选须同时满足：主回执为 unknown 且有 Gateway UUID、`updated_at` 早于十分钟前、原请求未记录 recovery v1、累计 generation 次数小于 `LLM_JSON_MAX_ATTEMPTS`（默认三次），并且当前 attempt 尚未被任何恢复批次冻结。

错误证据只接受安全详情中明确可重试的 timeout／upstream_unavailable／transport_error／rate_limited，或旧版 AIHOT 自己生成的固定 Gateway 暂态 HTTP／网络错误格式；审核拒绝、未知格式和缺少暂态依据的记录不因这个开关获得重放资格。筛选上限只限制入选回执，不是批次内新闻条数或总费用承诺。

在已升级的 release 目录先预览；该命令不修改数据、不调用模型：

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --transient-only --json
```

取得覆盖本批可能再次计费的授权后，将下面批次名占位符替换为本次唯一的固定名称，授权说明按实际批准内容填写；以下是操作示例，不表示已在生产执行：

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --transient-only --apply --batch '<本次授权的固定批次名>' \
  --note '站点所有者授权本批旧协议暂态异常进行业务重放；保留原费用未知，接受可能再次计费' \
  --limit 4 --wait-seconds 900
```

首次 apply 重新筛选并冻结当时符合条件的 ID、原 attempt 和业务目标，之后沿用同一批次名、筛选参数与授权说明续跑，不吸收新的失败。预览不是冻结，预览到执行之间候选可能变化。批次仍走既有恢复、预算和结案路径，旧 attempt 与费用证据保留；`--transient-only` 不是零计费证明，也不是无限重放授权。查看与结案使用 `--status --batch '<本次授权的固定批次名>' --json`，不必加筛选开关；status 会核验并记录业务结案，不能当成只读预览。

## 恢复边界

后台侧栏“运行”的数字统计尚未结案的回执与待核实投递，复用运行页列表的筛选条件：回执包含结果未知、近三天失败及超过十五分钟未完成，排除当前 attempt 已恢复的记录；投递包含结果未知、失败及超过十五分钟仍在发送的记录。尚在自动恢复窗口内的 unknown 暂不列为人工核对项；超过 `retry_after` 十五分钟或恢复额度耗尽后重新显示。侧栏统计完整数量，列表各最多展示 40 条。结案不会清除历史费用未知状态，旧 attempt 的恢复也不会隐藏新 attempt 的失败。

新版业务结果可以结案旧版本异常：必须是同一 article_id，当前文章版本不小于捕获版本，publication 引用的 analysis.input_revision 等于当前文章版本，且文章已完成分析或过滤。只有 revision 增长、旧分析仍留在 publication，均不能结案。证据中的 `superseded_revision` 会记录捕获版本和成功版本，后台显示“新版已替代”。原调用状态、attempt 与未知费用保留；后续新 failed/unknown attempt 仍会显示。

`--status`、`--apply` 和每十分钟的 `ops.recover` 都会重评已有批次的业务证据（包括此前因版本不符或审核拒绝而 blocked 的记录）。定时重评只结案，不授权调用、不新建重放任务；尚未纳入批次的异常仍通过统一脚本冻结。

明确的 `content_policy_rejected`（例如 HTTP 400 / 1301）会被批量脚本标记 blocked，并跳过整个冻结业务目标的放行和入队；不通过同一新闻的其他回执间接重放。以后该目标出现合格成功证据时仍可结案。普通 429 不等于额度耗尽；`retryable` 也不代表已获准重放费用未知的调用。

新调用的安全错误详情保存在 `receipt_attempts.error_details`，请求关联仍用该行 `request_id`。后台显示 HTTP 状态、已知错误码，以及上游实际提供的审核对象/等级；没有这些字段时显示“上游未返回具体审核原因”，不猜拒绝词句。上游原始自由文本、私有 URL 与凭据不写入这些详情。旧记录只按当时 Gateway 固定错误格式识别 400/1301，不能补造历史审核理由。

| 目标 | 执行方式 | 结案证据 |
| --- | --- | --- |
| 普通文章分析 | 原 article_id、当前 revision，复用分析队列和旧 run tag | 当前 revision 的分析已经持久化，并进入同一文章的 publication |
| 归组 | 原文章普通归组任务，不强制拆组 | 原文章已有后续 fact membership，或本次归组任务完成且 publication 已持久化；`grouped_at` 单独不算成功 |
| 事件综述 | 原 story_id 的综述任务 | 后续综述版本已持久化 |
| 历史回填 | 通过原批次 advisory lock，只把选中的 failed item 改为 pending | 原 item 达到 published／filtered／existing 终态 |
| Codex 重置监控 | 保留原监控顺序，由正常 tick 处理；已经识别成功时直接结案 | 原 post 已有持久 recognition 和处理完成时间 |

回填锁被占用时，保留 planned，等原 executor 自然结束后再试；不暂停或抢占当前回填。preparation 回执通过冻结版本 key 或保存的回执 ID 找回原 item，旧 error 缓存仅对这次捕获的 attempt 允许一次重试。原 manifest、缓存输入与请求身份检查继续生效。

2026-10-04 独立决策审查通过：原 runner 每轮持有同一批次锁后，先读取已 queued 的恢复目标，优先领取其中可运行的 pending item，再回到原日期顺序。仅修改领取顺序，原并发、每轮上限、预算和暂停机制不变；普通积压会后移，不能称为零影响。这个优先级用于避免四个晚日期恢复目标占住名额、等待前方整个库存；planned、blocked 和其他 run 不获得优先级。回退时恢复普通领取顺序，保留所有回执及业务结果。

同一新闻沿用原 article_id，历史导入沿用唯一 identity_key，publication 按 article_id 更新，因此恢复不会重新导入一份新闻。过滤掉的内容属于正常终态，不要求为其生成公开新闻。

已恢复的旧异常从后台待核对表中移除，并在汇总中计为 `recovered`。这层显示只覆盖已结案的原 attempt；同一个 receipt 后来出现新失败仍会展示。它不会把旧调用伪装成模型成功，也不会把 unknown 费用改成零。没有业务结果、目标不存在或身份改变时，不强行结案。

## 核账与人工后续

新调用的自动 JSON 恢复、暂态恢复与本页历史批次重放分开：`LLM_JSON_MAX_ATTEMPTS` 限定同一回执的生成次数，JSON 校验失败与 `retry_new_request` 共用这份额度；`receipt_attempts.response` 保留每次已收到的响应，`output_validation_error` 记录应用校验失败。业务成功后主回执完成，后台不再把它当待核对；旧失败或 unknown generation 的 attempt 和费用未知状态保留。同 UUID 的再次发送只增加 `recovery_sends`，provider 的各次实际调用由 Gateway attempt 账本保存。协议停止、额度耗尽或缺少恢复依据时仍须定向核对，不能据业务成功推断旧费用为零。JSON 参数见[部署说明](../deploy.md#使用个人-llm-gateway)，暂态恢复升级顺序见本页前节。安装能力不会自动解除历史 unknown，也不会重新开启已结束的恢复批次。

有完整 Gateway 账本且能证明零 attempt、未派发时，继续使用 `reconcile-gateway-receipts.ts` 的证据路径；它与本页的“接受可能再次计费后重放”不同。missing ledger、HTTP 502、断连或缺 usage 都不构成免费证明。

若本批出现新失败，先按剩余 target 检查实际阶段和 Gateway 请求，不用新批次名反复解除相同问题。脚本不自动解决文章修订冲突、缺失原文或新的 provider 故障。恢复后抽查 article identity、publication 唯一性、公开详情，并比较执行前后回填和实时任务进度；不能只看待核对数下降。

2026-10-03 所有者明确授权上述受控重放及简单自动结案。该授权覆盖当次旧异常，不是以后对未知费用无限重放的默认授权。

生产本次固定批次为 `receipts-20261004`，冻结 2,055 条回执。上面的命令使用这个实际批次名；继续这次恢复必须复用它。后续新异常须另行核对和授权，不能为清空页面不断新建批次。

恢复期间，旧 unknown 主回执被授权放行后暂时显示为 failed，并刷新 `updated_at`；待对应业务成功才移出待核对列表。后台按 `updated_at` 排序，因此旧异常会重新排到前面，不能仅据列表位置或 failed 汇总判断发生了新错误；看 `receipt_attempts.started_at` 和 Gateway UUID 对应的实际 attempt。

2026-10-04 01:40 新加坡时间的定向核验：当时剩余 327 条 backfill Qwen 异常中，302 条为旧 `ledger_unavailable`（调用发生于前一天 23:20 至当天 00:28），12 条旧 `route_cooldown`、9 条旧 HTTP 502、4 条旧 `no_route`。00:30 Gateway 切换 SQLite 运行时/WAL 后至 01:37 的 backfill Qwen attempt 有 2,904 条 received、48 条在途，未出现新的 failed/unknown。运行批次的 prefilter/structure 实际绑定包含自托管主路线与个人百炼 Token Plan fallback；回执 54971–54973 的 UUID 与 Gateway 百炼成功记录逐一一致。fallback 只能处理上游路线问题，不能绕过 Gateway 自己的账本故障。该段是时点快照，未来故障必须重新核验。

## 2026-10-04 生产执行结果

02:05 新加坡时间验收：固定批次 2,055 条中，2,049 条已恢复、6 条 blocked，planned/queued 均为零；已恢复项包括普通文章 307、回填 1,719、综述 14、归组 8、监控 1。后台全局实际剩 8 条异常，其中 2 条在冻结批次之后新发生；backfill Qwen 待核对已为零。00:30 修复后至本次验收，backfill Qwen 有 3,527 条 received，没有 failed/unknown，不能把这个有限窗口外推为永不失败。

重复执行同一批次的真实 CLI 后，批次仍为 2,049/6，关联 attempt 行数与 attempts 合计均保持 4,158，授权审计记录保持 1,950；没有新增放行。以上是记录数，不是费用或新调用数。原 2,055 条 attempt 全部保留：unknown 1,891、failed 146、received 18；没有把旧 unknown 改写为成功或免费。

恢复结果关联到 1,592 个不同 article_id、1,592 个 identity_key 和 1,592 条 publication；公开详情抽查覆盖普通文章与历史文章，API 共 6 篇、隔离浏览器实际阅读 3 篇，均沿用原 ID。其他 filtered 回填目标不要求出现公开文章。实际页面数据由后台同一 `runsOverview` 查询核验；管理员登录后的浏览器页面未在本次取得认证态，不将此写成已完成的后台 UI 验收。

worker PID 2661716 全程未变，backfill timer 保持运行；回填恢复优先级消化后，原普通积压继续推进。此前 63 条 DeepSeek 冷却拒绝已退出全局异常列表，抽查 63925、63930、63931 均在同一文章上完成并发布。生产 smoke 覆盖 34 个网页/API/RSS/静态资源/MCP 入口，无失败或跳过；本地类型检查、14 个恢复专项测试及新建测试库的 279 个后端测试完成。

剩余项由站点维护者按本表核对，不由本批脚本继续自动放行；如需再次重放 unknown，先取得覆盖该次费用的授权。当前处置是保留异常及全部证据，不作假结案。

| 回执 | 是否属于本批 | 原因与现状 |
| --- | --- | --- |
| 3201、6511、11571 | 是 | Zhipu HTTP 400 / 1301 内容审核拒绝，分别发生在评分或理解阶段；不属于暂态网络重试 |
| 14007 | 是 | 捕获的是文章 revision 2，当前 revision 3 已分析发布；脚本保留旧版本异常，没有覆盖新版 |
| 54611 | 是 | Tencent 评分阶段 RemoteProtocolError；80.34 秒调用加最短 10 秒冷却超过 90 秒恢复预算，且只授权 Tencent 路线 |
| 56022 | 是 | 01:56:03 一次本轮恢复操作之外的 Gateway 部署重启中断在途评分请求；AIHOT 为 UND_ERR_SOCKET，同 UUID 账本为 interrupted_unknown。新实例仍保留 Python 3.14.7、SQLite 3.53.4 与 WAL，重启后已有真实成功调用 |
| 63250 | 否 | 理解阶段返回的内容没有 JSON 对象，保留 unknown，不把生成质量失败当作免费请求 |
| 63708 | 否 | Tencent 评分阶段 ReadTimeout 约 180 秒，超过恢复预算；HTTP 504，保留 unknown |
