# AI RADAR → AIHOT：本机 MVP 与切站缺口

本文面向维护者（Developer），是持续更新的任务清单，不是已经完成的部署报告。用户于 2026-09-29 明确要求：先在本机完成部署、改造和测试，再处理 `https://news.aiplanet.live/` 的线上切换；遇到模型资源不足或数据不可读等缺口，带着可执行方案交用户决策。本文由后续执行者按实际结果更新，标记完成时附日期与验收证据；历史观察不能代替新的完成证据。

## 当前范围与完成条件

本机 MVP 的完成条件是：本机网页能打开并展示真实处理后的内容；后端通过 AIHOT 自身采集链路读取 [industry/sources.json](../industry/sources.json) 当前定义的 18 个示范 RSS；实际采用的模型经个人 llm-gateway 完成真实业务调用，应用回执可关联 Gateway 请求。启动空站、单独 HTTP 探测成功或 Gateway 健康检查正常，分别只是这些条件的局部证据。

用户在本机实施中选择“先补齐参考多模型”，因此本轮按参考分工准备资源与验证，不采用此前提出的 Ark 单模型替代。MVP 仍不要求迁入 RADAR 全部来源、导入历史内容或启用模型榜与 Codex 重置监控。当前代码的 11 个能力均可选择 `default` 模型，Embedding 可不配，这是框架能力，不是本轮已选部署方案；实际采用的模型与参数须显式记录并验证，不能把同品牌或近似名称当成等价。缺失资源导致需换模型、换来源或缩小覆盖时，由执行者提交方案与影响，用户裁决后再实施相关分支。

线上域名、反向代理、现役 RADAR 采集和数据同步保持现状；本清单不构成提前切站的授权。离线测试继续关闭采集、模型调用及外发开关；真实采集与模型验收在明确隔离的本机部署环境执行，并保留业务回执和预算熔断。

## 本机 MVP

下表记录本机实施的当前状态；「待执行」表示该项整体验收尚未完成。执行归属为当前本机 MVP 实施任务；需要用户裁决的具体项单独记录，不把其它可继续的工作合并成阻塞。

| 编号 | 状态 | 缺口与下一动作 | 依赖 | 验收证据 |
| --- | --- | --- | --- | --- |
| M01 | 部分完成 | 本机数据库、迁移、seed、API 与 Web 已运行；worker 待模型配置后启动 | [部署说明](deploy.md)；M02/M03 | 见下方本机实施记录 |
| M02 | 完成 | 用户已授权“完整同步并升级”；共享 Gateway 已安装、加载 `aihot/personal` 与参考型号目录，账本已迁至 v7 | 已完成的本机 Gateway 接入；未来生产网络归 S06 | 实际 health 的文件/加载 revision 一致，已安装 Python package 与本次源码一致；AIHOT 真实请求按个人项目记入账本，详见下方记录 |
| M03 | 部分完成，资源待决策 | DeepSeek 摘要和 GLM 高推理评分各成功一次；MiMo 实际返回 HTTP 402；百炼 4 个型号尚无个人 profile | 主线程提交补足通用 API 资源或替换模型的方案，由用户确认账户事实或裁决；用户已说明未开通百炼并要求先查 Ark，查询结果见下文 | 已测范围与请求标识见下表；没有验证全部能力、视觉或向量路径，不能由 discovery ready 推定业务可用 |
| M04 | 离线完成，真实联调部分完成 | Gateway 客户端、持久请求身份、响应关联、未知结果暂停及超时策略已实现；3 次真实请求均可关联两侧记录 | 后续覆盖随 M03 选定资源推进；M06 承接完整业务链路 | 12 项本地模拟测试；真实联调为 3 个模型各 1 次、各 1 个业务输入：2 成功、1 个 HTTP 402，应用将该失败保留为 unknown 且未重试；不宣称全覆盖 |
| M05 | 采集验证完成 | 18 个默认 RSS 已通过真实采集器解析、入库、重复采集；本机设为 2 并发 | 后续定时运行由 M01/M06 承接；长期稳定性未量测 | 18 个不同 RSS URL × 2 轮 × 1 个本机代理出口均成功；末轮新增/修订为 0，累计 508 条、无重复 URL；见下方证据路径 |
| M06 | 待执行 | 运行有界的真实内容处理链路，核对采集内容经过模型处理后进入统一公开读取层，并在本机页面显示 | M01、M03、M04、M05 | 可定位的来源条目、处理结果与回执、公开 API 和对应页面；分别记录实际触发过的筛选、摘要/理解、结构抽取、归组等阶段，未触发阶段不宣称已验收 |
| M07 | 部分完成 | 工程检查通过，网页与后台可打开；真实内容页面待 M06 验收 | M06；用户浏览器访问尚未核实 | 类型检查、数据库测试、Web 构建与测试、站点 smoke 的结果见下文；公开内容仍为空 |

