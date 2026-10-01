# AI RADAR → AIHOT：本机 MVP 与切站缺口

本文面向维护者（Developer），是持续更新的任务清单，不是已经完成的部署报告。用户于 2026-09-29 明确要求：先在本机完成部署、改造和测试，再处理 `https://news.aiplanet.live/` 的线上切换；遇到模型资源不足或数据不可读等缺口，带着可执行方案交用户决策。本文由后续执行者按实际结果更新，标记完成时附日期与验收证据；历史观察不能代替新的完成证据。

## 当前范围与完成条件

本机 MVP 的完成条件是：本机网页能打开并展示真实处理后的内容；后端通过 AIHOT 自身采集链路读取 [industry/sources.json](../industry/sources.json) 当前定义的 18 个示范 RSS；实际采用的模型经个人 llm-gateway 完成真实业务调用，应用回执可关联 Gateway 请求。启动空站、单独 HTTP 探测成功或 Gateway 健康检查正常，分别只是这些条件的局部证据。

用户在本机实施中选择“先补齐参考多模型”，因此本轮按参考分工准备资源与验证，不采用此前提出的 Ark 单模型替代。MVP 仍不要求迁入 RADAR 全部来源、导入历史内容或启用模型榜与 Codex 重置监控。当前代码的 11 个能力均可选择 `default` 模型，Embedding 可不配，这是框架能力，不是本轮已选部署方案；实际采用的模型与参数须显式记录并验证，不能把同品牌或近似名称当成等价。

模型选择规则：用户明确允许使用百炼订阅的 `qwen3.8-flash`，并确认订阅为 Token Plan 个人版；当原型号没有、但有同系列更高版本时，可直接选择该更高版本，无需重复批准，Flash 与 Pro 算不同系列。据此预筛 `qwen3.7-flash` → `qwen3.8-flash`，结构抽取也用 `qwen3.8-flash`；截至 2026-09-30 已配置，两个能力各完成 2 次真实调用，不代表质量等价。跨系列替换、来源或覆盖范围调整仍由执行者带方案交用户裁决。用户已在知晓 Token Plan 官方使用范围冲突后明确授权本机 `aihot` MVP 使用；该授权不扩至线上或其他项目，也不改变供应商条款。

线上域名、反向代理、现役 RADAR 采集和数据同步保持现状；本清单不构成提前切站的授权。离线测试继续关闭采集、模型调用及外发开关；真实采集与模型验收在明确隔离的本机部署环境执行，并保留业务回执和预算熔断。

## 2026-10-01 范围收敛与待定事项

用户已确认先采用 AIHOT 当前产品与处理逻辑，再逐步补 RADAR 优势。此节更新下方早期清单中的待决策范围，不把历史表格中的旧候选当作当前要求。

- 历史内容：只迁干净的原始材料，通过一次性脚本写入 AIHOT 原生格式，再用 AIHOT 当前逻辑 backfill；不迁 RADAR 评分、分类、标签、生成摘要、精选关系等衍生结果。原始材料盘点和费用估算见 [2026-10-01 历史盘点](references/20261001-history-backfill-audit.md)。候选 169,100 个身份不等于已完成清洗或允许全量付费运行。
- 长期格式：AIHOT 只维护一套读写格式；不默认加 RADAR 长期兼容层。一次性转换只能处理受控数据及引用，不能改写外部旧 URL；不承诺所有外部旧链接可继续访问。
- 收藏：RADAR 无服务端收藏库，浏览器 localStorage 未核查；当前不实施收藏迁移模块。
- 明确不迁移：旧日报、无限下拉、中文搜索容错、来源比例控制、RADAR 热点公式和独立 LLM 用量页面。已发布微信解读页暂不迁，新微信解读能力后补；公众号原始文章仍在盘点范围。
- 数据源持续产出仍是切站前置条件：当前代码部署、自动 worker、Wechat2RSS 迁移以及采集到公开页面的真实连续链路均由迁移实施任务承接。用户已授权目标就绪后让旧 RADAR 改读新 Wechat2RSS；须先验证旧机到新服务的可达性。
- xAI 网页保持暂停并留待修复；Mp2RSS 永久排除后续采集，此项不自动授权删除既有原文。3 个故障 Feed 的修复/处置仍待单独解决。

| Issue | 状态与归属 | 范围 |
|---|---|---|
| MIG-EVAL-001 | 待定；后续由用户决定，不阻塞切站 | 是否迁移旧评测样本、人工标注和实验结果；本轮不转换、不删除旧资产 |
| MIG-HISTORY-001 | 待实施；迁移脚本任务 | 原始字段来源、摘要/全文、日期占位、308 组同身份版本差异、公众号与 X 上下文的最终清洗和映射 |
| MIG-BUDGET-001 | 预算草案已出；全量执行前交用户裁决 | 确定可用计费路线和预算；订阅剩余额度/Credits 换算未核实，补正文与真实新流程的小批读数尚缺，不启动全量付费 |

