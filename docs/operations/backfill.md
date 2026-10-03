# 历史原文回填

供迁移维护者将归档历史原文交给 AIHOT 当前算法处理，并查看逐日进度。当前全量入口见“统一历史清单与自动执行”；下文手工审核导入与独立预筛入口保留用于旧批次，不是全量链路的必经步骤。历史批次通过同一个个人 llm-gateway 限制候选路由。2026-10-03 用户明确将回填中的 GLM 全部替换为 DeepSeek V4.1 Flash：评分、内容理解和摘要仅允许 `tencent-vod` provider 的 `company_tencent_vod`，按公司付费归属，不回退自托管或其它付费来源；预筛与结构仍只用自托管 Qwen。

个人 Gateway 的 `aihot` 已登记 personal/company 双归属，腾讯账户仍为 `company_paid`。新绑定按当前策略预检；旧 GLM/V4 绑定不能启动新调用，开始执行后的绑定不可改写。已完成批次及回执保留原模型名，不重算；后续批次使用新配置。切换决定和验证边界见[模型替换记录](../references/20261003-backfill-deepseek.md)。以下旧批次的 GLM、自托管 DeepSeek 读数均为历史快照，不表示当前配置。

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

## 全量准备：先初筛，再补原文

### 统一历史清单与自动执行

全量链路采用已有 `backfill_runs/items`，`scope=history` 的一个 run 覆盖固定日期与规范新闻身份。每条 item 保留全部原始版本、原始归档文件/行号/hash、固定 UTC 归属日和准备结果；选定归档正文或成功补取之前不创建 article。多个版本的 BLOCK 独立保存，只有全部版本均为已结算 BLOCK 才归正常过滤。无效 URL 保留原始 key 和分母；有可筛文字时仍先初筛，已结算 BLOCK 可正常过滤，否则保留 URL 异常。

在内存充足的本机离线冻结原始输入，再把冻结文件传到生产。原始目录包含 `prepared-v2`、`full-prefilter-input`、`full-x`、`full-non-x`、`import-ready-v1` 及来源映射；本命令不联网、不调用模型、不写数据库：

```bash
node --max-old-space-size=6144 scripts/backfill-freeze-history.ts ARCHIVE_ROOT OUTPUT_DIR 2026-04-20 2026-09-30
node scripts/backfill.ts import-history OUTPUT_DIR/candidates.jsonl 2026-04-20 2026-09-30 '全量历史回填'
node scripts/backfill.ts configure BATCH_ID deploy/production/backfill-models.json
node scripts/backfill.ts resume BATCH_ID
```

`manifest.json` 记录输入/输出 hash、版本数、新闻数、异常数和逐日分母。每个身份按最早原始版本 UTC 日冻结，全部版本日期继续保留；更换入库正文不改变该日。相同冻结文件及日期范围重复导入复用同一 run。导入流式读取 JSONL，不把全量正文载入生产进程内存。准备 payload 在 JSONB 的 `dataJson` 字符串中保存 JSON 编码，读取时才解码，以保留实际归档 HTML 中 PostgreSQL 不接受的 NUL；原始内容和冻结 hash 不变。来源必须已登记；历史缺源按归档来源禁用登记，不启用新的实时订阅。

2026-10-03 本机冻结读数：170,160 版本归属 166,577 条新闻，195 个身份跨日，1 个无效 URL（仍保留在清单和进度中）。这是本次输入快照，不是已处理条数。实施目标与尚未完成的生产验收见 [统一回填 plan](../../plans/20261003-unified-history-backfill/plan.md)。

| 执行环境变量 | 用途 |
|---|---|
| `BACKFILL_ORIGINAL_CACHE` | 必填，原始响应持久缓存根；使用 `responses/<url-sha256>.json` 和响应 gzip，兼容旧抓取缓存 |
| `BACKFILL_PREFILTER_CACHE` | 可选，生产正在使用的旧预筛目录；严格核 key、inputHash、manifest、prompt、模型与环境身份；不可用本机旧副本覆盖 |
| `BACKFILL_NOT_DISPATCHED_AUDIT` | 可选，旧错误回执的逐 attempt 权威 Gateway 证据 JSON；只有完整 logical local_rejected 和零 Gateway attempts 的记录才允许恢复旧 model_error |