### 本机实施记录（2026-09-29）

- M01：Node 26.8.1、PostgreSQL 17.11、依赖安装、35 次迁移与 seed 已完成。独立数据库位于 `/Users/lindong/research/AIHOT/.data/local-mvp/postgres`，监听 `127.0.0.1:18432`，应用库 `aihot_local`，测试库 `aihot_local_test`。API `18401` 与 Web `18400` 已启动，worker 尚未启动。
- M02/M03：用户先选择“先补齐参考多模型”和“同步共享 Gateway”，在补充披露程序与账本升级范围后，又授权“完整同步并升级”，并确认 3 份智谱凭据均属国内个人账户。installer 已从 `/Users/lindong/research/ai-agent-config-aihot` 完成安装：所比较的 52 个 Python 文件与源码无差异；账本 v6→v7，迁移前的 1 个 request / 1 个 attempt 的原有字段保留。tt-web 真实 reader 能读取迁移副本，reload 后 HTTP 200。实际 Gateway health 为正常，文件与已加载 revision 同为 `210112346cf569ab5db2a3086edade039e9476fc3a03b5b57eb0681c5e07966b`。这些读数证明本次升级与项目接入，不代表全部模型可调用。
- M04：Gateway 客户端的 12 项本地模拟测试覆盖文本/向量、普通/gzip JSON、身份正确/缺失/错误、连接/HTTP/业务校验失败和安全阀；随后通过 AIHOT `chatJson` 完成下表 3 次真实请求。请求 UUID 在发送前进入回执，响应与 Gateway 账本可关联；MiMo 的 HTTP 402 在应用侧保留 unknown，没有重试。独立审查发现的压缩响应身份兼容问题已修复并复核放行；真实完整业务链路仍待 M06。
- M05：真实采集器首轮 18/18 个不同 RSS URL 均入库，每源 8 条，共 144 条，标题与链接均非空。接着两轮强制复采分别成功 6/18、8/18，失败显示 `fetch failed`；定向诊断曾取得 `UND_ERR_CONNECT_TIMEOUT`，随后同一 OpenAI 地址连续 3 次成功。该阶段累计入库 348 条、18 个来源，无重复 URL，付费 attempts 为 0；当时只证明每源至少成功一次，后续复验结果见下一条。原始逐源证据为 `.data/local-mvp/rss-collection.json`、`rss-repeat.json`（位于原 checkout，未入 Git）。
- M05 后续：再次 8 并发复采为 8/18 成功，累计 414 条。改用 2 并发后，6 个此前超时的源定向读取均成功，再用完整采集器连续两轮读取全部 18 源，均为 18/18；累计 508 条，末轮新增与修订均为 0，无重复 URL、无付费 attempts。基于该本机共享代理上的失败/成功读数，配置 `FETCH_CONCURRENCY=2`；这只是当前缓解，不宣称已证实代理容量或长期可用率。证据为 `.data/local-mvp/rss-latest.json`、`rss-concurrency2.json`、`rss-concurrency2-repeat.json`。
- M06：等待 M03 的模型资源方案确定后启动 worker 并执行完整链路。已有 3 次单独真实模型业务调用，不等于采集到发布的链路已运行；公开内容仍为空，不将原始入库或独立调用成功当作公开发布成功。
- M07：类型检查通过；数据库测试 137 项通过（本地模拟 provider，非真实模型），压缩兼容修复后受影响的 Gateway 测试扩为 12 项并通过；Web 构建及 11 项 Web 测试通过。smoke 检查通过，模型榜 3 个入口因尚无发布轮次跳过；独立无界面浏览器实际打开首页、全部动态，成功登录后台并读到 18 个信源及采集状态，公开列表为空。MVP 整体验收尚未完成。

