# 私有文章资料 API

用于查询服务实际保留、允许私有访问的资料。覆盖正式文章与在线 `backfill_items` 材料，包含自动过滤和未精选内容；排除人工撤回，“仅摘要”记录不搜索或返回正文。公开网站、RSS、MCP 的发布与全文许可不改变。不代表任何来源的全网历史，不遍历备份，也不恢复已清除内容。

## 读取入口

HTTPS 请求携带 `Authorization: Bearer <专用令牌>`。令牌不是管理员会话或 ingest 凭据。所有响应 `Cache-Control: no-store`；不设跨域授权，不跟随客户端重定向。协议的权威定义是 `packages/contracts/src/research.ts`，部署后通过鉴权的 `GET /api/private/v1/openapi.json` 读取。

| 路径（前缀 /api/private/v1） | 参数 | 用途 |
| --- | --- | --- |
| GET /sources | q、kind、limit、cursor | 找来源／账号 ID |
| GET /articles | source、q、from、to、selected、limit、cursor | 来源、全文和时间过滤；元数据及匹配片段 |
| GET /articles/{id} | format=json 或 markdown | 读取稳定资料 ID 或 native article ID |
| GET /articles/resolve | url、format | 本地规范化 URL 后定位，不对输入 URL 发请求 |

每页默认 40、最多 100；关键词最长 256 字符，最多六个空白分隔词，按字面、忽略大小写 AND 匹配标题、生成摘要或完整已存正文文本；不截在 12,000 字。日期为含时区 ISO 8601，from 包含、to 不包含。未生成 publication 的资料 selected=false。正文不随列表整篇传输，详情不静默截断。

搜索索引候选会在解码后复核，避免将 JSON 转义误认成原文字词，因此一页可能少于 limit，甚至为空；只有 nextCursor=null 才表示遍历结束。JSON 导出保留原始 code unit，特殊 Unicode 使用 JSON 转义后可还原；需要严格保真存档时使用 JSON，Markdown 是阅读呈现。

`id` 为 `doc_` 加 URL identity 的 SHA-256，材料提升为文章后保持不变；`articleId` 是当前文章 ID 或 null。`sourceId` 是唯一可核实的账号身份，`collectionSourceId` 保留真实采集来源；历史公众号由两个已知归档来源、微信 URL 和唯一作者名映射，重名或未知不猜测合并。

尚未完成 preparation 的记录从冻结版本中首个有材料的版本提供已存原文，标记 `origin=material`；正式文章或已准备 material 优先。原版本顺序决定该读取版本，不把多个版本拼接，也不把自动预筛 BLOCK 当撤回。已清除且无原来源元数据的记录仅保留身份墓碑，来源可为 unknown。原 URL 定位优先查库中存在的片段身份，章节受限时不会回退到父页面。

`title` 为保存的原标题；`generatedTitle`、`summary` 为当前修订的生成结果；`body` 为已存原文，译文在 `translations` 单列。`bodyStatus` 是 available/missing/discarded/restricted，分别表示可返回、缺失、清除、正文受限。`completeness.state` 是 complete/incomplete/unverified，依据匹配版本的审核证据，而不是字数、非空或旧准备流程的 selected 标记；没有证据仍可读取，但报告 unverified。

分页按初次索引的发表时间（缺失时发现时间）及稳定 ID 排序，`sortAt` 保持不变，当前 `publishedAt`、`discoveredAt`、`timeBasis` 独立返回。游标签名绑定过滤条件、初次查询截止时间和原令牌；更换过滤条件／令牌须重开查询。开始后的新 identity 留到下一轮；旧资料的权限、清除、修订使用当前读取事务。每页是只读 repeatable-read，跨页不是事务快照，也没有固定总数。`changedSinceStart` 使用数据库快照身份保守判变，无关数据库写入也可能使它为 true；客户端应标记并重新核对，不把结果宣称为固定快照取全。

400 表示参数／游标错误；401 表示无效或已撤销令牌；404 不区分未配置、受限与不存在；503 表示索引未就绪、容量忙或服务不可用。搜索共用既有容量保护（默认同时 4、排队 8），不会额外无限占用数据库连接。

## 初次构建、启用与撤销

1. 明确授权生产发布后固定发布提交，检查在途任务和既有迁移流程。执行增量迁移 0048；它建立私有投影、索引及同步触发器，不在迁移内扫描存量正文。现有表索引 DDL 仍需锁窗口，不能在未核对生产负载时直接运行。
2. 让所有写入历史准备记录的 worker 使用本版 `storePreparation` 后，在后端受控环境运行 `node scripts/research-index.ts 100`。该 CLI 会连续续批至完成；容量受限的主机应直接有界调用 buildResearchBatch，按批检查 PostgreSQL 数据/WAL 文件系统余量和实际增长，不运行无停点的全量循环。以单次数据库事务写一批并保存游标，中断后同命令继续；行锁保证一个构建者拥有当前进度。构建为旧 `preparation.dataJson` 增加安全的派生 research 标量，原串及正文不改；原材料的 NUL／孤立 surrogate 以 JSON 编码字符串保存并还原。批内串行避免同事务游标与同 identity 更新竞争。构建未完成时接口 503；读取请求不会自动构建。
3. 生成高熵专用令牌（至少 32 随机字节），在现有受控后端配置写入 SHA-256 小写十六进制摘要 `RESEARCH_TOKEN_SHA256`，不保存／输出原令牌到普通文件或日志。客户端经授权秘密载体读取 `AIHOT_RESEARCH_TOKEN`；不让用户通过对话粘贴。新增持久凭据落点需单独确认。
4. 发布 Nginx 私有 location：关闭缓存、响应临时落盘与 access log，保留 API 的脱敏错误／慢请求信号。CDN 若在链路上，核实私有前缀 bypass；不能仅凭源站 no-store 宣称 CDN 已核实。API/Web 原有代理路径也需以真实入口确认。
5. 用 CLI 验证找账号→分页→读正文→保存，核对身份集合、首尾／内容摘要和当前限制；另测无令牌／错误令牌、受限正文搜索和公开入口回归。

轮换时临时配置逗号分隔的新旧摘要，分发新令牌后移除旧摘要并重启／重载实际 API 配置。环境变量由进程启动载入；只改文件不代表生效。关闭时清空摘要并让 API 加载，随后确认匿名和旧令牌均不可读。回退应用版本不删除原始资料；保留向后兼容投影与触发器，确认旧写链可工作。旧版 worker 保存 preparation 时会移除 research 派生字段，可能令材料投影消失；再次升级须先统一新 writer，再将 research_index_state 的 article_cursor、material_cursor 置 NULL，articles_complete、materials_complete 置 false，完整重建并核对身份后才开放令牌。已完成状态下直接重跑构建 CLI 不会补扫。撤销不能收回此前已下载的资料。

索引构建失败即时以非零退出，已提交批次可恢复；只读请求错误即时反馈调用者，复用 API 5xx／慢请求日志，不建立新后台任务或独立告警服务。数据库触发器错误会使原写事务失败，须按原服务失败链定位，不静默跳过同步。

## 共享 CLI

两种 harness 共用 ai-agent-config 的 `connector-workflows query-aihot`。Python 标准库 CLI 提供 sources/search/read、--all、--cursor 与 --output；保存成功才原子替换 0600 文件，失败和中断不把部分输出当成完成。当前个人部署已启用；本机已授权配置位于 `~/.config/aihot/research.env`（0600、不入 Git），在同一 shell 中加载后调用 CLI，不打印令牌。隔离 HTTP 可通过显式 `--allow-localhost` 验证。
