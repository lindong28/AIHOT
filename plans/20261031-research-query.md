# 按公众号与分组查询资料

状态：实现、审查、发布、部署与生产验收完成。任务入口为本文。运行证据存于 `/Users/lindong/task-artifacts/AIHOT/20261031-research-01a18c55/`，正文和凭据不入 Git。

## 用户目标与范围

用户要求 agent 高效按公众号名称或分组、时间取得最近文章列表和正文，用于协作、找 idea、趋势分析，优先 CLI/REST，避免每次依赖浏览器；随后授权“现在就按照以上建议修复相关缺口并完成验收”。用户明确选择“暂不预置分组：先完成分组管理和查询能力，成员由我之后指定”。

范围覆盖名称/别名解析、共享分组、多来源并集查询、明确时间口径、批量正文和部分失败、既有采集状态读取，以及按发现/更新日期查询和两次导出对比。没有要求另建采集器、MCP、自动趋势判官或改变内容访问权限。

## 现状与决策输入

AIHOT 基线 origin/main ad9bea8；现有 `research/read.ts`、`routes/research.ts`、`contracts/research.ts` 和共享 `query-aihot/aihot.py` 是正常消费者入口。既有查询只有单 source ID，按发表/发现回退时间过滤；sources 只返回 id/name/kind。后台 sources/fetch_runs 已有采集状态，不能由私有 sources 字段少推断整个系统无法判断采集状况。已有 `research_documents.updated_at` 是投影更新时刻，不能冒充完整删除/权限事件流。

既有决策载体：AIHOT plans/20261013-private-article-research-api.md（2026-10-13，生产108篇正文对账及鉴权验收），docs/private-research-api.md；未设 docs/adr 或 docs/decisions.md。ai-agent-config docs/adr、docs/issues 对 query-aihot/RESEARCH_TOKEN_SHA256/private-article-research 检索无命中，权威入口为 connector-workflows/references/query-aihot.md。保留只读 bearer、当前人工限制、原文/摘要/完整性分离、游标 live 一致性和原有默认语义。

拟定 L1 决策：扩展既有 API/CLI；以现有 PostgreSQL 保存空初始分组、成员关系、显式别名，服务端 REST 只读；具数据库权限的 `scripts/research-catalog.ts` 提供分组/别名管理，不扩大研究令牌权限。查询支持重复 source、group，先精确 ID/名称/别名解析，零匹配或歧义报结构化候选错误，不猜；多个选择器并集去重。游标绑定解析结果与时间口径。新增 timeField=effective/published/discovered/updated，effective 为旧默认，日期区间左闭右开，按所选时间排序，published 缺值不回退。返回 indexedAt/updatedAt 用于区分入库与更新；updated 是投影更新时间，不是 CDC。来源返回既有 enabled/health/最近成功/采集时间及最近一次安全采集结果，原始错误/detail 不外发。

备选：复用来源 tags 会混淆已有编辑标签与用户公众号分组；客户端单机分组不能让 REST 消费者共享；Git 配置分组需要每次部署且难以事务管理成员；在只读接口加入写操作违背已定令牌权限。现有数据库关系表及具管理权限脚本复用已有运维入口，增量迁移可随代码回滚保留。

外部复用查询：已抽样查看 miniflux/python-client、bullishlee/miniflux-exporter、harperreed/digest、mochizuki-rss、rustfeed。其类别/时间/导出交互可借鉴，直接采用会引入另一份采集存储或不同服务端协议，不能消费 AIHOT 的权限、正文完整性和游标契约；因此扩展已有客户端。不声称候选穷尽。

CLI 沿现有入口增加重复 --source/--group，--since/--until 与 --timezone，绝对日期及 last-N-days 明确归一化为有时区边界，返回实际 query。bulk export 使用最多4个读取并发（与现有共享查询容量4相符），落盘逐篇JSON/Markdown及 manifest，保留 URL/ID/revision/hash/正文完整性。单篇失败不丢其他成功结果；显式 retry-failed 有限重试，未经当前读取不把缓存当现有权限。compare 比较两份完整查询清单的新增/修订/不再出现，不把不再出现称为删除。失败、分页变化和部分正文分别体现退出状态。