统一执行器先复用已有文章与精确 hash 批准材料，再消费旧预筛结果或执行新初筛。按用户 2026-10-03 修订，原文完整性由 agent 抽样，不新增逐条 `verify_history_material` AI 核验：已有正文直接复用，缺正文或只有标题/URL 占位时才补取网页。HTTP/提取/模型故障仍保留执行异常，不能伪装正常过滤。旧完整性判断和付费回执保留为历史记录，不再发出该用途的调用；材料 evidence 明确是归档复用或网页提取，不声明逐条完整性已审核。

旧预筛回执按实际请求 logical key 校验（prompt、正文输入、模型参数和 Gateway 身份）；不同原始 key 的相同请求可以共享回执，不能用第一个 subject 拒绝后续版本。旧缓存虽仍记 unknown，但相同回执经核账成为 received/completed 后，直接解析已存响应再事务结算，不重发。实际仍 unknown 的回执继续阻断。X 的冗余 legacy bodyHtml 若含 NUL，准备原生材料时省略该可选字段；bodyText、xPost、引用和媒体原样保留，原 HTML 仍保存在 preparation。content_hash 绑定最终使用的原生材料。

在冻结 run 已导入、模型绑定完成后，生产将 [`backfill-unified.conf`](../../deploy/production/backfill-unified.conf) 安装为 `aihot-backfill.service.d/zz-unified.conf` 并刷新 systemd。它清除旧独立预筛池和固定 September 30 入队的 `ExecStartPost`，仍由原 timer 调用同一个有界 drain。不要让旧预筛执行池和统一执行器同时消费模型预算。开始实际调用前仍需真实小批材料边界与回执验证；代码和离线测试不证明模型判断质量或全量获取率。

后台优先显示统一 run：总数等于已处理、待处理、处理中、执行异常之和；已处理仅包含 published/filtered/existing。原文准备通过和进入评分都不提高完成率。某天全部 item 到正常终态才计完成天数。旧批准批次折叠显示，不能与全量分母相加。单项异常不阻断其余 pending；全部待办耗尽仍有异常才进入 `needs_attention`。预算、忙回执或明确未派发暂缺可等待下轮，unknown 必须核账后才能继续。

Mac 继续使用 `live.aiplanet.aihot-backfill-probe` 和既有通知去重键。存在统一 run 后按 `totals.failed` 提示执行异常，即使该 run 仍在推进 pending；旧 preparation 告警退役明确表示切换统计入口，不表示旧异常已解决。

### Qwen 路由不可用的现场恢复

2026-10-03 19:58（+08）个人 Gateway 日志出现 `Too many open files` 和 SQLite `unable to open database file`，随后 `gateway-model-manager` 线程退出。Qwen 部署记录仍为 running，但管理锁已释放，discovery 将获准的自托管路由标为 `deployment_unknown`；统一回填因此停在 `waiting_models`，已处理 2,955 条、执行异常 84 条。逻辑模型有其它可用路由不等于回填可用，不能擅自更换已批准的 provider。

本次仅在 Mac 的 `~/Library/LaunchAgents/live.lindong.llm-gateway.plist` 增加 `SoftResourceLimits.NumberOfFiles=4096`，经现有 Gateway `stop.sh → start.sh` 重载；launchctl 已回读 soft maxfiles 4096。管理器重新取得锁，自托管 Qwen 路由恢复 eligible，腾讯云原 `aihot-backfill.timer` 自动接续。20:22 的真实读数为已处理 3,008 条、处理中 9 条、执行异常 86 条；模型、参数、64 并发和回填预算未改。两条旧 crossed/in_flight 账目由 Gateway 原有启动恢复记为 interrupted_unknown、费用 unknown，未重发；恢复后新增两条 item 的 unknown-receipt 异常仍隔离核账。这些是恢复快照，不是全量完成或持续容量保证。

