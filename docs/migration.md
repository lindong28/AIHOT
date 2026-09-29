# AI RADAR → AIHOT：本机 MVP 与切站缺口

本文面向维护者（Developer），是持续更新的任务清单，不是已经完成的部署报告。用户于 2026-09-29 明确要求：先在本机完成部署、改造和测试，再处理 `https://news.aiplanet.live/` 的线上切换；遇到模型资源不足或数据不可读等缺口，带着可执行方案交用户决策。本文由后续执行者按实际结果更新，标记完成时附日期与验收证据；历史观察不能代替新的完成证据。

## 当前范围与完成条件

本机 MVP 的完成条件是：本机网页能打开并展示真实处理后的内容；后端通过 AIHOT 自身采集链路读取 [industry/sources.json](../industry/sources.json) 当前定义的 18 个示范 RSS；实际采用的模型经个人 llm-gateway 完成真实业务调用，应用回执可关联 Gateway 请求。启动空站、单独 HTTP 探测成功或 Gateway 健康检查正常，分别只是这些条件的局部证据。

用户在本机实施中选择“先补齐参考多模型”，因此本轮按参考分工准备资源与验证，不采用此前提出的 Ark 单模型替代。MVP 仍不要求迁入 RADAR 全部来源、导入历史内容或启用模型榜与 Codex 重置监控。当前代码的 11 个能力均可选择 `default` 模型，Embedding 可不配，这是框架能力，不是本轮已选部署方案；实际采用的模型与参数须显式记录并验证，不能把同品牌或近似名称当成等价。缺失资源导致需换模型、换来源或缩小覆盖时，由执行者提交方案与影响，用户裁决后再实施相关分支。

线上域名、反向代理、现役 RADAR 采集和数据同步保持现状；本清单不构成提前切站的授权。离线测试继续关闭采集、模型调用及外发开关；真实采集与模型验收在明确隔离的本机部署环境执行，并保留业务回执和预算熔断。

## 本机 MVP

状态初值为「待执行」，表示下列验收尚未写入本清单，不表示并行执行者没有开展工作。执行归属为当前本机 MVP 实施任务；需要用户裁决的具体项单独记录，不把其它可继续的工作合并成阻塞。

| 编号 | 状态 | 缺口与下一动作 | 依赖 | 验收证据 |
| --- | --- | --- | --- | --- |
| M01 | 部分完成 | 本机数据库、迁移、seed、API 与 Web 已运行；worker 待模型配置后启动 | [部署说明](deploy.md)；M02/M03 | 见下方本机实施记录 |
| M02 | 源配置完成，部署待裁决 | 已选同步共享 Gateway；政策源登记 `aihot/personal`。完整 installer 还会升级程序及账本 v6→v7，超出此前披露范围，部署方式待用户裁决 | 见下方升级缺口；执行归属为本机 MVP 主线程 | 从实际 worker 环境执行项目级 discovery/readiness；项目被识别，采用路由属于个人资源，配置确已加载 |
| M03 | 目录完成，资源待补 | 已选参考多模型；精确型号已进入个人政策源。智谱缺账户 endpoint，百炼缺地域与个人凭据登记 | 用户补账户事实；M02 部署后由执行者验证认证、配额和参数 | 列出每个启用能力的 logical/native model、参数和来源；真实业务请求成功，结构化结果可被 AIHOT 消费；资源不足则提交替代方案供用户决策 |
| M04 | 离线完成，待联调 | Gateway 客户端、持久请求身份、压缩响应身份关联、未知结果暂停及超时策略已实现并过独立审查 | 真实调用依赖 M02/M03 | 12 项本地模拟测试通过；真实调用的应用回执与 Gateway 请求/attempt 对齐尚未执行 |
| M05 | 采集验证完成 | 18 个默认 RSS 已通过真实采集器解析、入库、重复采集；本机设为 2 并发 | 后续定时运行由 M01/M06 承接；长期稳定性未量测 | 18 个不同 RSS URL × 2 轮 × 1 个本机代理出口均成功；末轮新增/修订为 0，累计 508 条、无重复 URL；见下方证据路径 |
| M06 | 待执行 | 运行有界的真实内容处理链路，核对采集内容经过模型处理后进入统一公开读取层，并在本机页面显示 | M01、M03、M04、M05 | 可定位的来源条目、处理结果与回执、公开 API 和对应页面；分别记录实际触发过的筛选、摘要/理解、结构抽取、归组等阶段，未触发阶段不宣称已验收 |
| M07 | 部分完成 | 工程检查通过，网页与后台可打开；真实内容页面待 M06 验收 | M06；用户浏览器访问尚未核实 | 类型检查、数据库测试、Web 构建与测试、站点 smoke 的结果见下文；公开内容仍为空 |

