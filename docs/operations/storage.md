# 存储治理 spec

本文是 AIHOT 项目存储治理的维护入口，面向维护者与后续审计、优化 agent；保留决定、数据用途、实现入口与观察证据分别记录。负责人为 AIHOT 维护者。当前优化保留 PostgreSQL、原文检索、付费回执和既定保留周期；没有新增对象存储或 OLAP。数据年龄不是删除账本或原文的依据。

## 覆盖范围与证据身份

初版按 `service-workflows sync-storage-spec` 整理，源码核对基线为 `5c4df6e302651df93ea3ef4e7d672fdc9b282c46`；2026-10-18 接续核对基线为 `0ec8b350c2bd2649759871a8ef4a6882a799c3a6`，并刷新下文指定的生产只读读数。覆盖腾讯云主部署的已识别主要增长数据族及共享配套资源，非所有表、对象和云费用的完整普查；本轮没有触发生产清理、备份或改变保留策略。

| 证据 | 环境、时点及用途 |
| --- | --- |
| [存储审计](../references/20261017-storage-audit.md) | 2026-10-17 21:23 起（UTC+8），`tencent-webserver-china`、PostgreSQL 16.15、旧现役源码 `982479a`；表/文件尺寸、三日写入计数、调度与日志配置的历史基线。 |
| [优化与部署记录](../references/20261017-storage-optimization.md#生产部署与消费验证) | 2026-10-17 23:23:48（UTC+8）启用源码 `23c5c78`，release `storage-20261017-23c5c78`；记录单副本、研究投影与清理修复的部署及实际消费者验收。 |
| [内容保留决定与操作说明](content-retention.md) | 业务保留资格、清除范围、恢复保护及历史候选边界的权威入口，本文引用，不另定义资格。 |

下表尺寸均来自第一份历史审计，不代表优化后重测值。数据库总量当时 8.31 GiB；根盘 37%、可用约 41.92 GiB。部署后记录为数据库约 8.32 GiB、根盘仍 37%、可用约 41.56 GiB。没有代表性物理增长序列或账单，不据这些短窗口读数推算耗尽日期、增长斜率或月费节省。

## 数据族、增长与保留边界

数据库表尺寸含表、TOAST 与索引；文件尺寸注明 du 或逻辑口径。数据库各行是分项，不与全库总量重复相加；研究/搜索投影与原文在物理上独立，在业务计数上可能重叠。下列“未设期限”表示缺少已确认边界，不表示已决定永久保留，也不表示可立即删除。

| 数据族与历史占用 | 写入、消费者与副本性质 | 增长及现有生命周期 |
| --- | --- | --- |
| `receipts` / `receipt_attempts`：合计 4.23 GiB | [paidRequest](../../packages/backend/src/providers/receipts.ts) 随供应商调用及重试写入；幂等复用、恢复、费用和逐 attempt 诊断使用。单副本模式下当前 attempt 是响应来源，历史双副本仍在。 | 随调用累计；10 月 14–16 日每天新增 6,387–6,638 条 receipt，不等于净字节增长。无年龄清理；received/unknown、失败记录、usage 与费用语义继续保留。 |
| `research_documents`：1.31 GiB，其中索引约 800 MiB | [投影触发器](../../database/migrations/0050_research_noop_updates.sql)及[私有读取层](../../packages/backend/src/research/read.ts)；来源/日期/关键词搜索、分页和原文读取。正文投影可由仍保留的来源材料重建，源材料已清除时不能假设可重建。 | 随保留资料与索引增长；有效投影字段未变时不 UPDATE。没有独立年龄 TTL，不能仅因索引统计为零移除。 |
| `backfill_items`：约 1,002 MiB | [历史输入](../../packages/backend/src/backfill/history-input.ts)与回填处理保存 material/preparation；续跑、来源证明及私有原文后备用途。 | 随导入增长，可能批量突增；只有符合既定终态资格才清正文材料，保留身份与判定。 |
| `articles` / `publications` / `article_revisions` / `analyses`：约 500 / 314 / 176 / 166 MiB | 采集和 worker 写入，经 [publication](../../packages/backend/src/publication) 服务网站/RSS/API/MCP；包含原始材料、修订、分析和公开投影。 | 随采集、修订和处理增长；按[内容资格](content-retention.md)清理，非统一 TTL。公众号及合格内容保留；失败与未结算不得当作过滤结果。 |
| `pool_search`：约 359 MiB | 业务内容检索投影；与源内容关联。 | 源内容按资格清除时同步回收；不能单独按年龄删除而改变搜索结果。 |
| `fetch_runs` / `story_heat_hourly`：约 49 / 22 MiB | [采集](../../packages/backend/src/sources/collect.ts)诊断及[事件热度](../../packages/backend/src/events/hot.ts)趋势；采集批次/小时快照写入，非内容正文缓存。 | fetch_runs 三日每天约 10,600 条；小时快照定时写。未纳入 dailyRetention，保留期与是否汇总待定；查询 LIMIT 不限制存量。 |
| `job_runs` / `delivery_leases` / pg-boss 队列 | [作业队列](../../packages/backend/src/jobs/queue.ts)及[调度](../../apps/worker/src/schedules.ts)；运行诊断、在途任务和投递并发。job_runs 约 16 MiB，pgboss.job_common 约 56 MiB。 | dailyRetention 清过期租约，作业历史普通 30 天、失败 90 天；35 个队列现场配置曾为 retention 14 天、deletion 7 天，维护语义归 pg-boss，不把两值当成统一删除承诺。 |
| `hot_rankings`：约 30 MiB | 事件热榜计算保存快照，公开热榜读取；[计算入口](../../packages/backend/src/events/hot.ts)。 | 成功生成后清 30 天前快照；依赖生成任务成功，非独立容量上限。 |
| `audit_log` / `ingest_events`：约 1.6 MiB / 空表 24 KiB | 操作审计与摄取记录；[公众号修复](../../packages/backend/src/content/wechat-repair.ts)还按 audit_log 的 action/request_id 读取旧 after 作为幂等结果。 | 应用定期清理未覆盖；audit_log 不能整体套普通日志 TTL，否则可能失去修复去重依据。ingest_events 的现有后台消费者取最近 20 条，但 LIMIT 不是保留决定。 |
| `imgcache` / `ogcache`：du 约 1.10 GiB，逻辑约 1.04 GiB | [图片代理](../../packages/backend/src/media/images.ts)、[分享卡](../../apps/api/src/og/render.ts)与[海报](../../apps/api/src/og/poster.ts)按需生成；可再生派生文件，依赖原图或渲染输入仍可用。目录位于有效 `AIHOT_DATA_DIR` 下。 | dailyRetention 按 mtime 清 30 天前文件；未设总字节预算。7 天现存文件约 416 MiB 是分布，不是净增长；TTL 不保证容量固定。 |
| `stored_files`、上传 QR、反馈截图 | 文件写入与[反馈转发](../../packages/backend/src/operations/feedback.ts)、[后台设置](../../packages/backend/src/admin/settings.ts)有关；数据库过期记录和实体共同构成回收依据。 | stored_files 按 expires_at 清理；旧 QR hash、关闭转发/超过重试窗口的截图仍有回收缺口。审计时 stored_files 为 0，uploads/feedback 目录不存在；不能把风险当成已发生大占用。 |
| journal、Nginx/PG/Docker 日志 | 服务 stdout、访问和数据库诊断；含同机其他服务，需先区分资源归属。journal du 约 1.76 GiB，其余当时均不足 10 MiB。 | 当时 journal 未设应用独立预算，系统默认上限 4 GiB；Nginx daily/14/compress，PG weekly/10/compress，Docker max-size=100m、默认单文件。审计时配置不是未来不变的保证。 |
| WAL、临时文件、备份与云快照 | PostgreSQL 写入、恢复及[备份入口](../../packages/backend/src/operations/backup.ts)；不等同业务归档。WAL 当时约 960 MiB、复制槽 0；临时目录当时为空。 | 自动应用备份当时未配置、无备份目录与运行记录；云快照未知。源码本地 keep3 不能保证上传失败后裁剪；云 daily/weekly/monthly 前缀不代表配置了生命周期。恢复窗口和费用待核。 |
| release、冻结回填文件、Wechat2RSS 数据 | [生产发布](production.md)、[回填](backfill.md)与[公众号服务](wechat2rss.md)；历史输入还可能是续跑或唯一来源。history-full/unified/Wechat2RSS 当时约 605/356/214 MiB。 | release 随部署增加，现有[清理流程](production.md)为人工执行；历史回填逐批唯一性未核。旧 RADAR 已退役不等于这些现役共享数据可删；不使用统一目录年龄策略。 |

其他业务表和辅助产物未在上述审计单独量化时，沿表尺寸重测发现新增主导项后补入；本表不宣称已覆盖每个 writer。大字段、索引、WAL 与备份各自计量，避免只看表行数遗漏成本。

## 当前规模下的处理优先级

2026-10-18 用户明确希望区分立即问题与长尾完善，优先当前规模的最低充分方案。以下为重新评估后的建议，未批准新的删除期限、预算数字或服务建设；取代此前将各类待办并列呈现的治理顺序。缺口是否存在、当前是否值得实施分别判断。

2026-10-18 12:07:53（UTC+8）只读复测腾讯云：根盘 36%，可用 45,585,674,240 bytes（约 42.5 GiB）；数据库 8,948,317,207 bytes（约 8.33 GiB）；current 仍为 storage-20261017-23c5c78。通过下方只读 SQL 查询最近三次 ops.retention：10 月 16–18 日均为 ok，无 error；最新一次 03:30:37–03:30:38 完成，缓存、文件记录、作业记录删除数均为 0。本次没有核候选数量，不能据此证明实体删除成功或判定漏清；未刷新其他数据族的尺寸，也未取得代表性增长趋势。

| 处理层级 | 当前判断与最低充分动作 | 重新评估条件 |
| --- | --- | --- |
| 立即处理 | 本次磁盘与定时任务读数未发现需要紧急存储修复的证据。保持已部署的单副本与清理修复，不为填满清单增加系统。 | 写入失败、空间明显不足，或实际清理故障造成积压时，直接恢复受影响链路。 |
| 例行维护与已决暂缓 | 23:09 接续已核应用备份未配置，用户确认没有外部备份并选择暂缓实施；恢复保障缺口保留，具体处置见下文。后续发布/例行维护复用现有查询看磁盘和清理结果，不为一次复查新建监控平台。 | 用户重启备份实施或恢复要求改变时，提供目标位置与保存窗口，再由 executor 按下文接续；不重复询问本轮已确认的事实。 |
| 按增长触发 | fetch_runs/小时热度期限、缓存字节上限、旧 release 自动回收、历史响应去重暂不列为立即开发。小表无 TTL 与容量危险不是同一事实；当前缓存有 30 天规则、release 有人工清理入口。 | 相应数据成为主要空间贡献、清理后仍持续积压、批量回填计划将显著增加空间，或手工维护频率已成为负担。先核消费者，优先复用现有任务做局部修复。 |
| 暂缓建设 | 对象存储/OLAP、全面冷热分层、复杂容量预测与多层备份体系，以及当前尚未形成占用的 QR/反馈残留治理，不因理论完整性进入开发。 | 实测成本、查询性能、恢复要求或实际功能使用变化足以支持新增维护成本时再比较。 |

当前建议由 AIHOT 维护者在后续治理任务承接；分析完成不代表建议已实施。安全边界、数据唯一性与已批准的保留用途不因项目规模小而降低。长期有价值资料无 TTL 可合法保留，不将其自动标成待修缺陷。

## 重测入口与治理顺序

先按[生产运维](production.md)核目标主机、实际 release、进程与有效配置；连接使用现有受控环境，不把连接串、正文或日志原文复制到报告。数据库只读取证可从以下查询开始，保存采集时点、发布 SHA 与原始数值，再与同口径记录比较：

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';
SELECT now() AS observed_at, current_database(), pg_database_size(current_database()) AS database_bytes;
SELECT schemaname, relname,
       pg_table_size(relid) AS table_bytes,
       pg_indexes_size(relid) AS index_bytes,
       pg_total_relation_size(relid) AS total_bytes,
       n_live_tup AS estimated_rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 30;
SELECT started_at, finished_at, status,
       detail->>'prunedCache' AS deleted_cache_files,
       detail->>'deletedFiles' AS cleared_file_records,
       detail->>'deletedJobRuns' AS deleted_job_runs,
       error IS NOT NULL AS has_error
FROM job_runs
WHERE job = 'ops.retention'
ORDER BY started_at DESC
LIMIT 5;
ROLLBACK;
```

这是后续只读重测入口；初版同步未执行，2026-10-18 的执行范围见下节。文件系统用目标挂载点的 `df`、有效数据目录的 `du`；表统计只估算行数。增长比较需保留至少两个同口径时点及覆盖窗口，同时记录采集量、付费调用量、回填/发布和清理事件；两个时点也不自动代表长期趋势。

后台“运行”页显示 `ops.retention` 状态和截断错误；成功清理计数保存在 `job_runs.detail`，用上述受控只读查询取得，页面不提供这些明细。失败时部分完成计数位于 `error` 摘要，detail 缺值不能当成零；必要时在受控环境检查并脱敏错误，勿直接导出原文。系统未记录候选总数，需按[实际保留实现](../../packages/backend/src/operations/retention.ts)另行只读核候选。删除记录数、库内复用和文件系统返还分别判断。

当前优先级以上节为准，未决项沿[生命周期 issue](../issues/general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大)跟踪；该清单不表示所有事项都要立即实施。批准的业务保留资格仍归[内容保留](content-retention.md)，本 spec 不新增期限。

存储费用、请求/取回、出网、计算和维护总成本尚未核账；目前没有依据承诺具体金额收益。保留 PostgreSQL 的决定沿[优化记录](../references/20261017-storage-optimization.md#决定与范围)；未来分层或 OLAP 候选须核查询语义、取回时效、事务与恢复需求，不能只因数据变旧或变大就迁移。责任人为 AIHOT 维护者，下一动作及验收继续在上述 issue 跟踪。

## 2026-10-18 接续核对与具体处置

23:09（UTC+8）通过 SSH 只读核腾讯云：`current` 为 `storage-20261017-23c5c78`，worker active；根盘 36%，可用 45,403,996,160 bytes。数据库在 23:09:18 的 `BEGIN READ ONLY` 事务中为 8,962,046,999 bytes，查询设置 20 秒 statement timeout。最近三次 `ops.retention` 均为 ok；10 月 18 日 03:30 本次清除租约 30 条，缓存、文件记录和作业记录均为 0。

按与实现相同的过期条件查询，当前 stored_files 与 job_runs 合格候选均为 0；实际 `AIHOT_DATA_DIR=/home/ubuntu/aihot/shared/data` 中 imgcache 有 12,190 个文件、逻辑大小 361,623,648 bytes，ogcache 有 13,443 个文件、765,666,930 bytes，两者按 mtime 超过 30 天的数量均为 0。当前候选为零支持“此刻没有这些过期积压”，不能回推 03:30 的候选快照或证明生产删除失败路径有效。没有扫描正文清理候选，也不宣称全部数据族清理正常。

现役清理实现和 `tests/storage-retention.test.ts` 与已验证部署 `23c5c78` 无差异；复用[既有隔离验证](../references/20261017-storage-optimization.md)中的删除失败保留记录、独立阶段继续、重跑和未过期文件保留证据，本轮没有为了产生删除计数在生产造数据或启动清理。长期增长及费用没有新增代表性窗口。

应用备份四个必要配置项在 app.env 及其 credentials integrations 回退均未设置，备份目录不存在，`ops.backup` 记录为 0，`backup.last` 不存在。本机和远端未发现 tccli 配置入口，未进行云控制面查询、创建 bucket 或触发备份。用户随后通过本轮提问明确回答没有异机备份/自动快照；“没有外部备份”的依据是用户确认，应用路径的未配置则已现场核实。

| 对象 | 已核用途与处置 | 下一动作、归属与重评条件 |
| --- | --- | --- |
| 有效原文、研究和搜索资料 | 现有私有检索消费者要求保留；没有年龄 TTL 不单独构成缺陷。保留现状。 | AIHOT 维护者在来源撤回、查询用途改变、主要空间贡献变化或批量导入前重评；不因较旧而删正文。 |
| 付费回执和 attempt 响应 | 已部署新响应单副本；账本、恢复、幂等与响应复用仍在使用。历史去重及转冷暂缓。 | 若成为实际容量/成本瓶颈，executor 先区分身份和费用账本、可复用响应及诊断内容，再核全部读者和历史复用兼容性；不能统一过期。 |
| fetch_runs、ingest_events | 源码中的后台消费者分别取来源最近 30 条和接入最近 20 条；不是原文权威或采集游标。 | 用户本轮选择“暂缓新增期限”；普通 30 天、失败 90 天、未完成采集保留仍仅为候选。主要占用或维护负担变化时由维护者复查，不实施新删除。 |
| story_heat_hourly | [事件详情](../../packages/backend/src/publication/stories.ts)取最近 7 天，但历史榜单曲线按榜单时刻取前 24 小时；[榜单](../../packages/backend/src/events/hot.ts)保留 30 天。不能只按 7 天页面窗口清理。 | 用户本轮一并暂缓新增期限。31 天是覆盖现有 30 天榜单加 24 小时曲线的候选，不是既定政策；重新启用前仍需核活跃引用与执行时序。 |
| audit_log | 同时承担后台历史与公众号修复幂等；现状保留。 | executor 若设计回收，先将幂等身份从可过期日志中分离并保持消费者语义；当前不以日志 TTL 删除。 |
| 缓存与定时清理 | 保留既有 30 天规则；当前过期候选为 0，复用已验证的失败重跑实现。暂不添加字节预算。 | 维护者在缓存成为主要占用、短期批量生成或清理后积压时确定预算；有失败记录时查既有运行入口，不把任务 ok 当成全部效果证明。 |
| 外部备份与恢复 | 应用路径确认未配置，用户确认没有外部备份；恢复保障缺口仍在。 | 最低充分候选为复用现有 PostgreSQL dump 与 uploads 打包，存到用户指定的一个异机位置；用户本轮另选择“暂缓备份实施”；目标位置、保留窗口及新增费用尚未决定。实现已有 COS 上传入口，但其多前缀不是生命周期，pg_restore --list 不是恢复验证；配置和启用前由 executor 核这些边界。 |
| release、QR/反馈残留和外部失败通知 | 保留现有 release 人工入口；尚未形成占用的小文件及告警接续仍沿[生命周期 issue](../issues/general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大)跟踪。 | 发布维护频率成为负担、相应功能实际启用或观察到清理失败时重评，优先接入现有任务/通知设施；本轮不宣称已自动回收或及时推送。 |

以上补齐用途、候选与执行归属，不代表未批准的保留策略已经落地；用户明确暂缓的新期限不构成本轮实施债务。备份实施也由用户明确暂缓，缺少异机恢复能力这一事实仍保留；由维护者在重启实施时提供目标位置与保存窗口，executor 再补上传失败回收、远端保留和隔离恢复验证，并核权限与具体范围。

## 回执单副本的启用与回退

普通查询通过 `receipt_response(receipts)` 读取响应：优先读取历史 receipt 字段，否则读取 `receipt_attempts` 中 `attempt=receipts.attempts` 的响应。付费请求复用先锁定 receipt，再用新语句读取该 attempt，保证锁等待期间提交的响应可见。所有 attempt、失败输出、usage 和已知/未知费用继续保留。`RECEIPT_SINGLE_COPY=false` 是兼容默认；设置为 `true` 的进程在成功事务中将 receipt 字段置 SQL NULL，响应仅写 attempt，防止旧答案遮蔽新答案。历史双副本不批量重写。

生产操作须有覆盖当前部署的授权，沿 [生产发布入口](production.md#部署更新与起停) 执行：

1. 应用迁移 0049、0050，并部署含迁移的已审核版本，先保持 `RECEIPT_SINGLE_COPY=false`。
2. 核对 API、worker、回填进程、人工脚本与外部 SQL 读者都支持 `receipt_response()`。切换 `current` 不会更新仍运行的进程。历史 attempt 诊断直接读该 attempt 响应，不能把最新响应套给以前的 attempt。
3. 在后端实际环境配置中设 `RECEIPT_SINGLE_COPY=true`，让相关写入进程退出在途任务后加载新配置。验证新 receipt 原字段为空、最新 attempt 有响应、恢复复用不新增付费请求、旧数据仍能读。函数存在不证明开关已启用。
4. 停止单副本写入可关闭开关，但必须继续使用兼容读者。关闭开关不会补回已省略字段，不能直接回退到旧读者。确需回退时，另行准备、验证并批准数据兼容回填。

先在 `_test` 或 `_ci` 隔离空库执行 `node scripts/migrate.ts`，再运行 `RECEIPT_SINGLE_COPY=true npm test`；凭据及其它环境按 [离线测试要求](production.md#离线测试环境) 隔离。专用回执测试同时覆盖默认双写、旧数据复用和模式切换。

## 清理与研究投影

`ops.retention` 继续由既有 worker 在上海时间每日 03:30 调度。缓存仍为 30 天；任务历史一般 30 天、失败 90 天。过期文件先删实体再删 `stored_files` 记录，失败保留记录供重试；实体已不存在时可完成记录清理。一个阶段失败不阻止独立阶段，最终任务记录为 failed，错误摘要含已完成计数。`deletedFiles` 是清除的过期记录数，可能包括实体已不存在的记录，不能当作新释放字节数。

从后台“运行”页的 `ops.retention` 排障，区分数据库阶段失败、缓存读取/删除错误与无合格候选；修正权限或路径后由下次调度重试。外部通知仍待 AIHOT 维护者完成已有告警接入，不把后台可查询等同于及时推送。

迁移 0050 保留资料获胜版本重算、全文索引、正文、撤回和分页，只在有效投影字段变化时更新行。回填 `updated_at` 仍可能改变同一身份的获胜版本，因此保留触发条件。迁移不扫描全量正文、不删索引。

## 剩余成本与保留取舍

历史回执去重、fetch_runs/小时热度/审计保留期、缓存字节预算、备份与对象存储生命周期继续在 [生命周期问题](../issues/general.md) 跟踪。维护者先确认查询与恢复用途，再批准数据处置；原文有私有检索消费者，继续保留。

长期效果需要同口径数据库/表及文件系统尺寸，并结合采集、回填量解释。当前改动减少新增冗余与无效更新，不会自动缩小现有数据库文件。逻辑删除、库内空间复用、`df` 可用容量分别核对；没有连续窗口及账单证据，不声称降低具体月费。
