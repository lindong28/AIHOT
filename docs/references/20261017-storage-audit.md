# 2026-10-17 生产存储增长审计

读者：部署维护者与后续存储优化实施者。本文是只读调查快照及建议，不是已批准的保留策略或已实施优化。生产代码、配置和数据均未修改。

## 环境与口径

现场：2026-10-17 21:23 起（UTC+8），腾讯云 `tencent-webserver-china`，现役 `/home/ubuntu/aihot/releases/private-research-20261013-982479a`，release SHA `982479af7a8931e7d37c233462f9bd106eddd6fb`。本机源码 `84ee243f2c35a19a8fc50cfe998ba20cd1465240` 与该提交的差异仅为文档；另外直接对比生产与本机的 operations/retention.ts、operations/backup.ts、worker/schedules.ts、content/retention.ts、research/read.ts，五个文件 SHA-256 一致。

取证使用 SSH 只读文件/配置、systemctl show、du/df，以及 PostgreSQL `BEGIN READ ONLY`、20 秒 statement_timeout 的尺寸、统计和聚合查询。不读取正文、凭据值或原始日志进入报告。数据库 16.15；尺寸使用二进制 GiB/MiB。表尺寸来自 pg_total_relation_size，包含表、TOAST 与索引；n_live_tup 是统计估计，不是精确计数。以下分别标明物理占用、逻辑文件大小和采样值。

根分区：总计 73,859,022,848 B，已用 25,720,057,856 B，可用 45,008,646,144 B，df 使用率 37%。旧 release 清理已另见[执行记录](20261017-release-cleanup.md)，本次不重复计入释放量。

## 当前存储和持续增长路径

| 对象 | 现场尺寸/数量 | 写入与读取用途 | 当前保留机制及判断 |
|---|---|---|---|
| aihot 数据库 | 8,927,681,559 B，8.31 GiB | 业务事务、队列、研究搜索与模型账本 | 有部分保留规则，整体没有固定容量上限 |
| receipts + receipt_attempts | 2,648,457,216 + 1,892,335,616 B，合计 4.23 GiB，约占数据库 51% | 请求幂等、恢复、费用和结果；同一最终 response 写入两表 | 不受 dailyRetention 清理；不能按年龄删除账本或未知/未消费结果 |
| research_documents | 1,408,860,160 B，1.31 GiB；其中索引 838,352,896 B | 私有资料按来源/日期/关键词检索、分页、原文读取 | 从文章/回填同步的正文投影，非临时缓存；会随可检索资料增长 |
| backfill_items | 1,050,296,320 B，约 1,002 MiB | 续跑、来源证据，以及私有资料读取的部分原文后备 | material/preparation 内含多层正文；仅符合业务清除条件的终态材料清空 |
| articles / publications / article_revisions / analyses | 分别约 500 / 314 / 176 / 166 MiB | 在线内容、发布投影、版本与分析 | 按业务资格清正文；公众号保留，合格内容保留，不是统一年龄 TTL |
| pool_search | 376,012,800 B，约 359 MiB | 内容检索投影 | 内容被业务清除时同步清理；不能独立按目录式清理 |
| fetch_runs / story_heat_hourly / job_runs | 约 49 / 22 / 16 MiB | 采集诊断、事件趋势、运行记录 | fetch_runs 与小时热度未纳入应用定期清理；job_runs 普通 30 天、失败 90 天 |
| hot_rankings | 约 30 MiB | 热榜快照 | 每次成功生成后删除 30 天前快照 |
| pgboss.job_common | 约 56 MiB，约 12 万行 | 作业队列 | 35 个队列现场 retention_seconds=1,209,600、deletion_seconds=604,800；有维护时间，不应误判完全无期限 |
| imgcache + ogcache | du 约 1.10 GiB；逻辑文件约 1.04 GiB，共 25,389 文件 | 图片代理、OG 图片、海报 | 每日按 mtime 清 30 天前文件；没有字节总额上限 |
| journal | du 1,884,971,008 B，约 1.76 GiB | API/Web/worker stdout 与其它系统服务 | 未显式设置应用预算；本机 journald 手册默认 SystemMaxUse 为文件系统 10%、上限 4G，因此不是无限增长 |
| Nginx / PostgreSQL / Docker 日志 | Nginx 约 7.6 MiB、PG 约 1.5 MiB；Wechat2RSS Docker 当前文件约 7.5 MiB | 请求与服务诊断 | Nginx daily/14/compress；PG weekly/10/compress；Docker json-file max-size=100m、max-file 未显式设置（官方默认 1） |
| shared 历史回填目录 | history-full 约 605 MiB，history-unified 约 356 MiB，Wechat2RSS 约 214 MiB | 冻结输入、原文、续跑与 RSS 服务数据 | 非缓存 TTL 范围；本次未核每批唯一副本与当前续跑引用，不据目录年龄判可删 |