本机启动目录暂为隔离工作树 `/Users/lindong/research/AIHOT-local-mvp`，环境配置在其未入 Git 的 `.env` 中。API 与 Web 的 tmux 会话分别为 `aihot-local-api`、`aihot-local-web`；日志分别为 `~/.local/state/agent-web/aihot-local-api.log`、`aihot-local-web.log`。停止应用用 `tmux kill-session -t aihot-local-api` 和 `tmux kill-session -t aihot-local-web`；停止数据库用 `/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /Users/lindong/research/AIHOT/.data/local-mvp/postgres -m fast -w stop`。这些动作只作用于本机 MVP；不要删除数据库目录。`.env` 中模型全局开关仍为 false，飞书及 IndexNow 开关关闭；3 次真实模型调用仅在调用进程中显式覆盖开关，采集验证亦为本机显式调用，worker 和定时采集均未启动。

### 参考模型的当前资源与真实调用（2026-09-29）

升级后的 discovery 中，DeepSeek、MiMo、GLM 与可选 OpenAI Embedding 路由 ready，百炼 4 个型号仍无个人 profile。ready 只表示目录和路由资格，MiMo 的后续 HTTP 402 已表明它不能代替真实调用。源配置位于个人政策仓 `llm-gateway/config/registry.json`，决策见该仓 `docs/adr/20260929-e7c0-aihot-reference-model-catalog.md`。

| 型号 | 当前检查与调用 | 仍欠的动作与归属 |
| --- | --- | --- |
| `deepseek-flash` | `personal_deepseek` ready；真实摘要调用成功 1 次 | 主线程继续验证最终启用的其它业务能力；此单样本不证明模型质量 |
| `mimo-v2.6-flash` | `personal_xiaomi` ready；真实归组复核调用返回 HTTP 402 | 主线程提交补足通用 API 资源或更换复核模型的方案，用户确认账户事实或裁决；没有账户控制台读数，尚不能断言是余额不足、套餐或特定模型权限 |
| `text-embedding-3-small` | `personal_openai` ready；未调用 | 框架可选路径；是否替代参考 `text-embedding-v4` 仍由用户决定，不能写成向量已接通 |
| `glm-5.3-flash` | 国内个人账户入口已确认；高推理评分预设真实成功 1 次，返回评分 40 | 主线程按最终配置验证其它预设；本轮未测低推理内容理解、视觉或全部账户 |
| `qwen3.7-flash`、`qwen3.8-flash`、`qwen3-vl-flash`、`text-embedding-v4` | 已有 `dashscope` 型号目录，无匹配个人 profile；用户表示百炼尚未开通 | 已按用户要求查询 Ark，结果见下文；主线程提交开通百炼或明确替换模型的资源方案，待用户裁决，不预先替换 |

真实调用共 3 个模型 × 各 1 次调用 × 各 1 个业务输入，在同一本机环境完成；DeepSeek 与 GLM 的 2 次业务输出成功，MiMo 的 1 次业务输出失败。只有 GLM 高推理评分预设在本轮测过生产参数：`temperature=1`、`maxTokens=65536`、`timeout=180s`、高 `reasoning`；不能外推到全部能力、全部参数或模型质量。每个应用回执的 attempts 均为 1。

| AIHOT 回执 | 用途与模型 | Gateway logical request ID | 实际状态 |
| --- | --- | --- | --- |
| `1` | 摘要，`deepseek-flash` | `874b1371-e232-4153-a21e-bb315cde1dc1` | 应用 completed；Gateway success；费用状态 estimated |
| `2` | 归组复核，`mimo-v2.6-flash` | `466ff8b6-2407-447c-ad87-896114bf33d3` | 应用 unknown 且未重试；Gateway 请求 failed / attempt http_error，HTTP 402；费用状态 unknown |
| `3` | 高推理评分，`glm-5.3-flash` | `d0f15197-7fda-4e9f-b68e-74ebd5c0e97b` | 应用 completed；Gateway success；费用状态 unknown |

