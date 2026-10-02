# 历史原文回填

供迁移维护者将审核后的历史原文交给 AIHOT 当前算法处理，并查看逐日进度。历史批次通过同一个个人 llm-gateway 限制候选路由，GLM 允许自部署与已授权的两个订阅来源，Qwen 仅允许自部署。2026-10-02 用户明确升级 DeepSeek 至 V4.1 Flash，并授权此次 backfill 使用腾讯 VOD 公司账户特例：摘要仅允许 `tencent-vod` provider 的 `company_tencent_vod`，不回退自托管或其它付费来源。

V4.1 配置与校验代码已更新，运行时接入尚未完成：个人 Gateway 的 `aihot` personal 项目目前不具备 company_paid 腾讯账户资格，须由 Gateway 维护者落实该特例后才能通过预检。本次未变更生产环境或既有批次；旧 V4 绑定会被新版预检拒绝，开始执行后的绑定不可改写，后续 V4.1 回填须准备新批次。已有回执和历史验收读数保留原模型名。

2026-10-02 上线快照：AIHOT `bbbb789` 已发布至生产 `backfill-bbbb789`，个人 Gateway `2d5d4aab549ae355339509469af60703d85f11d9` 已重装运行。启动批已导入，首篇完成处理并公开；生产 timer 与 Mac 监督已启动。以下读数不表示整批或全部历史已完成，具体覆盖与待办见下文。

## 准备原文，不调用模型

在仓库根目录运行，先按[部署说明](../deploy.md)准备 Node、依赖和数据库，设置目标 `DATABASE_URL` 并执行 `node scripts/migrate.ts`。首次上线此功能须完成 `0039_backfill.sql` 迁移，重启 API、重新构建并重启 Web；普通 worker 也须更新，以识别受管历史条目。安全阀保持关闭。

准备 `source-map.json`（旧来源 ID 到已登记 AIHOT 来源 ID 的对象）和 `reviews.json`（初始为 `{}`），数据与密钥放在不入 Git 的 `.data/`。转换只保留原始字段，不读取 RADAR 的评分、分类、标签和生成摘要：

```bash
node scripts/prepare-radar-backfill.ts .data/source-map.json .data/reviews.json .data/native-review.jsonl .data/raw-audit.jsonl.gz .data/ingestion-differences.jsonl.gz
```

输出原生 JSONL 及同名 `.summary.json`，包含排除原因和审核后连续区间。默认所有材料待审核；未映射来源、无正文和无效材料不进入输出。输出文件必须不存在。原始版本应保留，不能用转换结果替代原始归档。

审核记录按原生身份键索引，例如 `url:https://example.com/news`（以实际转换身份为准）或 `x:帖子ID`；值为 `{"contentHash":"该条 quality.contentHash","state":"complete","evidence":"完整性判断的原文证据"}`，不完整则标 `incomplete`。短且完整的公告可以通过；只有标题、链接、截断摘要或缺失关键引用的材料不能标完整。多版本需对照原始归档，选中准确 hash。X 还需在审核记录中提供 AIHOT 原生 `xPost`（作者、正文、引用与媒体）；重建后重新转换取得 hash，再审核该版本。原生字段定义见 [manifest.ts](../../packages/backend/src/backfill/manifest.ts)。

更新审核文件后换一个输出文件名再运行转换。只有 `complete` 条目参与回填，导入时重新核对正文 hash，要求选定 UTC 区间每天都有合格材料；这表示日期连续，不保证每个来源历史完整。待审核与区间外材料留在排除统计中。已存在的 AIHOT 身份直接计为“已有”，不覆盖原文、不沿用旧 RADAR 衍生结果。

```bash
node scripts/backfill.ts import .data/native-approved.jsonl 2026-04-20 2026-09-28 '历史原文第一批'
node scripts/backfill.ts status
```

日期仅示例，必须取转换后的合格连续区间，且距当前超过 48 小时。导入返回批次 ID，初态暂停、尚未调用模型。总条数与日期在创建时冻结；同一清单重复导入返回原批次。

## 当前批准的启动批

本轮迁移主线程逐篇审核首三天 54 个候选，批准 44 条完整原文，另 10 条因上下文未明保留 `unverified`。批准范围为 2026-08-17 至 2026-08-19（UTC），每日分别 9、16、19 条；这是连续三天的启动批，不是全历史完成。