## 本机 MVP

下表记录本机实施的当前状态；「待执行」表示该项整体验收尚未完成。执行归属为当前本机 MVP 实施任务；需要用户裁决的具体项单独记录，不把其它可继续的工作合并成阻塞。

| 编号 | 状态 | 缺口与下一动作 | 依赖 | 验收证据 |
| --- | --- | --- | --- | --- |
| M01 | 部分完成 | 本机数据库、迁移、seed、API 与 Web 已运行；11 个能力的模型环境配置已完成并重启 API；worker 与自动采集尚未启动 | [部署说明](deploy.md)；定时运行由本机 MVP 主线程继续承接 | 见下方本机实施记录与 2026-09-30 续进 |
| M02 | 完成 | 用户已授权“完整同步并升级”；共享 Gateway 已安装、加载 `aihot/personal` 与参考型号目录，账本已迁至 v7 | 已完成的本机 Gateway 接入；未来生产网络归 S06 | 实际 health 的文件/加载 revision 一致，已安装 Python package 与本次源码一致；AIHOT 真实请求按个人项目记入账本，详见下方记录 |
| M03 | 文本与原定向量模型已联调 | Token Plan 已按仅本机 `aihot` 授权接通；Qwen 预筛/结构各 2 次、GLM 评分 4 次/理解 2 次成功；原定 `text-embedding-v4` 经普通百炼个人付费资源真实调用并写入 2 个向量 | 不再等待 Embedding 资源选择；语义归组整链与其它未触发能力由主线程按后续实际范围验收 | 2 篇不同来源文章、1 个本机环境；累计 15 个回执：13 completed、1 received、1 历史 unknown；向量为 2 个 1024 维有限非零结果，不外推质量或全部能力 |
| M04 | 离线完成，真实联调部分完成 | Gateway 客户端、持久请求身份、响应关联、未知结果暂停及超时策略已实现；新增应用回执 5–14 均与实际 Gateway 账本关联 | 已测文本路径具备证据；未触发分支由后续实施承接 | 12 项本地模拟测试；新增 10 次调用各 1 attempt，项目均为 `aihot`、Gateway success、费用 unknown；历史 MiMo 402 保留 unknown 且未重试，不宣称全覆盖 |
| M05 | 采集验证完成 | 18 个默认 RSS 已通过真实采集器解析、入库、重复采集；本机设为 2 并发 | 后续定时运行由 M01/M06 承接；长期稳定性未量测 | 18 个不同 RSS URL × 2 轮 × 1 个本机代理出口均成功；末轮新增/修订为 0，累计 508 条、无重复 URL；见下方证据路径 |
| M06 | 有界内容链路已验，自动任务未启 | 2 篇真实来源文章经过预筛、双评分、结构抽取及理解后可公开读取；保留 backfill 标记，未借改标记触发新文流程；两篇标题另经应用向量入口写入数据库 | 自动 worker 与尚未触发的归组/事件/日报等由主线程后续承接 | 两篇处理均返回 pass，1 篇精选、1 篇非精选；公开页面与 API/RSS 见 2026-09-30 记录；向量生成已验，语义归组整链、质量、日报与视觉未验 |
| M07 | 本机读者验收已做，用户交付待确认 | 既有工程检查保留；已读到真实列表、AMD 详情、Grok 首页精选及点击后的详情；新一轮 smoke 与公开出口检查完成 | 用户浏览器交付与后续运行安排由主线程承接；不扩展为未启动的自动任务验收 | smoke exit 0：16 普通页面、14 机器出口、1 次 MCP 握手；模型榜 3 入口因无发布轮次跳过。此次页面阅读前后 receipts count/maxid 均为 14，只证明该窗口未新增调用 |

### 本机实施记录（2026-09-29）

以下保留当日阶段读数；后续状态以 2026-09-30 续进与上方清单为准，尤其是“尚未调用”与“公开列表为空”的当时状态。