### 本机实施记录（2026-09-29）

- M01：Node 26.8.1、PostgreSQL 17.11、依赖安装、35 次迁移与 seed 已完成。独立数据库位于 `/Users/lindong/research/AIHOT/.data/local-mvp/postgres`，监听 `127.0.0.1:18432`，应用库 `aihot_local`，测试库 `aihot_local_test`。API `18401` 与 Web `18400` 已启动，worker 尚未启动。
- M02/M03：用户已通过 AskUserQuestion 选择“先补齐参考多模型”和“同步共享 Gateway”。个人政策源已新增 `aihot/personal`、DeepSeek/MiMo/GLM 精确型号及百炼目录；旧运行配置、进程和账本未改变，尚无真实模型调用。安装阶段新发现的程序升级范围另行提交用户，不能把源文件登记称为已部署。
- M04：Gateway 客户端已实现，12 项本地模拟测试覆盖文本/向量、普通/gzip JSON、身份正确/缺失/错误、连接/HTTP/业务校验失败和安全阀；真实 Gateway 与业务链路尚未验收。请求 UUID 在发送前进入回执，Gateway 的未知结果不自动放行重试。独立审查发现的压缩响应身份兼容问题已修复并复核放行，无遗留 findings。
- M05：真实采集器首轮 18/18 个不同 RSS URL 均入库，每源 8 条，共 144 条，标题与链接均非空。接着两轮强制复采分别成功 6/18、8/18，失败显示 `fetch failed`；定向诊断曾取得 `UND_ERR_CONNECT_TIMEOUT`，随后同一 OpenAI 地址连续 3 次成功。累计入库 348 条、18 个来源，无重复 URL，付费 attempts 为 0。当前只证明每源至少成功一次，不能宣称持续稳定；网络间歇超时仍需复验。原始逐源证据为 `.data/local-mvp/rss-collection.json`、`rss-repeat.json`（位于原 checkout，未入 Git）。
- M05 后续：再次 8 并发复采为 8/18 成功，累计 414 条。改用 2 并发后，6 个此前超时的源定向读取均成功，再用完整采集器连续两轮读取全部 18 源，均为 18/18；累计 508 条，末轮新增与修订均为 0，无重复 URL、无付费 attempts。基于该本机共享代理上的失败/成功读数，配置 `FETCH_CONCURRENCY=2`；这只是当前缓解，不宣称已证实代理容量或长期可用率。证据为 `.data/local-mvp/rss-latest.json`、`rss-concurrency2.json`、`rss-concurrency2-repeat.json`。
- M06：等待 M02 的实际部署与 M03 的账户资源补齐后执行。未运行真实模型处理，公开内容仍为空，不将原始入库当作公开发布成功。
- M07：类型检查通过；数据库测试 137 项通过（本地模拟 provider，非真实模型），压缩兼容修复后受影响的 Gateway 测试扩为 12 项并通过；Web 构建及 11 项 Web 测试通过。smoke 检查通过，模型榜 3 个入口因尚无发布轮次跳过；独立无界面浏览器实际打开首页、全部动态，成功登录后台并读到 18 个信源及采集状态，公开列表为空。MVP 整体验收尚未完成。