补充：audit_log 约 1.6 MiB、ingest_events 空表占 24 KiB；应用清理未覆盖二者。生产 data/backups、uploads、feedback 目录不存在，stored_files 为 0 行，因此 QR/反馈遗留与备份失败堆积是已识别的代码风险，不是本次已发生的大空间来源。

## 清理执行、写入节奏与证据边界

- `ops.retention` 计划为 Asia/Shanghai 每日 03:30；job_runs 中 10 月 3–17 日共 15 次，全部 status=ok。最近五次 prunedCache/deletedFiles/deletedJobRuns/discardedSignals 都为 0，deletedLeases 为 29–70。现场两类缓存确实没有 mtime 超过 30 天的文件，不能把删除数 0 当作调度故障。
- 10 月 14/15/16 日分别新增 6,596/6,638/6,387 条 receipts，1,022/1,022/984 篇 articles，10,614/10,628/10,666 条 fetch_runs。按创建时间取日计数，非新闻发布时间。历史回填集中写入使全库总量不能按这些三日流量线性外推。
- 缓存中 mtime 最近 7 天的现存逻辑文件共 436,653,739 B，约 416 MiB；这是现存文件的时间分布，不是已测净增长率，覆盖/删除会影响它。
- receipts 精确状态计数：completed 554,383，received 13,628，failed 195，unknown 46。received 超过 7 天 8,115 条、unknown 超过 7 天 32 条；保留它们以待核消费者与恢复状态，本次没有重放、结案或删除。
- 对两表分别做 SYSTEM(2) REPEATABLE(17) 页采样：receipts 12,088 行，平均 request 825 B、response 2,437 B；attempts 12,181 行，平均 response 2,455 B。pg_column_size 是采样字段存储尺寸，不等于迁出后可释放的物理字节，也不能把整个 4.23 GiB 都算可归档空间。
- research 三个 trigram 索引合计约 649 MiB，idx_scan 当时均为 0。统计窗口/业务流量不足以证明索引无用；不建议据此直接删索引。应在真实关键词与分页查询上核计划、延迟和必要搜索语义。
- autovacuum 已启用、default_toast_compression=lz4；receipt/attempt 统计死元组约 10.9 万/8.7 万，不能据此直接估算 bloat。WAL 约 960 MiB，复制槽为 0。数据库 temp_bytes 累计约 306 GiB，但 pg_ls_tmpdir 当时 0 文件/0 B；累计 I/O 不等于占满磁盘的文件。
- 尚无覆盖代表性时间窗口的物理尺寸序列、查询延迟/负载实验或云账单，因此不报告“还能用多少天”、精确节省金额或确定的迁移收益。

## 已核实的机制缺口

| 问题 | 证据位置 | 对本轮结论的影响 |
|---|---|---|
| response 双写与研究/回填正文多副本 | providers/receipts.ts:272–287；backfill/history-input.ts:35–45；database/migrations/0048_research_documents.sql | 优先评估去重与正文冷热分离，比先换数据库更直接；保留幂等与检索消费者 |
| backfill 状态更新时间也触发正文投影刷新 | 0048_research_documents.sql:115–119 | 可能增加大行、索引和 WAL 写入；代码路径成立，具体写放大量未测 |
| 清理吞文件错误且计数失真 | operations/retention.ts:20–22、36–39 | cache unlink 失败仍递增；stored_files 先删行再删文件，失败会失去重试索引；status=ok 不保证所有文件真删掉 |
| 正文清理失败可阻止后续维护 | operations/retention.ts:30–40 | discardExpiredSignals 在最前，异常会跳过作业记录、租约和缓存清理；本次未观察到该失败 |
| 运行明细、小时热度缺少明确生命周期 | sources/collect.ts、events/hot.ts、operations/retention.ts | fetch_runs 每日约万条；查询 LIMIT 不是保留上限。audit_log 必须按审计需求另定 |
| 备份上传失败可跳过本地裁剪 | operations/backup.ts:103–119 | keep3 在上传后；未来启用备份时须处理失败累积与空间预算 |
| QR/反馈文件的遗留路径 | admin/settings.ts:15–30；operations/feedback.ts:85–89；notify/feishu.ts:130–151 | 更换 QR 不回收旧 hash；关闭转发/超过重试窗口的截图可能遗留，当前对应目录无文件 |
| 自动应用备份当前未启用 | worker 启动参数指定的 shared/app.env 与进程初始环境均缺四项 DB_BACKUP_STORE_*；AIHOT_CREDENTIALS_DIR 未配置；job_runs 无 ops.backup；settings 无 backup.last | 已核环境与凭据文件回退路径。不能把仓内备份实现当作已有保护；云盘快照或其它外部备份未核实 |
| release 回收仍是人工工作流 | deploy/production/prepare-release.sh；生产运维清理章节 | 本次手工清理不会阻止今后部署再次堆积，应在发布生命周期中接入既定资源清理流程 |

