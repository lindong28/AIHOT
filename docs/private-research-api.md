# 私有文章资料 API

用于查询服务实际保留、允许私有访问的资料。覆盖正式文章与在线 `backfill_items` 材料，包含自动过滤和未精选内容；排除人工撤回，“仅摘要”记录不搜索或返回正文。公开网站、RSS、MCP 的发布与全文许可不改变。不代表任何来源的全网历史，不遍历备份，也不恢复已清除内容。

## 读取入口

HTTPS 请求携带 `Authorization: Bearer <专用令牌>`。令牌不是管理员会话或 ingest 凭据。所有响应 `Cache-Control: no-store`；不设跨域授权，不跟随客户端重定向。协议的权威定义是 `packages/contracts/src/research.ts`，部署后通过鉴权的 `GET /api/private/v1/openapi.json` 读取。

| 路径（前缀 /api/private/v1） | 参数 | 用途 |
| --- | --- | --- |
| GET /sources | q、kind、limit、cursor | 找来源／账号 ID、显式别名与已有采集观测 |
| GET /groups | 无 | 发现研究分组及 sourceIds；初始为空 |
| GET /articles | source、group、timeField、q、from、to、selected、limit、cursor | 多来源并集、全文和时间过滤；元数据及匹配片段 |
| GET /articles/{id} | format=json 或 markdown | 读取稳定资料 ID 或 native article ID |
| GET /articles/resolve | url、format | 本地规范化 URL 后定位，不对输入 URL 发请求 |

每页默认 40、最多 100；关键词最长 256 字符，最多六个空白分隔词，按字面、忽略大小写 AND 匹配标题、生成摘要或完整已存正文文本；不截在 12,000 字。日期为含时区 ISO 8601，from 包含、to 不包含。未生成 publication 的资料 selected=false。正文不随列表整篇传输，详情不静默截断。

搜索索引候选会在解码后复核，避免将 JSON 转义误认成原文字词，因此一页可能少于 limit，甚至为空；只有 nextCursor=null 才表示遍历结束。JSON 导出保留原始 code unit，特殊 Unicode 使用 JSON 转义后可还原；需要严格保真存档时使用 JSON，Markdown 是阅读呈现。

`id` 为 `doc_` 加 URL identity 的 SHA-256，材料提升为文章后保持不变；`articleId` 是当前文章 ID 或 null。`sourceId` 是唯一可核实的账号身份，`collectionSourceId` 保留真实采集来源；历史公众号由两个已知归档来源、微信 URL 和唯一作者名映射，重名或未知不猜测合并。

尚未完成 preparation 的记录从冻结版本中首个有材料的版本提供已存原文，标记 `origin=material`；正式文章或已准备 material 优先。原版本顺序决定该读取版本，不把多个版本拼接，也不把自动预筛 BLOCK 当撤回。已清除且无原来源元数据的记录仅保留身份墓碑，来源可为 unknown。原 URL 定位优先查库中存在的片段身份，章节受限时不会回退到父页面。

`title` 为保存的原标题；`generatedTitle`、`summary` 为当前修订的生成结果；`body` 为已存原文，译文在 `translations` 单列。`bodyStatus` 是 available/missing/discarded/restricted，分别表示可返回、缺失、清除、正文受限。`completeness.state` 是 complete/incomplete/unverified，依据匹配版本的审核证据，而不是字数、非空或旧准备流程的 selected 标记；没有证据仍可读取，但报告 unverified。

`source` 可重复，每个值为精确账号 ID、名称或显式别名；ID 优先，名称/别名忽略大小写，不模糊猜测。`group` 可重复，接受精确组 ID 或名称。来源和分组取并集，同一资料只返回一次；显式空组返回空结果。零匹配和歧义返回 400 与安全候选 ID/名称，不能静默退回全库。`query.sourceIds` 返回解析后的范围，null 表示全库、[] 表示空范围；其他 query 字段记录实际过滤，便于保存和比较。