本机启动目录暂为隔离工作树 `/Users/lindong/research/AIHOT-local-mvp`，环境配置在其未入 Git 的 `.env` 中。API 与 Web 的 tmux 会话分别为 `aihot-local-api`、`aihot-local-web`；日志分别为 `~/.local/state/agent-web/aihot-local-api.log`、`aihot-local-web.log`。停止应用用 `tmux kill-session -t aihot-local-api` 和 `tmux kill-session -t aihot-local-web`；停止数据库用 `/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /Users/lindong/research/AIHOT/.data/local-mvp/postgres -m fast -w stop`。这些动作只作用于本机 MVP；不要删除数据库目录。项目的模型、飞书及 IndexNow 开关均保持关闭；采集验证为本机显式调用，未启动定时采集。

### 参考模型与部署新增缺口（2026-09-29）

以下为新政策源的 CLI 静态检查，不是运行服务或厂商接受结果。`config lint` 通过，credential inventory 中已登记的 assignment names 均存在；8 个精确型号的 logical-model discovery 中 3 个 ready、5 个 unavailable。源配置位于个人政策仓 `llm-gateway/config/registry.json`，决策见该仓 `docs/adr/20260929-e7c0-aihot-reference-model-catalog.md`。

| 型号 | 源配置检查 | 仍欠的动作与归属 |
| --- | --- | --- |
| `deepseek-flash` | `personal_deepseek` eligible | 主线程在实际部署后做认证、参数和 AIHOT 业务调用验证 |
| `mimo-v2.6-flash` | `personal_xiaomi` eligible；已配官方通用 API endpoint | 主线程验证既有 key 适用性和真实调用；不由静态 ready 推定账户套餐 |
| `text-embedding-3-small` | `personal_openai` eligible | 框架可选 Embedding 路径；待部署后验证，不自行替代参考 `text-embedding-v4` |
| `glm-5.3-flash` | 三份 profile 均为 `provider_endpoint_missing` | 用户确认 `personal_zai`、`personal_zhipuai`、`personal_zhipu` 实际账户入口；执行者再配置与验证。国内和 Z.AI 国际入口不同 |
| `qwen3.7-flash`、`qwen3.8-flash`、`qwen3-vl-flash`、`text-embedding-v4` | 已有 `dashscope` 型号目录，无匹配个人 profile | 用户提供或授权登记百炼个人账户、地域及凭据的受保护存放位置；不得在对话中贴 key。执行者完成配置及调用验证 |

共享安装缺口：完整个人 installer 会更新已安装 Python package、启用此前未安装的管理 Web 配置，并可能迁移账本。当前 `~/.local/state/llm-gateway/audit.sqlite3` 实测 schema 6；共享源码为 schema 7。52 个源码 Python 文件中，45 个与安装 package 不同或缺失，比较不含静态资源及依赖。完整同步也会应用政策仓先前已有的 self-hosted 配置以及 OpenAI、DeepSeek、Ark 目录变更；此前“同步共享 Gateway”的问题只披露了旧公司项目注册移除与重启，未披露程序和账本升级，因此这一扩张由主线程携具体范围交用户决策。

源配置检查原始结果保存在原 checkout `.data/local-mvp/models-source-readiness.json` 及逐型号 `*-source-readiness.json`。执行这些只读检查使用已安装 Gateway venv 的 Python 加载当前源码 CLI；不安装依赖、不 import 或运行另一个 daemon。它们明确返回 `endpoint_kind=contract_only`、`listener_status=not_asserted`，不能拿来替代当前服务加载版本核对。

## 后续改造与正式切站

以下项目先登记，尚未开始验收，由后续切换任务承接。产品范围或供应商取舍由用户决定；表中的候选路径不是已经选定的方案。只有实际选入切换范围的可选模块才成为切站前置条件。