后续已按用户要求持久化安装配置：共享 Gateway 安装器支持 `LLM_GATEWAY_LAUNCHD_NOFILE`，个人 `ai-agent-config/llm-gateway/install.sh` 固定传入 4096，每次完整安装重新写入。两仓代码须同步更新；直接运行共享安装器时须显式传入该参数，否则采用系统默认。隔离个人入口连续两次安装生成 4096，独立 launchd 进程也实际读取到 4096；本次代码更新未重装生产 Gateway 或改动 GPU 部署。修复记录见 [Gateway 配置持久化](../issues/archive/closed.md#issue-gateway-20261003-fd64gateway-安装覆盖文件句柄上限)。回退备份、异常日志和原始账本快照仍在主 checkout `.data/backfill-full-run-20261002/gateway-fd-recovery-20261003/`，安装验证在 `.data/gateway-nofile-20261003/`。

### 旧独立准备入口（仅诊断与迁移前使用）

2026-10-03 用户批准全量准备先使用已有原始文字做 Qwen 初筛。运行入口如下，参数依次为冻结输入、五角色绑定、结果目录、并发、每轮最多条数、从首个待处理项开始的领取秒数：

```bash
node scripts/backfill-prefilter.ts INPUT.jsonl deploy/production/backfill-models.json OUTPUT_DIR 8 400 90 --json
```

此命令会调用模型，须使用已授权的回填环境和 `MODEL_CALLS_ENABLED=true`；离线转换与测试保持原安全阀约束。仅标题直接进入待补原文，不调用模型。只有 BLOCK 被筛除；PASS/UNKNOWN 仍需补原文及完整性审核，不能直接导入。累计状态在 `OUTPUT_DIR/summary.json`，逐版本结果在 `results/`，执行错误保留且不自动重发未知回执；准备计数不代表原生导入或发布进度。

可选生产接入文件为 [`backfill-preparation.conf`](../../deploy/production/backfill-preparation.conf)，应先准备其中固定路径的输入，再安装到 `aihot-backfill.service.d/zz-preparation.conf` 并 daemon-reload；它保留已有 ExecStartPost，以串行方式接在 native drain 和已有入队操作后。该配置把服务启动上限调整为 50 分钟、停止等待调整为 10 分钟。是否已安装须以目标主机的 systemctl 配置为准；代码中的配置文件不证明已经运行。设计、数据分母与恢复边界见[全量准备记录](../references/20261003-backfill-prefilter.md)。

公共网页补取使用本机入口，读取准备阶段的冻结输入和不断增加的结果，以及已核对的原文目标库存：

```bash
node scripts/backfill-fetch-originals.ts PREPARATION_DIR INVENTORY.jsonl FETCH_QUEUE.jsonl .data/original-responses 400 90
```

只抓取已结算的 `needs_original` 且库存中有单一明确抓取目标的非 X 条目，按 URL 复用缓存。每批最多 8 个并行请求，网络阶段每个请求共用 20 秒、6 MiB 和 5 次重定向限制；输入扫描、提取和落盘另计。输出保存压缩原始响应、来源／最终 URL、时间、hash 与提取内容，全部为 `unconfirmed`；`items.jsonl` 保留 X 材料、待选目标、待核正文与执行错误等下一步事项。它不做完整性批准或原生导入，错误缓存不自动重试；异常遗留 `fetch.lock` 时须先确认原进程状态，不能直接夺锁。

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
| `score` | DeepSeek V4.1 Flash，使用 `deepseek-v4.1-flash-selection` preset，双评分；65536 tokens、180 秒、temperature 1；thinking enabled/clear_thinking=false、effort high、top_p 0.95 |
| `understand` | DeepSeek V4.1 Flash，使用 `deepseek-v4.1-flash-low` preset；thinking enabled、effort low；16384 tokens、180 秒、temperature 0.2 |
| `summarize` | DeepSeek V4.1 Flash，使用 `deepseek-v4.1-flash` preset；唯一候选为 `company_tencent_vod/deepseek-v4.1-flash/stream`，actual model 为 `openai/deepseek-v4.1-flash` |

绑定是以这五个键组成的对象，新格式每个值为 `{"model":"逻辑ID","routes":[{"route":"路由ID","actualModel":"实际模型ID","provider":"provider ID","credentialProfile":"profile ID"}]}`。预筛和结构绑定须完全相同；理解和摘要沿用相同 DeepSeek 路由绑定，但各自的思考参数不同。开始处理后不允许修改该批模型绑定。旧的单条 self-hosted 绑定仍可读取。各阶段完整参数与查看入口见 [模型配置](../references/model-configuration.md)。

执行环境设置 `LLM_GATEWAY_URL`、`LLM_GATEWAY_PROJECT=aihot` 和 `LLM_GATEWAY_MODE`（沿用个人 Gateway 接入配置）。默认不设置 `LLM_GATEWAY_CLI`，通过 `GET /v1/discovery?model=逻辑ID` 与 `X-LLM-Project` 读取逐模型安全投影；该预检不调用模型。若显式设置 `LLM_GATEWAY_CLI`，则使用同一 Gateway 的 CLI discovery。密钥继续由 Gateway 管理。

预检核对 projection version 2、project 的归属声明包含 personal、请求模型、文件与已加载 registry revision，以及每个候选的身份和授权。归属兼容旧字符串或非空无重复数组；腾讯角色另外要求包含 company。主 Gateway 的 `aihot` 登记 `billing_scope=["personal","company"]`，各账户保留实际资金归属。每个角色至少有一个候选可用；Qwen 不开放商业 API。评分、理解和摘要必须使用 V4.1 Flash 的唯一腾讯候选，资金归属为 `company_paid`；不接受 Gateway 报告项目不允许、政策不允许或候选不可用。

```bash
node scripts/backfill.ts configure BATCH_ID deploy/production/backfill-models.json
node scripts/backfill.ts resume BATCH_ID
MODEL_CALLS_ENABLED=true node scripts/backfill.ts run BATCH_ID CONCURRENCY MAX_ITEMS
```

将三个大写参数替换为真实批次 ID、容量并发和本次最多处理条数。`resume` 只改变状态，需运行执行命令；命令到达条数上限、队列耗尽或暂停后退出，进度留在数据库。单条失败保留错误并继续本次限额；仍有 pending 时保持 `ready` 接续，待办耗尽且仍有失败才进入 `needs_attention`。

本轮部署主线程实测：Qwen 在 DGX0026 使用 4 GPU，DeepSeek 在 DGX0022 使用 8 GPU，二者 vLLM `--max-num-seqs=16`、`--max-model-len=32768`，并与线上共享。首篇逐条验收后，生产回填已采用容量并发 8，给实时处理留余量。此前“同篇五角色”表述修正为同篇完整原生链路、已结算回执与公开结果：原生理解与摘要是互斥写作分支，本轮未改模型、门槛或发布标准。实际角色覆盖见上文，不把首篇 5 次调用写成五角色。以上是部署容量与实际启动状态，不是已测吞吐承诺。

生产 HTTP preflight 已通过，未部署的 GLM 自托管候选正确显示不可用；Zai → Ark fallback 已实际触发，4 次 Ark attempt 均为 HTTP 429，成功后备能力尚未证实，最终 GLM 调用由 Zai 完成。

每次模型调用成对携带 `X-LLM-Allowed-Routes`（JSON 数组）与 `X-LLM-Registry-Revision`，Gateway 在同一快照内核 revision 后，只在批准集合里选路和 fallback。AIHOT 同时核对响应中的 provider、route、actual model 与 credential profile；身份缺失或不符保留未知回执，核账前不重发。预算仍经过原生回执，独立服务名 `backfill`；默认限额见后台预算页，未知费用不会记成零。历史回填不调用 embedding、不生成历史日报或当前热点，也不触发额外的全文/引用翻译。

## 有界 drain 与生产调度

`drain` 每轮访问最多指定数量的批次，整轮共享条目领取上限，只选 `ready`、`waiting_models`、`running`。批次 advisory lock 忙时跳过；取得锁并通过预检后，才恢复中断的 `running` 条目并复用已结算回执。暂停批次及 `needs_attention` 不会自动重试。到时或收到 SIGTERM/SIGINT 后停止领取与后续模型调用，结算在途请求再退出。

| 必须显式配置的环境变量 | 含义 |
|---|---|
| `BACKFILL_CONCURRENCY` | 并发 1–64；当前生产为用户指定的 64 |
| `BACKFILL_MAX_ITEMS` | 整轮最多领取条数，正整数；当前生产为 64，失败领取也消耗该上限 |
| `BACKFILL_MAX_RUNS` | 整轮最多访问批次数，正整数；当前生产为 4 |
| `BACKFILL_DRAIN_SECONDS` | 1–1500 秒；当前生产为 1500，到时停止后续调用并等待在途结算 |

2026-10-03 首轮 64 并发执行约 81 秒：领取 64 条，39 条完成，25 条因每分钟 300 次模型调用预算返回待处理，未新增失败。每小时 6000 次、每日 40000 次预算及模型参数保持原值；64 是同时处理新闻的上限，不保证持续满载或吞吐提高八倍。预算等待按原有 `retry_after` 和 timer 接续。

2026-10-03 19:02 +08，按用户指令将生产 `budgets` 表的 `backfill` 行更新为每分钟 30000 次、每小时 600000 次、每日 4000000 次，原生 `budget.update` 审计 ID 为 133。通过已有 `updateBudget` 配置入口生效；每次模型调用前都会查询数据库，无需重启或修改代码。其它服务预算未变；并发仍为64，模型参数与未知回执保护保持。上述首轮试跑使用的是调整前额度。

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