- M01：Node 26.8.1、PostgreSQL 17.11、依赖安装、35 次迁移与 seed 已完成。独立数据库位于 `/Users/lindong/research/AIHOT/.data/local-mvp/postgres`，监听 `127.0.0.1:18432`，应用库 `aihot_local`，测试库 `aihot_local_test`。API `18401` 与 Web `18400` 已启动，worker 尚未启动。
- M02/M03：用户先选择“先补齐参考多模型”和“同步共享 Gateway”，在补充披露程序与账本升级范围后，又授权“完整同步并升级”，并确认 3 份智谱凭据均属国内个人账户。installer 已从 `/Users/lindong/research/ai-agent-config-aihot` 完成安装：所比较的 52 个 Python 文件与源码无差异；账本 v6→v7，迁移前的 1 个 request / 1 个 attempt 的原有字段保留。tt-web 真实 reader 能读取迁移副本，reload 后 HTTP 200。首次完整升级时 Gateway health 为正常，文件与已加载 revision 同为 `210112346cf569ab5db2a3086edade039e9476fc3a03b5b57eb0681c5e07966b`。这些读数证明本次升级与项目接入，不代表全部模型可调用。
- M04：Gateway 客户端的 12 项本地模拟测试覆盖文本/向量、普通/gzip JSON、身份正确/缺失/错误、连接/HTTP/业务校验失败和安全阀；随后通过 AIHOT `chatJson` 完成下表 4 次真实请求。请求 UUID 在发送前进入回执，响应与 Gateway 账本可关联；MiMo 的 HTTP 402 在应用侧保留 unknown，没有重试。独立审查发现的压缩响应身份兼容问题已修复并复核放行；真实完整业务链路仍待 M06。
- M05：真实采集器首轮 18/18 个不同 RSS URL 均入库，每源 8 条，共 144 条，标题与链接均非空。接着两轮强制复采分别成功 6/18、8/18，失败显示 `fetch failed`；定向诊断曾取得 `UND_ERR_CONNECT_TIMEOUT`，随后同一 OpenAI 地址连续 3 次成功。该阶段累计入库 348 条、18 个来源，无重复 URL，付费 attempts 为 0；当时只证明每源至少成功一次，后续复验结果见下一条。原始逐源证据为 `.data/local-mvp/rss-collection.json`、`rss-repeat.json`（位于原 checkout，未入 Git）。
- M05 后续：再次 8 并发复采为 8/18 成功，累计 414 条。改用 2 并发后，6 个此前超时的源定向读取均成功，再用完整采集器连续两轮读取全部 18 源，均为 18/18；累计 508 条，末轮新增与修订均为 0，无重复 URL、无付费 attempts。基于该本机共享代理上的失败/成功读数，配置 `FETCH_CONCURRENCY=2`；这只是当前缓解，不宣称已证实代理容量或长期可用率。证据为 `.data/local-mvp/rss-latest.json`、`rss-concurrency2.json`、`rss-concurrency2-repeat.json`。
- M06：等待 M03 的模型资源方案确定后启动 worker 并执行完整链路。已有 4 次单独真实模型业务调用，不等于采集到发布的链路已运行；公开内容仍为空，不将原始入库或独立调用成功当作公开发布成功。
- M07：类型检查通过；数据库测试 137 项通过（本地模拟 provider，非真实模型），压缩兼容修复后受影响的 Gateway 测试扩为 12 项并通过；Web 构建及 11 项 Web 测试通过。smoke 检查通过，模型榜 3 个入口因尚无发布轮次跳过；独立无界面浏览器实际打开首页、全部动态，成功登录后台并读到 18 个信源及采集状态，公开列表为空。MVP 整体验收尚未完成。

本机启动目录暂为隔离工作树 `/Users/lindong/research/AIHOT-local-mvp`，环境配置在其未入 Git 的 `.env` 中。API 与 Web 的 tmux 会话分别为 `aihot-local-api`、`aihot-local-web`；日志分别为 `~/.local/state/agent-web/aihot-local-api.log`、`aihot-local-web.log`。停止应用用 `tmux kill-session -t aihot-local-api` 和 `tmux kill-session -t aihot-local-web`；停止数据库用 `/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /Users/lindong/research/AIHOT/.data/local-mvp/postgres -m fast -w stop`。这些动作只作用于本机 MVP；不要删除数据库目录。`.env` 中模型全局开关仍为 false，飞书及 IndexNow 开关关闭；真实模型处理仅在调用进程中显式覆盖开关，采集验证亦为本机显式调用，worker 和定时采集均未启动。

### 本机实施续进（2026-09-30）