| 编号 | 阶段 / 状态 | 缺口与下一动作 | 依赖与决策归属 | 验收条件 |
| --- | --- | --- | --- | --- |
| S01 | 已纳入本轮 / 部分完成 | 用户选择先补齐参考多模型，已完成目录登记；真实调用与向量归组仍待资源和部署 | M02–M04；由本机 MVP 主线程承接，不作为以后才做的事项 | 所选型号逐一真实调用，参数与返回可用；Embedding 有真实向量及下游使用证据；未选的型号不列为已接通 |
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

18 个默认 RSS 在 2026-09-29 的 Mac Studio 单一代理出口、一次采样窗口中取得 HTTP 200、有效 XML 及标题/链接条目（18 个不同 URL，1 个环境，1 个窗口）。这是传输与格式检查，没有执行 AIHOT 采集器，M05 因而仍待验收。

RADAR 当时有 161 个主动采集来源身份：34 Feed、17 Web/API、109 X、1 个 Wechat2RSS 聚合入口；另有 2 个启用但暂停的身份。按内容来源对比 AIHOT 示例，额外覆盖为 24 Feed、15 Web/API、109 X 与微信聚合入口。微信近 7 天已入库覆盖 18 个公众号；聚合入口数不等于公众号数，已入库覆盖也不等于全部订阅。

额外 Feed 候选：AI as Normal Technology、Apple Machine Learning Research、Artificial Intelligence News、ByteByteGo、CMU ML、Claude Code Releases、Claude YouTube、Databricks、Dwarkesh、Gary Marcus、Google Blog AI、Google Cloud、Google Developers、Hacker News（buzzing.cc）、IT之家、Linear、MarkTechPost、Meta Engineering、Interconnects、OpenRouter、Sakana AI、Tomer Tunguz、a16z、elsewhere。

额外 Web/API 候选：Anthropic News、Anthropic Research、Claude Platform 更新、Claude Blog、Cursor、Every、HF Daily Papers、LMSYS、LangChain、Microsoft AI、Runway、Sierra、Suno、inclusionAI 模型更新、DeepSeek API 更新。Google Research、Mistral 与 AIHOT 重合但 RADAR 使用网页入口；Ars Technica、GitHub 也有不同 Feed 范围。Import AI 与 Latent Space 在 AIHOT seed 中可读、RADAR 中为 disabled 历史源，不应当成 RADAR 独有来源。

RADAR 约 24 小时的 288 轮日志显示：X 累计成功 31,385 次、失败 7 次、新增 426 条；Wechat2RSS 成功 287 次、失败 1 次、新增 72 条。Artificial Intelligence News 连续 288 次解析失败；Claude YouTube 有 26 次 HTTP 404。成功表示采集器返回成功，不证明全文、上游完整性或内容质量；这一观察支持逐源迁移验证，不能推导“RADAR 整体更可靠”。

### 生产资产

RADAR 当时为 Mac mini 采集/推理、SQLite 快照同步至腾讯云公开服务；公网健康接口报告 163,096 条内容、10,330 个精选运行记录。AIHOT 使用 PostgreSQL，替换域名不会自动保留这些数据和原有链接。以上数字仅用于说明存在迁移资产，不是未来迁移的目标计数。

### 原始记录与后续更新

原始审计记录位于本机原 checkout 的 `/Users/lindong/research/AIHOT/.data/deployment-audit/`：`gateway.md`、`radar-sources.md`、`aihot-rss-probe.json`。这些是未入 Git 的本机证据，不随 clone 分发；本页保留任务所需结论，执行时通过现役配置与数据刷新。RADAR 来源配置入口为其仓库 `data/sources.toml`，完整 X 名单与微信观察见原始 `radar-sources.md`，私有聚合 URL 和凭据不写入本文。

后续每次完成一项，在对应行更新状态与证据位置；遇到缺口，记录具体失败、可用方案、各方案影响及待用户裁决的问题。模型替换、源覆盖调整、历史舍弃和切站不能由“先让它跑起来”隐含批准。