生产迁移与 CLI 路径已验收，读数见下。不新增调度服务、自动采集或 LLM 调用。普通实现 A1/V1，既有权限边界保持其验收 floor；部署增量迁移依既有授权与生产规范。独立一轮 decision/change review，不扩为多轮评估。

## 顺序与验收

1. 决策审查后实现数据库/只读 API/管理脚本；隔离数据库验证名称冲突、空组、多来源去重、时间边界、游标绑定、访问限制和安全状态字段。
2. 共享 CLI 支持参数、批量导出、失败续取、增量查询/比较；本地 HTTP fixture 与真实隔离 API 验证。最小消费者路径是 CLI 按名称查两天文章并读取正文，先于全量发布检查。
3. 补齐 OpenAPI、操作说明和共享 skill 路由；typecheck、隔离数据库 tests、Web build/tests 和 smoke，单轮变更审查及定向修正。
4. 提交整合并普通 push，跟进 CI；固定已发布 origin/main 版本部署并验收真实账号名称、两账号合并、时间口径、空正式组、有限正文导出与采集状态。分组写入/删除只在隔离数据库测试，不向生产预置分类。
5. 清理本任务运行时并保留必要证据，记录 SHA/部署/消费者结果。

## 隔离与状态

自有工作树：`/Users/lindong/task-artifacts/AIHOT/20261031-research-01a18c55/aihot` 与同级 `config`；均在 codex/research-query-20261031 分支，root 已持持续占用。主树已有 WIP 保留。测试使用独立 `_test` 数据库、端口和数据目录，所有采集/模型/外发开关关闭。生产查询使用原有专用令牌及出口，不打印凭据。

功能待办及未处置 finding：无。分组内容按用户要求不预置，后续收到成员名单再配置。私树与隔离运行时由本 session 收尾回收，提交与树外证据为恢复锚；最终清理回执在任务目录 closure.json。

审查中澄清：effective 保留旧过滤 coalesce(published_at,discovered_at) 与固定 sort_at 排序；仅显式新时间轴按对应字段排序。增加 GET /groups 与 CLI groups 发现 id/name/sourceIds。compare 保存并核对 resolvedSourceIds、timeField、关键词/精选过滤、时间范围及分页完整/变化标志，拒绝不完整或不相容范围；允许不同时间窗口作比较，但不把窗口外或不再出现的资料判作删除，变化标志保留非快照提示及退出码3。

运行时：本地独立 PostgreSQL17 位于任务目录 runtime/pg，127.0.0.1:39531，数据库 aihot_research_test；基线50份迁移完成，npm ci完成。任务结束以 pg_ctl -D runtime/pg -m fast stop 回收，仅处理本任务实例。

## 本地验收与审查

完整 typecheck、Web build、19项 Web 测试通过。空测试库 aihot_research_suite_test 的全后端测试483通过、1项共享CLI路径未传而跳过；随后空库 aihot_research_cli_test 中 research + catalog 的17项全部通过，补足两个实际HTTP CLI用例。修复游标后 catalog 7项、Python CLI 15项通过；HTTP fixture 覆盖并发1/4两档及8篇结果等价，日期含两种输入形态、多页固定窗口、异常/中断保全、401/404、缺正文、比较相容和不相容范围。不是生产或全网覆盖证明。

本机真实 API/Web 的 smoke 31个入口通过、3个空库排行榜检查按既有脚本跳过。全量测试首轮误把模型总阀关闭用于需要本地mock的用例，并使用非交互系统Python3.9，造成28项失败；在不含真实凭据的隔离环境使用仓库CI相同本地stub设置及Python3.14后空库全量通过。曾重复使用累积数据的测试库导致旧builder测试1000轮上限，换新空库后17项全部通过，未修改产品或提高测试上限。微秒fixture改为text转timestamp，避免驱动Date序列化丢精度。