- Gateway：显式项目订阅授权与未知成本处理已提交并快进整合至共享 `llm-gateway` main（`8327581`），随后完成安装；已安装 Python 文件与该 main 一致。那次 health 的文件/加载 revision 均为 `595e86aa0e8dfb4d51b3c32588340afbde288b2ed20820471d68024ecc0f8bd1`；它与政策源 revision 的差异仅为 installer 解析 ADC 路径后的改写，现场已核对该转换。`personal_bailian_token_plan` 的 funding 为 `personal_subscription`，显式授权仅 `aihot`；installed discovery 为 ready，Qwen 候选为 `personal_bailian_token_plan/qwen3.8-flash/stream`。随后其他会话将个人政策 main 推进至 `42e0587f`（普通百炼与独立 Token Plan 凭据变量）及 `9456d271`（本地 Ollama）；当前文件/加载 revision 为 `845a042dae59ece325dff52fc4cad2b7982fc13a6d8202e247063ba15c0c963b`，保留本任务的 Token Plan exact grant。本任务复用新增普通百炼资源，未改动其他会话的资源配置。
- 代码验证边界：订阅专项 11 个方法与 4 个适配方法经独立复核通过，使用 2 scopes、4 projects、3 credential kinds、6 funding categories、16 种非法授权形状及 mock provider；不是供应商或质量测试。共享 Gateway 适配前全量运行曾为 895 tests、15 failures、54 errors、59 skipped；修复了本轮 4 个适配项，其余按原因簇在基线取得代表复现，没有重跑全套或逐项复验全部剩余 65 个失败结果，不宣称全量测试通过。具体归因保留在 `token-plan-implementation.md`，独立结论在 `token-plan-final-review.md`。
- 真实处理：文章 `yuqu7ngs1pn68j15131ax8g1g` 与 `crl9m4hbzyjpp2gcnvv6yq41o` 均返回 pass，耗时分别约 45.1 秒、23.3 秒。输入为 2 篇不同来源文章，保留 backfill 标记；这批文本处理覆盖预筛、结构抽取、双评分、理解，不包含文章归组、事件综述、日报或视觉。随后向量调用单独记录如下，不将其等同于归组整链验收。
- 回执：文本处理新增回执 5–14 均 completed 且 attempts=1；Qwen 预筛 2 次、结构抽取 2 次，GLM 评分 4 次、理解 2 次。按每个应用 request_id 查询实际 Gateway 账本，10 次均属于 `aihot`、单 attempt success，usage 已报告，费用均 unknown，不记为零、不按通用 API 价目估算订阅费用。加历史 4 次和后续 Embedding 回执 15，累计 15 个应用回执：13 completed、1 received、1 历史 unknown；不把 received 改写为 completed。
- 向量：原定 `text-embedding-v4` 已通过 AIHOT 自身 `ensureEmbeddings('article', ...)` 对上述两篇文章标题发起 1 次真实调用，使用 `personal_dashscope`、`personal_paid` 普通百炼资源，不使用 Token Plan，也不是绕开应用的直连或 fixture。得到 2 个 1024 维有限非零向量并写入本地数据库；回执 15 为 received、attempts=1，request_id 为 `7f6f04bb-e660-4ec9-8183-c55b7a297988`，usage 为 42 tokens，应用 cost 为 null。该结果证明有限输入上的向量生成与持久化，不证明语义归组质量或整条归组链路。
- 公开结果：两篇来自 2 个来源，Grok 为精选、AMD 为非精选。浏览器已实际读到 `/all` 列表、AMD 详情；独立无界面会话 `aihot-token-mvp` 读到首页 Grok 精选的 60 分、中文摘要、推荐理由和 AWS 来源，并点击首页实际链接进入 `/items/crl9m4hbzyjpp2gcnvv6yq41o`，读到中英文标题、AI 摘要、来源与作者 Suheel Farooq、评分/推荐理由、标签和原文链接。该次阅读前后应用 receipts count 与 maxid 均为 14，只证明这个阅读窗口没有新增调用。`/api/v1/items` 默认精选、`/api/v1/selected/snapshot` 与 `/feed.xml` 均 HTTP 200 且含 Grok，`/feed/all.xml` HTTP 200 且含 Grok、AMD。
- 配置与剩余范围：11 个模型能力已写入本机环境并重启 API，worker 与自动采集未启动。本机向量配置为 `EMBEDDING_MODEL=text-embedding-v4`、`EMBEDDING_DIMS=1024`、`EMBEDDINGS_ENABLED=true`，总 `MODEL_CALLS_ENABLED` 仍为 false，真实验收使用调用进程覆盖。18 个默认 RSS 的两轮采集验收仍为 2026-09-29 的记录，本次未将它改记为新一天的持续运行验证；线上 RADAR 未切换。

本次证据位于原 checkout `.data/local-mvp/`：`token-plan-installed-health.json`、`token-plan-installed-readiness.json`、`token-plan-article-processing.json`、`token-plan-business-receipts.json`、`token-plan-gateway-attempts.json`、`token-plan-linked-ledger.json`、`token-plan-public-exits.json`；后续普通百炼向量证据为 `embedding-v4-readiness.json`、`embedding-v4-business.json`、`embedding-v4-receipt.json`。这些记录与实施/独立审查报告的观察阶段不同：报告中的“尚未安装/真实调用”是移交时状态，安装和调用结果以随后对应 JSON 为准；最新运行 registry revision 以向量 readiness 中的文件/加载读数为准。

### 参考模型的当前资源与真实调用（截至 2026-09-30）