安全字段摘要保存在原 checkout `.data/local-mvp/gateway-business-calls.json` 与 `app-business-receipts.json`。回执也可从本机 PostgreSQL `127.0.0.1:18432/aihot_local` 的 `receipts` 表按上述 ID 读取；Gateway 关联记录位于 `~/.local/state/llm-gateway/audit.sqlite3` 的 `logical_requests` 与 `attempts`。仅查询业务状态和关联字段，不输出凭据。Gateway 的 estimated 不等于已对账账单，unknown 不记为零。升级前备份位于 `~/.local/state/llm-gateway/aihot-upgrade-20260929/pre-upgrade/`；当前账本已新增上述 3 次 attempt，不能用旧备份覆盖而丢失它们。

Ark 资源查询：2026-09-29 保存的官方[模型目录](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[Coding Plan 说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)和 [Agent Plan 说明](https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh)均未列出上述 4 个百炼精确型号；常规 API 目录列有 DeepSeek、GLM 与 Doubao Embedding Vision，但这是其它模型，不等同于所选 Qwen/Embedding 型号。Coding Plan 不用于普通 API 调用，Agent Plan 的文本及向量订阅也明确不用于此类 API 调用，因此不能把个人订阅当成 AIHOT 后端资源。是否采用常规付费 API 上的替代型号仍是待用户裁决的方案；本次没有据此替换模型。网页原文分别保存为原 checkout `.data/local-mvp/ark-model-list.txt`、`ark-coding-plan.txt`、`ark-agent-plan.txt`，不是账号私有权限的实测。

安装前的历史缺口已解决：当时账本为 v6，52 个源码 Python 文件有 45 个与安装包不同或缺失，完整 installer 的程序和账本升级范围因此追加披露。用户随后明确授权“完整同步并升级”，执行结果见 M02；这里保留来由，不再把它列为待审批或尚未安装。

安装前源配置检查原始结果保存在原 checkout `.data/local-mvp/models-source-readiness.json` 及逐型号 `*-source-readiness.json`。当时使用已安装 Gateway venv 的 Python 加载源码 CLI，只做静态查询；返回的 `endpoint_kind=contract_only`、`listener_status=not_asserted` 不代表后来已升级的服务状态。当前加载版本以 M02 的实际 health 核对为准，真实模型可用范围以上述调用记录为准。

## 后续改造与正式切站

S01 已由用户纳入本轮实施，其余项目先登记，尚未开始验收，由后续切换任务承接。产品范围或供应商取舍由用户决定；表中的候选路径不是已经选定的方案。只有实际选入切换范围的可选模块才成为切站前置条件。

| 编号 | 阶段 / 状态 | 缺口与下一动作 | 依赖与决策归属 | 验收条件 |
| --- | --- | --- | --- | --- |
| S01 | 已纳入本轮 / 部分完成 | 参考多模型目录与 Gateway 升级已完成；DeepSeek/GLM 各有一次成功调用，MiMo 402、百炼资源与向量路径仍待处理 | M03/M04；由本机 MVP 主线程承接，资源替换由用户裁决 | 所选型号逐一真实调用，参数与返回可用；Embedding 有真实向量及下游使用证据；未选或未调用的型号不列为已接通 |
| S02 | 信源迁移 / 待决策 | 选择并迁入 RADAR 额外的 Feed 与 Web/API 来源，保留重合源入口差异；对故障来源提出修复或替代方案 | 用户确认要保留的覆盖；M05；下文 RADAR 快照 | 所选来源逐一采集入库，来源身份与去重正确；不以 HTTP 200 或零新增直接证明完整性 |
| S03 | 信源迁移 / 待决策 | 迁移所选 X 账号与增量状态；比较复用 RADAR 官方 X API、适配 AIHOT SocialData、或经 external 推送的具体工作量与资源 | RADAR 使用官方 X API，AIHOT `x_search` 使用 SocialData；供应商、账号范围由用户裁决 | 所选账号有真实增量入库；游标、引用/回复过滤及重复处理符合确认后的范围；不得因迁移恢复已停用账号 |
| S04 | 信源迁移 / 待决策 | 迁移微信覆盖；验证复用 Wechat2RSS 的 RSS 路径，必要时比较 Dajiala 或 external 推送 | 用户确认公众号范围与接入方式；现有 Wechat2RSS 服务 | 公众号作者与原文链接保留、跨源去重正确；验证聚合窗口与拉取频率的影响；已暂停 Mp2RSS、已停用 WeWe 不自动恢复 |
| S05 | 可选模块 / 待决策 | 决定模型榜和 Codex 重置监控是否纳入交付；分别核实上游数据、凭据及模型调用 | [模块说明](leaderboard.md)；模型榜部分来源需要独立 key，监控依赖 SocialData | 启用者有真实更新与页面结果；未启用者的配置、导航与任务行为一致，不能将缺数据页面算作模块可用 |
| S06 | 生产准备 / 待决策 | 确定采集、推理、数据库与公开站点的部署位置，以及生产 worker 到个人 Gateway 的真实路径；准备目标机运行环境 | 用户确认生产拓扑；MVP 验收完成 | 在目标机启动并从实际 worker 访问 Gateway、信源和 PostgreSQL；记录运行、更新与数据备份方式；不得直接套用 RADAR 的 SQLite 快照同步脚本 |
| S07 | 历史迁移 / 待决策 | 明确 RADAR 历史文章、精选、微信原文与解读、作者、手动归档及 disabled/paused 来源历史的保留范围，实施迁移或兼容读取 | 用户确认保留范围；S06；SQLite 与 PostgreSQL 数据映射 | 已确认范围逐类核对数量、关联与公开可读结果；未迁内容有明确处置，不因只迁 active 来源而静默丢弃 |
| S08 | 兼容 / 待执行 | 清点旧详情链接、`/wechat`、RSS、公开 API 与实际消费者；确定保留、重定向或版本迁移行为 | S07；用户确认有意改变的公开行为 | 在目标服务通过旧入口访问对应内容，RSS/API 消费者可继续使用或已有确认的迁移安排；搜索与分享链接一并核对 |
| S09 | 产品配置 / 待决策 | 确认站名、品牌、首页与关于页文案、分类与精选标准、联系信息、条款隐私；替换示例内容 | 用户本人确认；[定制说明](customize.md) | 页面呈现确认后的内容；不使用原 AIHOT 名称与 Logo；若改评分标准或门槛，按 [精选与校准](selection.md) 验证 |
| S10 | 切站 / 待执行 | 在本机改造与测试完成后，准备并验证域名、`SITE_URL`、代理、HTTPS、缓存与正式流量切换；明确旧服务与数据的保留安排 | 本机验收、用户确认的 S01–S09 范围已完成；用户确认切站动作 | 从 `https://news.aiplanet.live/` 真实入口验证页面、详情、RSS/API、更新链路及 Gateway 归属；记录实际切换时间与结果，确认后再处理旧服务 |

## 2026-09-29 的起始证据

以下为上一轮审计快照，后续工作开始时应按问题所需刷新。它们解释待办的来由，不代表本机 MVP 已完成，也不承诺供应商或信源持续可用。

### 模型

审计时 Gateway 健康，但 AIHOT 项目 discovery 为 `unknown`；运行配置与个人政策仓不一致。精确型号缺口如下，provider 存在不等于型号、凭据和配额已经可用。

| AIHOT 参考型号 | 当时发现的缺口 |
| --- | --- |
| `deepseek-flash` | DeepSeek provider 存在但该型号未登记；Ark 的 `deepseek-v4-flash` 不能不经验证就当作等价 |
| `glm-5.3-flash`、`mimo-v2.6-flash` | 对应 provider 存在，精确型号未登记；`glm-5.3-flash-selection` 是参数预设，不是另一 wire model |
| `qwen3.7-flash`、`qwen3.8-flash`、`qwen3-vl-flash` | 尚无百炼 provider 与这些精确型号 |
| `text-embedding-3-small` | 个人政策仓有登记，运行配置未加载该项 |
| `text-embedding-v4` | 尚无百炼 provider 与该型号 |

MVP 采用哪些模型以完成后的 M03 记录为准。原始参数和能力映射见 [模型客户端](../packages/backend/src/providers/llm.ts)、[能力配置](../packages/backend/src/editorial/models.ts) 与 [Embedding 客户端](../packages/backend/src/providers/embeddings.ts)。

### 默认 RSS 与 RADAR 覆盖

18 个默认 RSS 在起始审计的 Mac Studio 单一代理出口、一次采样窗口中取得 HTTP 200、有效 XML 及标题/链接条目（18 个不同 URL，1 个环境，1 个窗口）。当时只做传输与格式检查，没有执行 AIHOT 采集器；后续真实采集的验收结果见 M05，这份历史探测本身不构成采集器验收。

RADAR 当时有 161 个主动采集来源身份：34 Feed、17 Web/API、109 X、1 个 Wechat2RSS 聚合入口；另有 2 个启用但暂停的身份。按内容来源对比 AIHOT 示例，额外覆盖为 24 Feed、15 Web/API、109 X 与微信聚合入口。微信近 7 天已入库覆盖 18 个公众号；聚合入口数不等于公众号数，已入库覆盖也不等于全部订阅。

额外 Feed 候选：AI as Normal Technology、Apple Machine Learning Research、Artificial Intelligence News、ByteByteGo、CMU ML、Claude Code Releases、Claude YouTube、Databricks、Dwarkesh、Gary Marcus、Google Blog AI、Google Cloud、Google Developers、Hacker News（buzzing.cc）、IT之家、Linear、MarkTechPost、Meta Engineering、Interconnects、OpenRouter、Sakana AI、Tomer Tunguz、a16z、elsewhere。

额外 Web/API 候选：Anthropic News、Anthropic Research、Claude Platform 更新、Claude Blog、Cursor、Every、HF Daily Papers、LMSYS、LangChain、Microsoft AI、Runway、Sierra、Suno、inclusionAI 模型更新、DeepSeek API 更新。Google Research、Mistral 与 AIHOT 重合但 RADAR 使用网页入口；Ars Technica、GitHub 也有不同 Feed 范围。Import AI 与 Latent Space 在 AIHOT seed 中可读、RADAR 中为 disabled 历史源，不应当成 RADAR 独有来源。

RADAR 约 24 小时的 288 轮日志显示：X 累计成功 31,385 次、失败 7 次、新增 426 条；Wechat2RSS 成功 287 次、失败 1 次、新增 72 条。Artificial Intelligence News 连续 288 次解析失败；Claude YouTube 有 26 次 HTTP 404。成功表示采集器返回成功，不证明全文、上游完整性或内容质量；这一观察支持逐源迁移验证，不能推导“RADAR 整体更可靠”。

### 生产资产

RADAR 当时为 Mac mini 采集/推理、SQLite 快照同步至腾讯云公开服务；公网健康接口报告 163,096 条内容、10,330 个精选运行记录。AIHOT 使用 PostgreSQL，替换域名不会自动保留这些数据和原有链接。以上数字仅用于说明存在迁移资产，不是未来迁移的目标计数。

### 原始记录与后续更新

原始审计记录位于本机原 checkout 的 `/Users/lindong/research/AIHOT/.data/deployment-audit/`：`gateway.md`、`radar-sources.md`、`aihot-rss-probe.json`。这些是未入 Git 的本机证据，不随 clone 分发；本页保留任务所需结论，执行时通过现役配置与数据刷新。RADAR 来源配置入口为其仓库 `data/sources.toml`，完整 X 名单与微信观察见原始 `radar-sources.md`，私有聚合 URL 和凭据不写入本文。

后续每次完成一项，在对应行更新状态与证据位置；遇到缺口，记录具体失败、可用方案、各方案影响及待用户裁决的问题。模型替换、源覆盖调整、历史舍弃和切站不能由“先让它跑起来”隐含批准。