全部问题均留待后续实施，原因是本轮为分析而非修改线上保留语义；统一跟踪于 [ISSUE-STORAGE-20261017-lifecycle](../issues/general.md#issue-storage-20261017-lifecycle存储生命周期与写入放大)。

## 推荐顺序与存储取舍（未实施）

1. 先补现有生命周期的可信度：清理失败保留可重试对象、分别报告成功/失败和实际回收量，各数据族互不因一个失败跳过全部；给可再生缓存配置时间和空间双预算。依照实际诊断/审计用途确定 fetch_runs 等明细的保留期，小时热度可先降采样为日级。旧 release 回收接回部署流程，保留当前/在途消费者。复用现有作业与告警，不为此新增常驻平台。
2. 再减少主导占用的冗余：每次 attempt 的完整响应只保留一个权威副本，receipt 保留关联；研究索引只保留支持当前搜索/分页所需字段。避免仅因回填状态改变重写未变正文。需验证回执复用、恢复、成本报表、全文/转义查询、分页与正文读取。
3. 对已经终态、低频读取但仍有审计/复现价值的大 payload 评估压缩后放 COS：PostgreSQL 保留账本、金额、状态、幂等键、内容身份与对象引用；按实际读取粒度选择单对象或批量归档。写入对象并校验可读后再移除数据库副本，不能先删后传；received/unknown、在途作业和待核账记录不按年龄迁走。业务原文和筛选结果的保留语义维持现行约定，不能把“旧”直接当“冷”。
4. PostgreSQL 继续承担在线事务、任务和查询索引。当前库 8.31 GiB、运行/热度表几十 MiB，没有取得分析查询争用证据，不足以支持现在新增 OLAP 服务。未来若跨年聚合扫描真实影响业务，再用分区/汇总或导出列式文件做对照，并按查询模式选择 OLAP；不要把 OLAP 当作历史数据垃圾桶或账本替代品。
5. 备份与归档分开：先核现有外部保护，补应用异机备份及恢复验收；COS 的 daily/weekly/monthly 前缀本身不产生过期策略。保留窗口、研究原文可接受读取延迟及存储预算属于业务取舍，本文不替用户设定。

对象存储的成本比较应包含存储、请求、检索/恢复、流量、最短存储期和运维成本。Tencent COS 生命周期支持转层/过期，但 STANDARD_IA/ARCHIVE/DEEP_ARCHIVE 分别有 30/90/180 天最低存储期，归档读取还需恢复等待，因此常用研究正文不宜仅凭年龄放入归档层。参考 [COS 生命周期](https://www.tencentcloud.com/document/product/436/17028)及[检索费用](https://www.tencentcloud.com/document/product/436/40097)。这里未读取实际账单，不给节省金额承诺。

PostgreSQL 删除行后普通 VACUUM 主要使空间可复用，并不保证 df 立即下降；VACUUM FULL 会重写并锁表且需要额外空间，不应作为每天清理手段。参考 [PostgreSQL routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html)。Docker 日志默认文件数依据 [JSON File logging driver](https://docs.docker.com/engine/logging/drivers/json-file/)。

## 交付范围

已完成：现役源码身份核对、主要写入/读取用途映射、生产尺寸和日写入计数、实际保留作业与日志轮转、存储取舍建议、问题持久记录。未执行：删除数据、改保留窗口、配置/部署、备份上传、数据库迁移、重放调用或负载实验。

未核实边界：云盘快照/外部备份与 COS 生命周期、连续物理增长曲线、真实查询负载收益、历史冻结文件逐批唯一性；这些不是当前“存在增长且应补生命周期”的结论前提，实施对应方案时由 AIHOT 维护者补验。未处置问题均见上表及 issue；本轮分析范围内无其余待执行项。