最新用户裁决：归组复核改用 `glm-5.3-flash`，初判保留 DeepSeek，既有提示词、门槛及公共代码默认不变；该本机配置决定经独立 decision-review 七项成立放行。低推理归组调用随后成功 1 次，输入是 2 篇不同来源文章组成的 1 对材料，返回 `UNRELATED`、confidence 0.99；不视为与 MiMo 质量等价。MiMo 的历史 402 与费用未知记录保留，资源修复不再是本机 MVP 前置条件。`.env` 已写入 Gateway URL/project/mode 及 group/groupReview 选择；API 重启后从实际 `/api/admin/models` 读到初判 DeepSeek、复核 GLM，来源均为 env。全局模型开关仍关闭。

用户另授权登记 `~/.claude/.env` 中的 `BAILIAN_API_KEY`，随后通过 AskUserQuestion 确认所持套餐为 Token Plan 个人版。此前仅凭 `sk-sp-` 前缀将其判为 Coding Plan 是错误的：两种订阅共用该前缀，格式检查不能区分套餐。旧名 `personal_bailian_coding_plan` 现已更正为 `personal_bailian_token_plan`；资金归属保持 `personal_subscription`。凭据已按授权复制至 git-crypt 保护的源和 `0600` 安装副本，没有改成按量付费。2026-09-29 旧安装 revision `ad114b6ebcd6615226520d822232e8c9d482bcfc0758290fe1bf177f3683a0cf` 下的不可调用状态仍保存在 `.data/local-mvp/bailian-subscription-installed-readiness.json`，这是历史快照；当前已安装显式 `aihot` 授权，且取得 4 次 Qwen 真实成功调用，见 2026-09-30 续进。