默认 `timeField=effective` 保留旧行为：按当前发表时间（缺失时发现时间）过滤，按初次索引时固定的 `sortAt` 及稳定 ID 排序。显式 `published`、`discovered`、`updated` 分别按发表、发现、投影更新时间过滤及倒序排序，ID 用于同时间排序；published 不将缺失日期回退为发现时间。`indexedAt` 是首次进入研究投影的时刻，`updatedAt` 是当前投影最近更新时刻，均独立返回；updated 查询便于取得旧文章的后续修订，但不是完整的权限/删除事件流，不能把查询无结果解释为无变化。跨期比较仍应保留查询范围与内容版本。

游标签名绑定解析后的来源、时间字段、过滤条件、初次查询截止时间和原令牌；分组成员变化、过滤条件／令牌变化须重开查询。开始后的新 identity 留到下一轮；旧资料的权限、清除、修订使用当前读取事务。每页是只读 repeatable-read，跨页不是事务快照，也没有固定总数。显式可变时间轴可能因修订移动条目；`changedSinceStart` 使用数据库快照身份保守判变，无关数据库写入也可能使它为 true。客户端应标记并重新核对，不把结果宣称为固定快照取全。

来源的 `collection` 复用已有 enabled、health、lastSuccessAt、lastFetchAt、nextFetchAt 和最近一次 fetch_run 的状态/起止时间。成功且结束的采集才返回 foundCount/newCount，失败或在途为 null；无采集记录则 latestRun=null。成功零条、失败、未观测由不同读数表达；这些是数据库中的采集观测，不是上游文章齐全或定时器当前活跃的保证。原始错误、detail、来源配置及凭据不由研究接口返回，需要深入诊断时沿既有管理员入口检查。

400 表示参数／游标错误或 unknown_source/ambiguous_source/unknown_group/ambiguous_group；后四类返回 selector 与 candidates。401 表示无效或已撤销令牌；404 不区分未配置、受限与不存在；503 表示索引未就绪、容量忙或服务不可用，busy 携带 Retry-After。搜索共用既有容量保护（默认同时 4、排队 8），不会额外无限占用数据库连接。

## 分组与别名管理

分组和成员由用户指定，安装及迁移 0054 不预置分类。权威配置位于现有 PostgreSQL 的 research_groups、research_group_sources、research_source_aliases；不复用编辑 tags，不更改来源采集或文章身份。配置随数据库备份保留，删除组只删除该组和成员关系；来源删除时其成员关系/别名随外键删除。别名按来源逐条设置/删除；允许显式同名记录，查询时报告歧义。

在已配置 DATABASE_URL 的受信后端工作目录执行以下管理命令（需要数据库管理权限，研究 bearer 不可写）：

```bash
node --env-file-if-exists=.env scripts/research-catalog.ts list
node --env-file-if-exists=.env scripts/research-catalog.ts set-group --id my-group --name '我的分组' --source radar-mp-3223096120
node --env-file-if-exists=.env scripts/research-catalog.ts set-alias --source radar-mp-3223096120 --alias '卡兹克'
node --env-file-if-exists=.env scripts/research-catalog.ts delete-alias --source radar-mp-3223096120 --alias '卡兹克'
node --env-file-if-exists=.env scripts/research-catalog.ts delete-group --id my-group
```

set-group 原子替换该组名称和完整成员集合；重复 --source 添加多个成员，不传 --source 表示空组。成员必须可唯一解析，非法成员使整次事务回滚，保留旧配置。stdout 是变更后的目录 JSON，stderr 是结果，失败退出非零。个人生产部署在 `/home/ubuntu/aihot/current` 使用 `--env-file=/home/ubuntu/aihot/shared/app.env` 代替本地 .env；沿[生产运维](operations/production.md)进入执行主机，不将数据库连接或凭据复制到 agent 的查询参数中。