原生清单位于不入 Git 的 `.data/backfill-launch-20261002/first-batch-approved.jsonl`，由仓库内 `scripts/prepare-radar-backfill.ts` 生成，包含上述 44 条 `complete` 与 10 条 `unverified`。X 原文以核心文本自足为批准条件；仅有视频/GIF 静帧不能证明媒体内容完整，引用缺正文时不能仅凭主帖长度批准。旧 `/i/web/status/` URL 在一次性转换中改为原生 handle/status URL，不改变长期 URL 规范化逻辑。

两个原始包分别有 raw 169,936 行、differences 3,265 行；按旧 ID 诊断合并后为 170,191 条，排除 386 条日期为 2026-10-01 及以后的材料，剩 169,805 条。该数量不是原始行数，也未按 native identity 去重；此前 canonical 169,100 候选来自不同口径，不能混用。上述数量都不是批准处理进度的分母。后续审核由 AIHOT 迁移维护者继续，批准新的完整连续原文后再建下一批；不把未审核余量计成失败或已完成。

生产批次为 `f8ff402f-fb8c-47a2-8170-d2fb9268e641`，manifest hash 为 `7af3dcb5376c0eb80cea8a1c0b4865275546fbcbcc1f8ecabec75350c5ae188e`。已导入 44 条合格原文，10 条待核实材料作为排除项保留；44 是本批分母，不是完整历史分母。