2026-09-29 核对的官方 [Token Plan 个人版说明](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview)列出 `qwen3.8-flash`，仅支持北京地域，支持列表未列出 Embedding 型号。其“订阅前须知”将使用范围限于编程/智能体工具内交互，排除自定义应用后端和非交互批调用，并说明范围外使用可能导致订阅暂停或 Key 被封禁；这与 AIHOT 后台处理场景存在冲突。官方 [Token Plan 快速开始](https://help.aliyun.com/zh/model-studio/token-plan-quickstart)当时正文为团队版，列出独立 OpenAI 兼容地址 `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`，并明确 Token Plan、Coding Plan、按量付费的 Key 与 Base URL 相互隔离；个人版入口另以[个人版快速开始](https://help.aliyun.com/zh/model-studio/token-plan-personal-quick-start)核对。用户随后在 AskUserQuestion 明确选择“仍用 Token Plan 做本机 MVP”，接受上述用途限制风险；授权仅本机 `aihot`，不扩到线上或其它项目，也不伪装客户端。显式项目 API 订阅授权及未知成本保留方案已过独立决策与实现审查、安装并完成有限真实调用；实际可用不改变已披露的供应商用途限制。

首次升级后的 discovery 中，DeepSeek、MiMo、GLM 与可选 OpenAI Embedding 路由 ready。2026-09-30 安装后的 Qwen 订阅 discovery 也为 ready，预筛和结构抽取的 `qwen3.8-flash` 选择已配置并真实调用；这并不等于原 4 个百炼参考型号都有可用资源。ready 只表示目录和路由资格，MiMo 的历史 HTTP 402 已表明它不能代替真实调用。源配置位于个人政策仓 `llm-gateway/config/registry.json`，参考目录决策见该仓 `docs/adr/20260929-e7c0-aihot-reference-model-catalog.md`；共享订阅授权决策位于 Gateway 仓 `docs/adr/20260929-f8a6-scoped-subscription-api.md`。

| 型号 | 当前检查与调用 | 仍欠的动作与归属 |
| --- | --- | --- |
| `deepseek-flash` | `personal_deepseek` ready；真实摘要调用成功 1 次 | 主线程继续验证最终启用的其它业务能力；此单样本不证明模型质量 |
| `mimo-v2.6-flash` | 真实归组复核调用返回 HTTP 402；用户已改选 GLM | 保留历史失败与原 provider 配置，MVP 不再依赖它；未核账户原因，不自行充值或重试 |
| `text-embedding-3-small` | `personal_openai` ready；未调用 | 作为未采用的候选保留；原定 `text-embedding-v4` 已接通，无需为本轮另选它 |
| `glm-5.3-flash` | 2026-09-29 评分与归组复核各成功 1 次；2026-09-30 两篇文章新增评分 4 次、理解 2 次成功 | 保留有限输入边界，不外推到视觉、全部账户、完整事件流程或模型质量 |
| `qwen3.8-flash` | 已配置用于预筛（替代 `qwen3.7-flash`）和结构抽取；`personal_bailian_token_plan` 已获仅 `aihot` 授权，两篇文章的两个能力各成功 2 次 | 当前本机选择和用途风险已由用户裁决，不重复询问；后续按实际范围运行与验收，不能外推生产使用授权 |
| `qwen3-vl-flash` | 原参考目录保留；Token Plan 个人版列表未列出该精确型号，视觉路径未验 | 不把 `qwen3.8-flash` 的视觉能力说明当成该精确型号已接通；按实际启用需求确认型号和输入路径 |
| `text-embedding-v4` | `personal_dashscope` 普通百炼个人付费路由 ready；应用真实生成并持久化 2 个 1024 维向量，回执 15 为 received、单 attempt；本机向量开关已开启，总模型开关仍关闭 | 原定资源缺口已解决，无需等待替换选择；语义归组质量与整链仍由后续实际验收覆盖 |

2026-09-29 首批真实调用为 3 个模型各 1 次，随后增加 1 次 GLM 归组复核；每次 1 个业务输入，同一本机环境，共 4 次，以下表格保留这批历史记录。GLM 高推理评分使用 `temperature=1`、`maxTokens=65536`、`timeout=180s`；低推理归组使用 `temperature=0`、业务 `maxTokens=400` 经现有客户端提升至实际 512，并读取现有 PairSchema。Schema 的默认回落意味着解析通过不能证明判断质量；不能外推到全部能力、全部参数或模型质量。每个应用回执的 attempts 均为 1。2026-09-30 新增回执 5–14 与参数记录见续进证据，不包含在这张历史四行表中。

| AIHOT 回执 | 用途与模型 | Gateway logical request ID | 实际状态 |
| --- | --- | --- | --- |
| `1` | 摘要，`deepseek-flash` | `874b1371-e232-4153-a21e-bb315cde1dc1` | 应用 completed；Gateway success；费用状态 estimated |
| `2` | 归组复核，`mimo-v2.6-flash` | `466ff8b6-2407-447c-ad87-896114bf33d3` | 应用 unknown 且未重试；Gateway 请求 failed / attempt http_error，HTTP 402；费用状态 unknown |
| `3` | 高推理评分，`glm-5.3-flash` | `d0f15197-7fda-4e9f-b68e-74ebd5c0e97b` | 应用 completed；Gateway success；费用状态 unknown |
| `4` | 低推理归组复核，`glm-5.3-flash` | `ac37c7e4-defb-434c-bfa3-fc1b7e2e41fa` | 应用 completed；Gateway success；费用状态 unknown |

首批 3 次调用的安全字段摘要保存在原 checkout `.data/local-mvp/gateway-business-calls.json` 与 `app-business-receipts.json`；第 4 次 GLM 归组调用的 Gateway 摘要位于 `glm-group-review-call.json`。回执也可从本机 PostgreSQL `127.0.0.1:18432/aihot_local` 的 `receipts` 表按上述 ID 读取；Gateway 关联记录位于 `~/.local/state/llm-gateway/audit.sqlite3` 的 `logical_requests` 与 `attempts`。仅查询业务状态和关联字段，不输出凭据。Gateway 的 estimated 不等于已对账账单，unknown 不记为零。升级前备份位于 `~/.local/state/llm-gateway/aihot-upgrade-20260929/pre-upgrade/`；本机已积累 15 个 AIHOT 调用回执，不能用旧备份覆盖而丢失后续记录。

Ark 资源查询：2026-09-29 保存的官方[模型目录](https://docs.volcengine.com/docs/ark/model-list?lang=zh)、[Coding Plan 说明](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)和 [Agent Plan 说明](https://docs.volcengine.com/docs/ark/agent-plan-personal-plan-overview?lang=zh)均未列出上述 4 个百炼精确型号；常规 API 目录列有 DeepSeek、GLM 与 Doubao Embedding Vision，但这是其它模型，不等同于所选 Qwen/Embedding 型号。Coding Plan 不用于普通 API 调用，Agent Plan 的文本及向量订阅也明确不用于此类 API 调用，因此不能把个人订阅当成 AIHOT 后端资源。是否采用常规付费 API 上的替代型号仍是待用户裁决的方案；本次没有据此替换模型。网页原文分别保存为原 checkout `.data/local-mvp/ark-model-list.txt`、`ark-coding-plan.txt`、`ark-agent-plan.txt`，不是账号私有权限的实测。

安装前的历史缺口已解决：当时账本为 v6，52 个源码 Python 文件有 45 个与安装包不同或缺失，完整 installer 的程序和账本升级范围因此追加披露。用户随后明确授权“完整同步并升级”，执行结果见 M02；这里保留来由，不再把它列为待审批或尚未安装。

安装前源配置检查原始结果保存在原 checkout `.data/local-mvp/models-source-readiness.json` 及逐型号 `*-source-readiness.json`。当时使用已安装 Gateway venv 的 Python 加载源码 CLI，只做静态查询；返回的 `endpoint_kind=contract_only`、`listener_status=not_asserted` 不代表后来已升级的服务状态。最新加载 revision 见 2026-09-30 续进的普通百炼资源记录，真实模型可用范围以上述调用记录为准。

## 后续改造与正式切站

S01 已由用户纳入本轮实施，其余项目先登记，尚未开始验收，由后续切换任务承接。产品范围或供应商取舍由用户决定；表中的候选路径不是已经选定的方案。只有实际选入切换范围的可选模块才成为切站前置条件。

2026-09-30 用户明确：信源迁移是将 RADAR 的部分来源添加到 AIHOT，不是全量照搬；Mp2RSS 今后不再使用，排除在接入、修复与恢复候选之外。此决定不授权删除旧服务或历史数据；Wechat2RSS 与其它来源仍按各自已确认的范围推进。

| 编号 | 阶段 / 状态 | 缺口与下一动作 | 依赖与决策归属 | 验收条件 |
| --- | --- | --- | --- | --- |
| S01 | 已纳入本轮 / 部分完成 | 参考目录与 Gateway 升级已完成；MiMo 复核已改为 GLM 并成功调用；Qwen 预筛/结构、GLM 评分/理解与原定百炼 v4 向量均有有限真实输入证据 | M03/M04；主线程承接未触发能力与语义归组整链验收，同系列升版依常设授权，Flash/Pro 不同系列；当前 Token Plan 授权不含生产 | 文本与向量生成已验，语义归组质量和下游整链未验；不把目录、配置或有限样本当成全部能力已验 |
| S02 | 信源迁移 / 公开来源已配置并有真实采集证据 | 保留原 18 源，新增 36 个公开来源；已有 RSS/Atom 的 Google Research、Mistral 不加网页副本，Sierra 使用 RSS；3 个故障 Feed 和暂停的 xAI 网页未擅自启用 | 当前实施主线程负责部署；故障来源与 xAI 的去留待用户裁决；逐源结果见下方记录 | 隔离验收库中 36 个不同来源各完成两轮真实采集；不外推长期更新、全文完整性或公开发布 |
| S03 | 信源迁移 / SocialData 已接通，109 个 X 账号已配置 | 用户已选择 SocialData 并提供 SOCIAL_DATA_API_KEY；原生 x_search、付费回执与水位机制继续使用，不迁旧 RADAR 游标 | 本轮主线程承接；自动 worker 仍未启动；全部账号的长期增量未验 | OpenAI、Anthropic 两个不同账号各完成 1 次真实首采，共 16 条入库、2 个 received 回执；不是 109 个账号全部实测 |
| S04 | 微信迁移 / 数据与部署代码已准备，服务未迁完 | 用户明确要求将 Wechat2RSS 所需文件和服务迁到当前机器，代码与配置模板由本仓维护；已复制 22 个订阅及登录/许可快照，Compose 和迁移脚本已验证 | 本机 OrbStack VM 启动超时待解决；目标引擎可用后，旧实例停用与现役 RADAR 消费端衔接待用户确认；本轮主线程负责其余实现 | 目标容器、登录有效性、认证 RSS 和 AIHOT 入库仍未验；操作入口见 [Wechat2RSS 运维](operations/wechat2rss.md)；Mp2RSS 永久排除 |
| S05 | 可选模块 / 待决策 | 决定模型榜和 Codex 重置监控是否纳入交付；分别核实上游数据、凭据及模型调用 | [模块说明](leaderboard.md)；模型榜部分来源需要独立 key，监控依赖 SocialData | 启用者有真实更新与页面结果；未启用者的配置、导航与任务行为一致，不能将缺数据页面算作模块可用 |
| S06 | 生产准备 / 待决策 | 确定采集、推理、数据库与公开站点的部署位置，以及生产 worker 到个人 Gateway 的真实路径；准备目标机运行环境 | 用户确认生产拓扑；MVP 验收完成 | 在目标机启动并从实际 worker 访问 Gateway、信源和 PostgreSQL；记录运行、更新与数据备份方式；不得直接套用 RADAR 的 SQLite 快照同步脚本 |
| S07 | 历史迁移 / 待决策 | 明确 RADAR 历史文章、精选、微信原文与解读、作者、手动归档及 disabled/paused 来源历史的保留范围，实施迁移或兼容读取 | 用户确认保留范围；S06；SQLite 与 PostgreSQL 数据映射 | 已确认范围逐类核对数量、关联与公开可读结果；未迁内容有明确处置，不因只迁 active 来源而静默丢弃 |
| S08 | 兼容 / 待执行 | 清点旧详情链接、`/wechat`、RSS、公开 API 与实际消费者；确定保留、重定向或版本迁移行为 | S07；用户确认有意改变的公开行为 | 在目标服务通过旧入口访问对应内容，RSS/API 消费者可继续使用或已有确认的迁移安排；搜索与分享链接一并核对 |
| S09 | 产品配置 / 待决策 | 确认站名、品牌、首页与关于页文案、分类与精选标准、联系信息、条款隐私；替换示例内容 | 用户本人确认；[定制说明](customize.md) | 页面呈现确认后的内容；不使用原 AIHOT 名称与 Logo；若改评分标准或门槛，按 [精选与校准](selection.md) 验证 |
| S10 | 切站 / 待执行 | 在本机改造与测试完成后，准备并验证域名、`SITE_URL`、代理、HTTPS、缓存与正式流量切换；明确旧服务与数据的保留安排 | 本机验收、用户确认的 S01–S09 范围已完成；用户确认切站动作 | 从 `https://news.aiplanet.live/` 真实入口验证页面、详情、RSS/API、更新链路及 Gateway 归属；记录实际切换时间与结果，确认后再处理旧服务 |

### 信源迁移实施记录（2026-09-30）

用户本轮要求补齐 RADAR 独有来源、已有 RSS/Atom 不加网页副本、优先 AIHOT 原生处理；SocialData 已由用户指定，Wechat2RSS 整体迁到当前机器。`industry/sources.json` 现有 163 个身份：原 18 个 RSS、新增 22 个 RSS（含 Sierra）、10 个 web_list、4 个 json_list、109 个 X。所有来源全文展示均关闭。这里只记录信源能力迁移，不将采集入库等同于模型处理和公开发布。

公开源：新增 36 个不同入口在本机同一代理环境经原生 `collectSource` 完成两轮。首轮 268 篇；第二轮从首采上限 8 扩至普通采集窗口，新增 772 篇、修订 1 篇。合并两个 X 样本后，隔离库 `aihot_source_acceptance` 为 38 个有文章的来源、1,056 篇，均有发布时间，重复 identity_key 分组为 0。发布时间存在不代表全部来自首发日期：inclusionAI 延续 RADAR 的模型更新时间语义。Every 保留 RADAR 的四类路径筛选，本轮返回 3 篇，不自行扩张覆盖。修复 Flight 嵌套数组解析和 Claude Platform 标题装饰污染日期两处真实失败。

X：新增 109 个原 RADAR active 账号使用原生 x_search，保留回复/转推过滤，首次每源最多入库 8 条。无水位时单源初始化，有水位后进入既有分片机制。OpenAI、Anthropic 各取得 20 条响应并入库 8 条，两个回执均 received、单 attempt；应用按返回对象记的估算费用合计 USD 0.008，未与供应商账单对账。凭据文件位于主 checkout 的 `.data/credentials/collectors.env`（0600），使用 canonical 名；代码亦接受用户的 `SOCIAL_DATA_API_KEY` 别名，调度判断已同步。没有启动自动付费采集。

微信：初始快照为 22 个订阅、2,107 篇；随后用本仓 `snapshot.py` 实跑取得 22 个订阅、2,113 篇，SQLite 完整性正常，位于主 checkout `.data/wechat2rss/final-script-check-20260930/`。运行中的旧实例仍会产生更新，这不是最终切换快照。脚本使用只读 SQLite backup 合入 WAL；本机系统 SQLite 对无 sidecar 的 WAL 格式快照以普通只读打开失败，静态快照改用 immutable 校验后成功。Compose 配置离线校验成功；登记脚本在测试库验证了缺 token 拒绝、新建与重复登记保留停用状态/游标。目标容器尚未启动，旧服务未停，健康探针与告警迁移仍归本轮主线程承接，不因部署模板存在而记完成。

待用户裁决的覆盖：AI News、MarkTechPost 当前访问返回 403，Claude YouTube feed 返回 404（另一路直连失败）；暂停 xAI 官方 News 网页在当前访问路径遇到 403/验证页。以上不是全网不可用结论，且用户尚未裁决排除或改入口，故暂不加入启用清单。Mp2RSS 按用户决定不接入。

代码验证：类型检查通过；全量离线后端测试 144 项通过（本机 PostgreSQL、fixture/mock provider），Web 构建及 11 项 Web 测试通过。来源专项覆盖 163 个配置、X 无水位/有水位两种状态及 Flight/普通 JSON/空数组/缺 key/损坏数组/日期标题的本地响应；SocialData 调度另验证 canonical、alias、无 key 三种状态。独立审查没有 CRITICAL/HIGH，发现的别名调度遗漏已修复。既有 `18400` 站点 smoke 成功、模型榜 3 入口跳过，该读数属于既有部署，不是新增来源的公开页面验收。

逐源证据保存在实施 worktree `.data/source-import/`：`public-first-import.json`、`public-acceptance.json`（第二轮）、`public-rows.json`、`x-acceptance.json`、`tests-final.log`、`web-build.log`、`web-tests.log`。私有资产与日志不提交 Git。正式域名与现役 RADAR 的采集/发布安排未修改。

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

后续每次完成一项，在对应行更新状态与证据位置；遇到缺口，记录具体失败、可用方案、各方案影响及待用户裁决的问题。同系列模型升版按上文已获授权的选择规则执行；跨系列替换、源覆盖调整、历史舍弃和切站不能由“先让它跑起来”隐含批准。