独立变更审查发现两项MEDIUM：中途游标结果被误标完整；100来源签名游标超过2048长度。两项均新增失败回归后修复：仅从第一页到尾页标完整，比较拒绝中途结果；游标用查询SHA256摘要保持来源及参数绑定。修后相同用例通过。原报告 decision-review.md、change-review.md 及全量日志保留在任务目录。无新采集器、自动重试或生产分组写入。

## 2026-10-31 发布与生产验收

AIHOT 功能提交 `056b551c757efb2cd15685d1f5cc3dadb950b7e4` 与共享客户端提交 `8aabc815e72bd2d1ecca61669e883e6d6b26c9d5` 均已快进整合并普通推送各自 origin/main，远端 SHA 回读一致，主树既有 WIP 内容保持。客户端通过现有 `~/.claude`／`~/.agents/skills` 共享入口生效。GitHub [41171941352](https://github.com/lindong28/AIHOT/actions/runs/41171941352) 的 check、docker 两项均 success；push 后没有对应运行时显式触发 workflow_dispatch，未将空运行列表当作成功。

生产固定上述 AIHOT 功能 SHA，发布包 SHA256 `654d91a751a1851695d9a439f4ef5dabb121e8606cc9dcf8b2e6469c12fa32e8`。在 shared/deploy.lock 下核旧 current 后构建，复用迁移器以单连接、5秒锁等待、60秒语句时限执行0054；迁移成功，三个索引均 valid，分组/别名各0。current 指向 `/home/ubuntu/aihot/releases/research-query-20261031-056b551`，API PID2042324、Web PID2042325 的 cwd 均指向新release。worker PID4020930 仍在旧 image-recovery-20261027-ad9bea8，未重启，旧release因仍在使用而保留；backfill timer active。没有 seed、模型配置、凭据或采集设置变更，迁移前磁盘可用16GB。

实际消费者为已整合的共享 CLI，通过 `https://news.aiplanet.live` 与既有专用令牌取数，未使用浏览器。来源目录46个 mp_account；groups为空。对“数字生命卡兹克”和“量子位”两账号、published时间轴、Asia/Shanghai `[2026-10-29,2026-11-01)`窗口，limit2跨页查询11篇；批量导出11/11正文为available，逐文件SHA256及0700目录/0600文件权限核对通过。两次列表的added/changed/notPresentInSecond均0；分页列表changedSinceStart=true，比较保留该标志并退出3，单页导出为false并退出0。来源目录也观察到跨页变化，均未当作事务快照。

URL解析对其中1篇返回与导出相同ID和正文；updated时间轴查询返回2条且响应声明匹配；错误令牌返回401、未知组返回400，OpenAPI为1.1.0。公网34项smoke通过。上述实测覆盖2个账号、1个发表日期窗口、published/updated两轴、分页/单页两种读取、有效/无效令牌两种；其他边界依本地合成测试，不外推全网历史、任意账号或时序。11篇正文完整性均unverified，表示取得当前留存正文，不表示已证明原文完整。分组增改删、空组和别名冲突在隔离数据库验收，生产没有为测试写入分组。

用户目标逐项状态：来源发现、按名称/别名/分组/时间查询、多来源去重分页、正文批量导出和失败续取、采集观测、更新轴与清单比较、文档接入与生产发布均完成；生产分组成员明确按用户决定留空。未处置 findings、未达成实现项均无。结果只覆盖已保留且当前允许读取的数据，updated不是删除/权限变更的完整事件流。查询/管理/导出失败即时反馈调用者并保留已有成功项，未增加无人值守任务，告警沿既有API失败面处理，不另建监控服务。