既有部署升级仅需增量迁移 0054 和新 API，无需重建文章投影或重启采集器。迁移新增关系表及时间排序索引；先按生产流程检查锁窗口和磁盘余量。应用回滚可保留新增表/索引，不删除已配置分组；旧客户端的单 source ID、from/to、effective 行为继续有效。

## 初次构建、启用与撤销

1. 明确授权生产发布后固定发布提交，检查在途任务和既有迁移流程。执行增量迁移 0048；它建立私有投影、索引及同步触发器，不在迁移内扫描存量正文。现有表索引 DDL 仍需锁窗口，不能在未核对生产负载时直接运行。
2. 让所有写入历史准备记录的 worker 使用本版 `storePreparation` 后，在后端受控环境运行 `node scripts/research-index.ts 100`。该 CLI 会连续续批至完成；容量受限的主机应直接有界调用 buildResearchBatch，按批检查 PostgreSQL 数据/WAL 文件系统余量和实际增长，不运行无停点的全量循环。以单次数据库事务写一批并保存游标，中断后同命令继续；行锁保证一个构建者拥有当前进度。构建为旧 `preparation.dataJson` 增加安全的派生 research 标量，原串及正文不改；原材料的 NUL／孤立 surrogate 以 JSON 编码字符串保存并还原。批内串行避免同事务游标与同 identity 更新竞争。构建未完成时接口 503；读取请求不会自动构建。
3. 生成高熵专用令牌（至少 32 随机字节），在现有受控后端配置写入 SHA-256 小写十六进制摘要 `RESEARCH_TOKEN_SHA256`，不保存／输出原令牌到普通文件或日志。客户端经授权秘密载体读取 `AIHOT_RESEARCH_TOKEN`；不让用户通过对话粘贴。新增持久凭据落点需单独确认。
4. 发布 Nginx 私有 location：关闭缓存、响应临时落盘与 access log，保留 API 的脱敏错误／慢请求信号。CDN 若在链路上，核实私有前缀 bypass；不能仅凭源站 no-store 宣称 CDN 已核实。API/Web 原有代理路径也需以真实入口确认。
5. 用 CLI 验证找账号→分页→读正文→保存，核对身份集合、首尾／内容摘要和当前限制；另测无令牌／错误令牌、受限正文搜索和公开入口回归。

轮换时临时配置逗号分隔的新旧摘要，分发新令牌后移除旧摘要并重启／重载实际 API 配置。环境变量由进程启动载入；只改文件不代表生效。关闭时清空摘要并让 API 加载，随后确认匿名和旧令牌均不可读。回退应用版本不删除原始资料；保留向后兼容投影与触发器，确认旧写链可工作。旧版 worker 保存 preparation 时会移除 research 派生字段，可能令材料投影消失；再次升级须先统一新 writer，再将 research_index_state 的 article_cursor、material_cursor 置 NULL，articles_complete、materials_complete 置 false，完整重建并核对身份后才开放令牌。已完成状态下直接重跑构建 CLI 不会补扫。撤销不能收回此前已下载的资料。

索引构建失败即时以非零退出，已提交批次可恢复；只读请求错误即时反馈调用者，复用 API 5xx／慢请求日志，不建立新后台任务或独立告警服务。数据库触发器错误会使原写事务失败，须按原服务失败链定位，不静默跳过同步。

## 共享 CLI

两种 harness 共用 ai-agent-config 的 `connector-workflows query-aihot`，参数与批量导出/续取的权威用法见该 skill 的 `references/query-aihot.md`。Python 标准库 CLI 提供来源/分组发现、按名称/组/日期查询、单篇读取、批量导出与比较。当前个人部署的客户端配置位于 `~/.config/aihot/research.env`（0600、不入 Git），在同一 shell 中加载后调用 CLI，不打印令牌。隔离 HTTP 可通过显式 `--allow-localhost` 验证。私有导出包含正文，由操作者选择保存目录和保留期限，不自动上传、同步或清理旧导出。