首篇 `zkirb51bgptt3jyc9amb1tqni` 已为 `published`，主线程经浏览器读取[公开详情](https://news.aiplanet.live/items/zkirb51bgptt3jyc9amb1tqni)，看到标题、正文、AI 导读与新评分。该篇 5 次应用回执均 completed，且按 exact request ID 对应 Gateway success：Qwen 预筛与结构使用 `self_hosted/qwen3.8-flash-next`，GLM 两次评分使用 `personal_zai`，DeepSeek 摘要使用 `self_hosted/deepseek-v4-flash-0731`。这是 1 篇、4 个角色、5 次调用的读数；该篇未触发 `understand`，不代表五角色全实跑。

随后 `wn3lc8ow41i5vcpinhqxnmljd` 已触发理解并公开，真实浏览器与 Gateway success 账本均已核对；completed request `0f8c5646-cd39-45c0-a523-acb26e5da977` 对应 `openai/glm-5.3-flash`、`personal_zai`、`zhipu`。五角色因此在批内覆盖，并非同篇全部触发。

2026-10-02 08:06 UTC 首批进入 `needs_attention`：43/44（97.7%）、2/3 天，28 published、13 filtered、2 existing、1 failed，另 10 excluded。真实后台浏览器取得相同终态。逐日 published/filtered/existing/failed 分别为 08-17：8/1/0/0，08-18：10/4/1/1，08-19：10/8/1/0。这是本启动批完成率，不是全历史完成率。

当时的失败条目 `qb20oni3wgw91r0ih25hg37dh` 在发布阶段报 `Analysis not complete: unknown`；其 5 个模型回执均 completed，理解回执为 `3dd29fa5-6be3-4990-9e14-a5c98b73d6c7`。原文来自 `radar-x-sama`，模型生成 OpenAI 主体的标题和摘要，但原文未明写该实体，既有 identity guard 标出 `unsupportedTitleEntityIds/unsupportedSummaryEntityIds=[openai]` 并 fallback，未取得可用中文文案。这是内容校验未通过，不是供应商超时或未知扣费。

2026-10-02 用户调整处置口径：上游内容过滤或文案校验未通过属于内容结果，无需运营介入。回填将已持久化的 `unknown` 分析结果计为 `filtered`（原因 `analysis_unknown`），计入已处理和完成天数，不再列为失败待处理；原文、分析及回执保留，公开展示条件不变。不再要求对上述条目确认主体或重新写作。缺失分析、模型调用异常、未知回执等执行问题仍计为失败。旧执行器留下的此类失败可在更新代码后重试，复用已有分析；重试仍须通过批次模型预检。

12:48 UTC 已完成生产状态纠正，12:51 UTC 从真实后台页面读到：44/44、3/3 天、28 published、14 filtered、2 existing、0 failed，另 10 excluded。新发布目录 `backfill-content-filter-20261002` 复制当时的 `receipt-recovery-20261002`，仅覆盖回填执行器文件，保留同期回执修复。常规重试被模型预检挡在 `waiting_models`，未领取条目；维护者随后在持有批次锁的单笔事务中，核对原文 revision/hash、已持久化 unknown 分析与五个 completed 回执后，将该条计为 filtered、批次计为 complete，并写入审计记录。没有新增模型调用，没有改写原文、分析、回执或公开状态。一次性处置脚本和测试日志保留在主 checkout `.data/backfill-content-filter-20261002/`，不入 Git；此结果不证明当时所有模型就绪。

本次实现验证：回填专项 8 项、后端全套 175 项、Web 11 项通过，另完成 typecheck、Web 构建及公网 smoke。专项使用本机 PostgreSQL 与模拟模型，覆盖短文缺文案、主体 guard 拒绝、既有失败恢复和真正执行异常；线上验收为一个启动批及上述一条历史失败恢复，不外推全历史或模型质量。

主线程完成本批全量回执与 Gateway 账本关联：157 条应用回执全部 completed（预筛 42、结构 29、评分 58、理解 5、摘要 23），对应 157 个 logical success、173 次 attempt。self-hosted 为 94 次 success；Zai 为 63 次 success 与 12 次 HTTP 429；Ark 实际接到 4 次 fallback，均 HTTP 429、无 success。173 次 attempt 全在调用方 allowlist 内，无其他按量 API；最终 GLM 都由 Zai 完成。429 是限速还是额度所致尚未核实，不能据此声称余额耗尽或配置不支持，也未证明 Ark 是成功后备。原始关联证据位于主 checkout `.data/backfill-launch-20261002/receipt-ledger-acceptance.json`，不入 Git。该核账证明本批请求及路由关联，不是供应商结算账单。

## 模型接入与首次真实验收

五个角色的候选身份必须与**个人** Gateway discovery 一致。现有部署绑定见 [`deploy/production/backfill-models.json`](../../deploy/production/backfill-models.json)，候选包含 logical model、route、actual model、provider 和 credential profile，不填猜测值：

| 角色键 | 模型与参数来源 |
|---|---|
| `prefilter`、`structure` | 同一个 Qwen3.8-Flash 同系列部署，沿用 `qwen3.8-flash` preset |
| `score` | GLM5.3-Flash，沿用 `glm-5.3-flash-selection` preset，双评分 |
| `understand` | GLM5.3-Flash，沿用 `glm-5.3-flash` preset |
| `summarize` | DeepSeek V4.1 Flash，使用 `deepseek-v4.1-flash` preset；唯一候选为 `company_tencent_vod/deepseek-v4.1-flash/stream`，actual model 为 `openai/deepseek-v4.1-flash` |

绑定是以这五个键组成的对象，新格式每个值为 `{"model":"逻辑ID","routes":[{"route":"路由ID","actualModel":"实际模型ID","provider":"provider ID","credentialProfile":"profile ID"}]}`。预筛和结构绑定须完全相同；开始处理后不允许修改该批模型绑定。旧的单条 self-hosted 绑定仍可读取。

执行环境设置 `LLM_GATEWAY_URL`、`LLM_GATEWAY_PROJECT=aihot` 和 `LLM_GATEWAY_MODE`（沿用个人 Gateway 接入配置）。默认不设置 `LLM_GATEWAY_CLI`，通过 `GET /v1/discovery?model=逻辑ID` 与 `X-LLM-Project` 读取逐模型安全投影；该预检不调用模型。若显式设置 `LLM_GATEWAY_CLI`，则使用同一 Gateway 的 CLI discovery。密钥继续由 Gateway 管理。

预检核对 projection version 2、project 的归属声明包含 personal、请求模型、文件与已加载 registry revision，以及每个候选的身份和授权。归属兼容旧字符串或非空无重复数组；腾讯摘要另外要求包含 company。主 Gateway 的 `aihot` 应登记 `billing_scope=["personal","company"]`，订阅逐项目授权和实际 credential 资金归属保持不变。每个角色至少有一个候选可用即可，不要求未部署的 GLM 自托管候选 ready。GLM 候选按 self-hosted → `personal_zai`（`zhipu`）→ `personal_ark`（`volcengine-ark`），订阅候选还必须为 `funding_source=personal_subscription`；Qwen 不开放商业 API。DeepSeek 摘要必须是 V4.1 Flash 的唯一腾讯候选，资金归属保持真实的 `company_paid`；不允许伪装为 personal，也不接受 Gateway 报告项目不允许、政策不允许或候选不可用。

```bash
node scripts/backfill.ts configure BATCH_ID deploy/production/backfill-models.json
node scripts/backfill.ts resume BATCH_ID
MODEL_CALLS_ENABLED=true node scripts/backfill.ts run BATCH_ID CONCURRENCY MAX_ITEMS
```

将三个大写参数替换为真实批次 ID、容量并发和本次最多处理条数。`resume` 只改变状态，需运行执行命令；命令到达条数上限、队列耗尽或暂停后退出，进度留在数据库。单条失败保留错误并继续本次限额；本次结束后仍有失败则进入 `needs_attention`。

本轮部署主线程实测：Qwen 在 DGX0026 使用 4 GPU，DeepSeek 在 DGX0022 使用 8 GPU，二者 vLLM `--max-num-seqs=16`、`--max-model-len=32768`，并与线上共享。首篇逐条验收后，生产回填已采用容量并发 8，给实时处理留余量。此前“同篇五角色”表述修正为同篇完整原生链路、已结算回执与公开结果：原生理解与摘要是互斥写作分支，本轮未改模型、门槛或发布标准。实际角色覆盖见上文，不把首篇 5 次调用写成五角色。以上是部署容量与实际启动状态，不是已测吞吐承诺。

生产 HTTP preflight 已通过，未部署的 GLM 自托管候选正确显示不可用；Zai → Ark fallback 已实际触发，4 次 Ark attempt 均为 HTTP 429，成功后备能力尚未证实，最终 GLM 调用由 Zai 完成。

每次模型调用成对携带 `X-LLM-Allowed-Routes`（JSON 数组）与 `X-LLM-Registry-Revision`，Gateway 在同一快照内核 revision 后，只在批准集合里选路和 fallback。AIHOT 同时核对响应中的 provider、route、actual model 与 credential profile；身份缺失或不符保留未知回执，核账前不重发。预算仍经过原生回执，独立服务名 `backfill`；默认限额见后台预算页，未知费用不会记成零。历史回填不调用 embedding、不生成历史日报或当前热点，也不触发额外的全文/引用翻译。

## 有界 drain 与生产调度

`drain` 每轮访问最多指定数量的批次，整轮共享条目领取上限，只选 `ready`、`waiting_models`、`running`。批次 advisory lock 忙时跳过；取得锁并通过预检后，才恢复中断的 `running` 条目并复用已结算回执。暂停批次及 `needs_attention` 不会自动重试。到时或收到 SIGTERM/SIGINT 后停止领取与后续模型调用，结算在途请求再退出。

| 必须显式配置的环境变量 | 含义 |
|---|---|
| `BACKFILL_CONCURRENCY` | 并发 1–32；当前生产为 8 |
| `BACKFILL_MAX_ITEMS` | 整轮最多领取条数，正整数；当前生产为 64，失败领取也消耗该上限 |
| `BACKFILL_MAX_RUNS` | 整轮最多访问批次数，正整数；当前生产为 4 |
| `BACKFILL_DRAIN_SECONDS` | 1–1500 秒；当前生产为 1500，到时停止后续调用并等待在途结算 |

```bash
node scripts/backfill.ts drain
node scripts/backfill.ts drain CONCURRENCY MAX_ITEMS MAX_RUNS
```

第二种写法覆盖前三项环境变量，仍必须显式设置 `BACKFILL_DRAIN_SECONDS`。生产执行器从 `/home/ubuntu/aihot/shared/app.env` 加载这些值；模型调用的授权开关也须按真实执行配置打开。测试和原文准备阶段保持安全阀关闭。

生产生命周期入口为 [`backfill-service.sh`](../../deploy/production/backfill-service.sh)：

```bash
bash deploy/production/backfill-service.sh install
bash deploy/production/backfill-service.sh status
bash deploy/production/backfill-service.sh stop
bash deploy/production/backfill-service.sh start
bash deploy/production/backfill-service.sh uninstall
```

`install` 会安装并立即启用 `aihot-backfill.timer`，因此先配置四项限额，完成首次模型链路与通知验收，再安装。timer 启动 15 秒后触发，执行器结束 60 秒后接续；oneshot 服务从生产 current 目录执行 drain，启动上限 30 分钟、停止结算最多 5 分钟。`stop` 同时停止 timer 与当前执行器；`uninstall` 另移除 unit，批次、回执、配置与数据库保留。服务状态不代表批次完成，执行日志用 `journalctl -u aihot-backfill.service`，批次进度用 `node scripts/backfill.ts status --json`。

## Mac 监督与通知

现有 `~/.local/bin/run-or-alert` 与 `~/.local/bin/im-notify` 是监督依赖，不另建通知通道。Mac 的 [`backfill-monitor.py`](../../deploy/production/backfill-monitor.py) 管理 launchd，运行只读生产状态探针 [`backfill-probe.py`](../../deploy/production/backfill-probe.py)：

```bash
python3 deploy/production/backfill-monitor.py install --host tencent-webserver-china
python3 deploy/production/backfill-monitor.py status
python3 deploy/production/backfill-monitor.py stop
python3 deploy/production/backfill-monitor.py start
python3 deploy/production/backfill-monitor.py uninstall
```

默认每 300 秒检查一次（`--interval` 最低 60 秒），install 会加载并立即探测。launchd label 为 `live.aiplanet.aihot-backfill-probe`，日志在 `~/Library/Logs/aihot/backfill-probe.log` 与 `backfill-probe.err.log`，通知生命周期状态在 `~/.local/state/aihot/backfill-probe.json`。停止或卸载 Mac 监督不停止生产回填。

本轮已从主 checkout 路径安装并加载该 launchd 作业，每 300 秒监督生产。2026-10-02 07:59:22 UTC 的真实 scheduler inactive 告警及 08:01:10 UTC 的恢复通知均在 im-notify 账本记录 `push=sent`；恢复 probe exit 0。生产 timer 已 install、enable、restart。通知投递读数不证明整批完成，也不覆盖公开站点可用性。

本批 `needs_attention` 告警于 08:04:24 UTC 记录 `push=sent`，08:06:07 UTC 重复探测为 `push=skipped(unchanged)`，去重已取得实测。08:07 UTC timer 为 active/waiting，oneshot service 为 inactive/dead、`Result=success`、`ExecMainStatus=0`，表示本轮正常退出；该批不再自动重试，后续新 `ready` 批仍可由 timer 执行。

探针读取生产批次和 systemd 状态，对 timer 未运行、runner 异常、`needs_attention`、`waiting_models` 发低紧急度通知，并沿用 im-notify 去重与恢复；探测或投递失败由 run-or-alert 接住。批次消失不算恢复，暂停后的告警退役不算处理完成。探针不覆盖公开站点可用性，也不能仅凭 timer 存活证明内容持续产出。正式无人值守前须实测通知投递；注册 launchd 不等于已验收。

## 查看与续跑

管理员打开 `/admin/backfill`：查看已处理条数、完成天数、发布/过滤/已有数量、排除原因、当前阶段及失败原因。页面每 20 秒刷新。失败不算完成；“已发布”按原始日期进入历史公开内容，不挤占当前热点。读页面不调用模型。

暂停按钮或 `node scripts/backfill.ts pause BATCH_ID` 阻止后续模型调用；在途请求仍会结算，已发布内容不撤回。恢复沿用已结算回执。`waiting_models` 表示没有通过就绪检查，修复部署或绑定后恢复；`needs_attention` 查看条目错误，修复后使用“重试失败项”或 `retry BATCH_ID`。未知回执先在现有运维入口核对 Gateway 账本，再允许恢复；单纯点击重试不会重新发送未知请求。

范围与验收记录见[迁移清单](../migration.md)和[启动决定](../references/20261002-backfill-launch.md)。全历史余量的完整性审核及后续批次归 AIHOT 迁移维护者；上游内容过滤不再要求主体确认或重新写作。Ark HTTP 429 的限速/额度归因及成功后备能力尚未核实，归 Gateway 维护者。全历史余量不计入本启动批完成量。
