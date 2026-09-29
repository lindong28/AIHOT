# AIHOT 与 AI Radar 对照参考 [Developer]

本文供后续在 AIHOT 基础上开发 AI Radar 的维护者使用，回答两边目前有哪些相同概念、实际算法在哪里分叉、既有能力从哪里读取。用户已明确开发方向是融合两边优势；本文记录现状，不批准某种融合算法、迁移数据或切换线上服务。

## 快照与结论边界

核对日期：**2026-09-29**。本文所有“当前”“默认”均指下表中的仓内代码与配置，不代表双方线上实际运行状态。

| 对象 | 取证身份 | 范围 |
|---|---|---|
| AIHOT 开源基线 | `589f79eff09470b31ba8a7f1d9eb62d36ff2be6c` | 当前项目继承的上游源码、`industry/` 示例配置 |
| AI Radar 对照仓 | `46026594e6d9403a1ae64596d35de57cb8c18f85` | `ai-radar` 已提交代码与 `data/sources.toml`；此前对话的 `15037b4` 已不是本次基线 |
| AI Radar 工作区 | 取证时存在额外改动 | 包括 `curator/precompute.py` 修改及微信发现相关未跟踪文件；不将这些 WIP 算作本快照的已提交能力 |
| 运行环境 | 未取证 | 未读取生产数据库、部署环境变量或后台模型配置，未验证在线信源可用性，也未运行模型评测 |

AIHOT 的 [上游说明](../../README.md) 明确开源包不包含真实信源名单和运营数据，18 个源是示范配置。因此这里能判定“源码及名单如何不同”，不能判定“已复现 AIHOT 今天线上的全部行为”。

AIHOT 侧链接相对于本文件，指向本仓文件；AI Radar 侧使用 `ai-radar:` 前缀加仓库相对路径。复核后者需要取得用户已有的 `ai-radar` 仓库及上述提交，使用 `git show 4602659:<路径>` 读取。正文保留理解差异所需的规则，不要求读者拥有原作者的本机绝对路径。

**核心结论：两边有相近的采集、预筛、评分、写作骨架和六类导航，但精选、事件组织与成刊语义没有对齐。** Radar 主链以文章评分和批次配额精选为中心；AIHOT 评分强调材料代表的事件，随后另用事实与事件实体组织多篇报道。它也仍对单篇材料评分，不能误读成“先归组，再给事件打精选分”。

## 整体架构与处理阶段

| 维度 | AIHOT | AI Radar | 对后续融合的意义 |
|---|---|---|---|
| 后端与存储 | Node.js 24 / TypeScript、PostgreSQL | Python、SQLite WAL | 业务概念可移植，数据模型与运行代码不能直接拼接 |
| 进程组织 | Fastify API、pg-boss worker、React Router SSR web | FastAPI Web/API、定时批次流水线 | 阶段数不是进程数，也不是模型调用数 |
| 模块分工 | 业务在 `packages/backend/`；行业配置在 `industry/` | `src/airadar/` 按 fetcher、prefilter、scorer、enrich、curator 等模块拆分 | 可按功能逐项映射，不必把整个 Python 项目搬入 TypeScript |
| 公开读取 | `publication/` 统一服务网页、RSS、API、MCP 等出口 | Web/API routes 与 presentation 层组装 | 继承 AIHOT 时要保留统一公开读取边界 |
| 模型与请求 | 按能力选模型；付费请求回执与预算熔断 | provider 接入 llm-gateway；阶段结果与 ruleset 记录 | 模型接入和请求核算需要明确适配边界，不能简单替换一个 URL 就视为迁移完成 |
| 行业定制 | 分类、主题、来源、prompt、门槛、品牌集中在 `industry/` | 分散在 TOML、Python prompt、词表、选择器等处 | 对照表可辅助将 Radar 的产品需求定位到新的 owning module |

工程入口：[AIHOT 架构](../architecture.md)、[公开读取层](../../packages/backend/src/publication/)、[请求回执](../../packages/backend/src/providers/receipts.ts)；Radar：`ai-radar:src/airadar/web/app.py`、`src/airadar/db.py`、`src/airadar/provider/llm_gateway.py`、`pipeline.sh`。

### AIHOT：七个逻辑环节，带并行结构抽取与信源分流

```text
采集 → 判重／补正文 → 按来源参与方式分流
  editorial → 预筛 → 两次独立评分 ─→ 分流写作 → 事件归组 → 热度／综述 → 成刊
                       └─ 并行结构抽取：分类、标签、主体、事实 ─┘
  hot_signal → 记录讨论证据 → 附着已有事件 → 参与热度
  isolated → 留存，不进入公开页面
```

按“采集、预筛、评分、写作、归组、热度与综述、成刊”计为七个主环节；结构抽取与评分并行。README 将“热点与成刊”合并，画成六步，两种计数只是粒度不同。`hot_signal` 不走完整 editorial 评分写作链，也不凭讨论自行创建事件。

代码入口：[任务分流](../../packages/backend/src/jobs/content.ts)、[分析编排](../../packages/backend/src/editorial/analyze.ts)、[事件归组](../../packages/backend/src/events/group.ts)、[报告合成](../../packages/backend/src/reports/compose.ts)。

### AI Radar：五个主阶段，加可选微信解读

```text
fetch（或独立 collect → outbox → ingest）
  → prefilter → score → enrich → curate
  → interpret（可选，只处理微信来源）

Web/API 从已有结果组装精选、热点、日报与微信页面
```

`pipeline.sh` 中的正常处理链为上述五阶段；`AI_RADAR_DECOUPLED_INGESTION=1` 时消费 ingest，采集由另一模式运行。脚本还调用 interpret，但是否实际工作取决于 `AI_RADAR_ENABLE_INTERPRET` 等开关与知识库依赖。日报不是这五阶段之外的独立模型成刊步骤。

因此，“五阶段对七环节”不是缺两个命令：实质差距在事件实体、热度信号与报告生成的职责，且 AIHOT 的结构抽取和来源分流不能遗漏。

## 算法差异

### 1. 输入材料与预筛

| 项目 | AIHOT | AI Radar |
|---|---|---|
| 正文时点 | 只有标题或订阅摘要时，先尝试补原文再判断 | 预筛与评分读已入库的 `content_text`；v2 enrich 另有正文、已采集引用与链接文章补充 |
| 评分输入 | 发布时间、原标题、正文；X 含已有引用文字，上限 60,000 字符 | source tier、source id、标题等元数据和前 5,000 字符正文 |
| 来源信息 | 评分 input 不显式传来源等级、来源名或精选门槛；正文自身可能包含来源线索 | 评分 prompt 显式带来源等级与身份 |
| 预筛输出 | `PASS / BLOCK / UNKNOWN`；不确定继续；材料不足时的 BLOCK 改为 UNKNOWN | `is_ai_related` 布尔值、confidence、reason，再叠加准入政策 |
| 硬准入 | 明确 BLOCK 停止后续处理 | HN 分数缺失或低于 100、X reply、特定仅标题 Web 条目可被规则拒绝 |
| 短帖理解 | 不单凭作者职业猜测行业相关性，依实际材料判断 | 允许结合专业来源、作者角色和提供的引用理解短分享，仍拒绝明确私人或无关主题 |

Radar 的“仅标题 Web”判据不是所有短文：实现检查 `source_kind=web`、正文等于标题且发布时间是采集时间占位，并排除 `hf_daily_papers`。不要把这条扩大解释为“所有无正文文章一律拒绝”。当前 prompt 也明确覆盖 AI 社会影响、实体产品实质 AI 能力等边界，不能仅凭布尔输出推断其范围更窄。

**输入补齐的阶段很重要：enrich 得到更多正文，不代表之前的预筛和评分会重跑并使用同一份材料。** 对齐实验必须逐阶段核对实际送入 prompt 的内容。

证据：[AIHOT 输入与评分](../../packages/backend/src/editorial/analyze.ts)、[输入上限](../../packages/backend/src/editorial/writing.ts)、[预筛 prompt](../../industry/prompts/prefilter.md)；Radar 仓根下：`src/airadar/prefilter/prompts.py`、`src/airadar/prefilter/policy.py`、`src/airadar/scorer/prompts.py`、`src/airadar/enrich/runner_v2.py`。

### 2. 评分：双次总分与单次六维不是等价方案

AIHOT 的评分 prompt 先识别七种内部内容类型：模型发布、产品发布、工具或 prompt、论文、行业事件、观点分析、教程解读。这七类服务于评分权重，不等于页面上的六个导航分类。

| 评分轴 | AIHOT 含义 | Radar 不能直接等同的原因 |
|---|---|---|
| `sig` | 实质份量 | 接近 significance，但 rubric 与权重不同 |
| `nov` | 信息增量 | density 重信息密度，不自动等于新增认知 |
| `cred` | 材料内部证据强度 | authority 强调来源一手性与可信身份 |
| `reson` | 读者共振面 | Radar 无同名独立维度 |
| `act` | 可使用、学习或迁移的价值 | engineering 侧重工程价值，覆盖面不同 |

五轴各为 0–10，按内容类型选择权重，权重之和为 10。模型内部合成 0–100 的 `attentionScore`，**只返回总分**；代码没有拿到五轴明细再做确定性加权。相同标准独立调用两次，再用总和决定入选。

Radar 的一次 scorer 调用输出六维：`relevance / density / recency / authority / engineering / significance`（历史行的 significance 可缺失）。六维齐全时，当前默认加权分为：

```text
raw_weighted_score = significance × 0.50 + density × 0.40 + authority × 0.10
relevance、recency、engineering 默认权重为 0；来源等级乘数默认关闭。
```

历史行缺少 `significance` 时，代码将剩余正权重重新归一化，默认等价于 `density × 0.80 + authority × 0.20`，而非把缺失维度当作 0。其余五个核心维度仍要求存在，缺失会报错。

维度仍被输出，不代表全部参与默认排名。Radar 针对 paper 的 `0.95` 系数作用于排序，不提高原始入选分数门槛。

证据：[AIHOT 评分标准](../../industry/prompts/selection-score.md)、[评分调用与 schema](../../packages/backend/src/editorial/analyze.ts)；Radar 仓根下：`src/airadar/scorer/schema.py`、`src/airadar/scorer/prompts.py`、`src/airadar/curator/weights.py`、`src/airadar/curator/score.py`、`src/airadar/curator/select.py`。

### 3. 入选与显示分数

| 项目 | AIHOT | AI Radar 默认 |
|---|---|---|
| 入选条件 | 两次评分之和 ≥ `2 × 来源等级门槛`，且具备可发布结果 | 按原始分构建候选池，再排序、配额填充 |
| 门槛 | T1：60；T1_5：65；T2：76；无门槛等级不做精选评分 | 先从近 48 小时内、原始分 ≥ 4.0 的最新上海日期候选取最多 36 条；再从全部去重候选中原始分 ≥ 6.5 的条目补足，补足池无上述时间限制 |
| 数量 | 此评分规则无“每轮固定 40 条”限制 | 默认每轮最多 40 条 |
| 来源配额 | 上述入选规则没有对应的批次配额 | 按配置容量计算条数上限：X 为容量的 20%，单来源为 7.5%；默认容量 40 对应 8 条、3 条 |
| 显示分数 | 两次评分均值向下取整 | 当轮入选多于一条时，按入选序列线性映射为 92–62；单条不做该映射 |
| 未入选写作 | 均分 > 50 的仍走内容理解写作，其余走简短标题摘要 | enrich 在 curate 之前；生成内容包与最终入选分开 |

Radar 的 6.5 不是所有精选统一跨越的门槛，新鲜候选可在 4.0–6.5 入选。配额分母是配置容量，不是实际入选数：批次未填满时，实际占比可超过上述百分比；它也不约束网站全部历史精选的比例。

Radar 将校准后的显示值除以 10 写回 `weighted_score`，原始值保留在 `reason.raw_weighted_score`。因此两边页面都显示“80”不表示价值评分相同；比较时要明确读的是模型总分、原始加权分、排序结果还是校准显示分。

证据：[AIHOT 门槛](../../industry/selection.ts)与[入选归一化](../../packages/backend/src/editorial/analyze.ts)；Radar：`ai-radar:src/airadar/curator/select.py` 的 `_fill`、`_calibrate_selected_scores`、`curate`。

### 4. 分类、富化与研究候选

两边均有 `model / product / industry / paper / tutorial / opinion` 六个展示主类，但产生主类的位置与输入不同。

AIHOT 的结构抽取单独调用模型，输出分类、标签、主体与事实框架，并行于评分；写作负责标题、摘要和推荐理由。结构数据随后供主题、事件归组使用。Radar v1 enrich 生成标题、摘要、推荐理由和标签；v2 在同一次富化中还生成 `primary_category` 与 `is_opinion`，并使用独立的分类 rubric 和输出归一化逻辑。

Radar 的 CLI 由 `--v2` 或 `AI_RADAR_ENRICH_V2=1` 选 v2，未启用时走 v1。离线 `eval/aihot_fit/run.py` 会调用 v2，不能据此断言线上 cron 也使用 v2；本快照未读部署环境，实际启用版本未核实。

Radar 的 C5、P1、T2、U/V 等分类研究、冻结输入、人评与版本记录是可复用研究资产。`docs/evaluations/content-enrichment/versions.md` 明确研究标记不等于正式生产版本，相关候选仍有 `formal_version=null`。实验结果不能覆盖当前运行入口；既有 AIHOT 参考分类、用户接受标签和模型预测也不能混成同一种 gold。

证据：[AIHOT 分类表](../../industry/taxonomy.ts)与[结构 prompt](../../industry/prompts/structure.md)；Radar 仓根下：`src/airadar/cli.py`、`src/airadar/enrich/prompts.py`、`src/airadar/enrich/prompts_v2.py`、`src/airadar/enrich/runner_v2.py`、`docs/evaluations/content-enrichment/versions.md`。

### 5. 事件归组、热点与日报

| 能力 | AIHOT | AI Radar |
|---|---|---|
| 事件对象 | `article → fact → story`，同次发生与后续进展分别处理 | 主链按 item 组织；URL/内容去重与关联讨论，不具备同等 fact/story 归组职责 |
| 候选召回 | 近 14 天发现的报道，向量召回候选事实；无 embedding 配置有词面分支 | 已有文章的 URL/引用链接关联，单条查询有关键词补充 |
| 合并判断 | 模型判同一事实、事件进展或无关；较低相似度合并复核；人工归属优先 | 关联列表没有建立对应的事件身份与归属 |
| 热点单位 | story；48 小时内按 `participant_key` 去重，每位参与者按最近证据时间计算 24 小时半衰期 | 入选文章；`round(weighted_score × 10 + 关联讨论数 × 5)`，另做年龄窗口过滤 |
| 热点准入 | 至少两个参与者，至少一个 editorial 参与者，并能取得公开报道 | 基于已组装的精选候选，关联讨论列表最多三条，不代表完整讨论量 |
| 日报 | 前日 08:00 至当日 08:00（北京时间），选材、生成导语／看点，保存 report 与修订 | 从已有精选按日期取数、按分类分节；“今日看点”为目录、条数与阅读时间 |
| 周报、月报 | 独立周期合成，有报告 prompt 与持久化 | 本次核对的主流水线与日报入口中没有相应模型成刊步骤 |

例如同一模型发布被五家媒体报道：AIHOT 可把报道归入同一事实／事件，参与者数量用于热度；Radar 的不同 URL、不同正文可能仍是多条文章候选。后者“能列出相关文章”不等于“已有事件聚簇”，也不能把文章精选分直接当作事件热度。

证据：[AIHOT 归组](../../packages/backend/src/events/group.ts)、[热度](../../packages/backend/src/events/hot.ts)、[报告](../../packages/backend/src/reports/compose.ts)；Radar 仓根下：`src/airadar/curator/dedup.py`、`src/airadar/presentation/related.py`、`src/airadar/web/routes/hot_cache.py`、`web/static/app.js`。

### 6. Radar 的微信与评测资产应独立盘点

Radar 的 interpret 从微信来源选取文章，运行摘要与知识库处理，保存 `wechat_interpretations`，由 `/wechat` 等入口消费；它受 `AI_RADAR_ENABLE_INTERPRET`、知识库根目录和脚本依赖控制。它不只是六类新闻富化的另一个 prompt，也不是 AIHOT `mp_account` 采集器的同义功能。

AIHOT 提供公众号采集并纳入来源参与方式控制；要保留 Radar 的微信解读、知识库状态与历史文章路径，需要单独设计映射。此次只记录这项既有职责，没有运行解读、搬运知识库，或将正在开发的微信发现 WIP 视为已完成能力。

Radar 的逐项结果、冻结输入、人工裁决及实验谱系，可帮助后续判定融合是修复还是回退；AIHOT 的 SelectBench 则直接围绕预筛、双评分和门槛校准。两者能提供互补证据，但既有 Radar 文章排名指标不能直接替代事件归组或日报质量验收。

入口：[AIHOT 校准](../selection.md)；Radar：`ai-radar:src/airadar/interpret/runner.py`、`src/airadar/web/routes/wechat.py`、`docs/evaluations/workflow.md`、`docs/evaluations/content-enrichment/category-human-review.md`。

## 数据源对照

### 能力、名单与实际运行是三层

| 层面 | AIHOT 开源包 | AI Radar 已提交配置 |
|---|---|---|
| 接口能力 | `rss / web_list / json_list / x_search / mp_account / external` 六类 | `feed / web / x / wechat` 四类；web 适配器内也包含部分 API 读取 |
| 配置条目 | 18 条，全部 RSS 示例 | 163 条：34 feed、18 web、109 X、2 微信聚合入口 |
| 开关状态 | 首次启动导入示例，后续数据库/后台管理 | 163 条均 enabled；其中 `xai_news`、`wx_mp2rss` 为 paused，即 161 条配置未暂停 |
| 来源语义 | tier、first_party、participation_mode、signal_group_id 等支持一手与热度参与者分流 | tier、kind、enabled、paused 等配置；不能自动映射为 AIHOT 的参与角色 |
| X 接入 | SocialData 搜索，可合并账号查询 | X 官方 API 或 RSS adapter |
| 微信接入 | Dajiala 按公众号接入 | Wechat2RSS / Mp2RSS 聚合 feed；另有 interpret 解读链 |

这些数量来自配置解析，**不是成功抓取数量、独立媒体数量、公众号数量或两边线上覆盖率**。尤其微信两条是依赖环境 URL 的聚合入口，不能当成两个公众号。AIHOT 18 个示范源并不展示其六种接口能力的全部用法。

证据：[AIHOT 信源说明](../sources.md)、[示范名单](../../industry/sources.json)、[配置键](../../packages/backend/src/sources/config-keys.ts)；Radar：`ai-radar:data/sources.toml`、`src/airadar/fetcher/`。

### 18 个示范源逐项对应

同 URL 的 8 项按配置字符串完全一致计数，未验证重定向、最新 feed 内容或线上可用性。等级列使用各仓自己的拼法：AIHOT `T1_5` 对应 Radar `T1.5`，不能直接照抄枚举。

| AIHOT 示例 | AIHOT 抓取 URL | Radar slug / 抓取 URL | 关系与等级 |
|---|---|---|---|
| OpenAI News | `https://openai.com/news/rss.xml` | `openai_blog`，同左 | 同 URL；T1 / T1 |
| Google DeepMind | `https://deepmind.google/blog/rss.xml` | `google_deepmind`，同左 | 同 URL；T1 / T1 |
| Hugging Face Blog | `https://huggingface.co/blog/feed.xml` | `huggingface_blog`，同左 | 同 URL；T1 / T1 |
| NVIDIA Blog | `https://blogs.nvidia.com/feed/` | `nvidia`，同左 | 同 URL；T1 / T1 |
| The Verge AI | `https://www.theverge.com/rss/ai-artificial-intelligence/index.xml` | `the_verge_ai`，同左 | 同 URL；T2 / T2 |
| TechCrunch AI | `https://techcrunch.com/category/artificial-intelligence/feed/` | `techcrunch_ai`，同左 | 同 URL；T2 / T2 |
| The Decoder | `https://the-decoder.com/feed/` | `the_decoder`，同左 | 同 URL；T2 / T2 |
| Simon Willison | `https://simonwillison.net/atom/everything/` | `simonw`，同左 | 同 URL；T2 / T1.5，等级不同 |
| Google Research | `https://research.google/blog/rss/` | `google_research`：`https://research.google/blog/` | 同栏目异入口，RSS / Web；T1 / T1 |
| GitHub Blog AI & ML | `https://github.blog/ai-and-ml/feed/` | `github_blog`：`https://github.blog/feed/` | AI 专栏 / 全站 feed；T1 / T1 |
| Mistral AI | `https://mistral.ai/rss.xml` | `mistral_news`：`https://mistral.ai/news` | 同发布方异入口，RSS / Web；T1 / T1 |
| Ars Technica AI | `https://arstechnica.com/ai/feed/` | `ars_ai`：`https://feeds.arstechnica.com/arstechnica/technology-lab` | AI / technology-lab feed；T2 / T2 |
| Microsoft Research | `https://www.microsoft.com/en-us/research/feed/` | 无对应博客订阅入口 | T1；另有 `x_msftresearch`，不等于缺少该发布方的一切来源 |
| AWS ML Blog | `https://aws.amazon.com/blogs/machine-learning/feed/` | 无对应博客订阅入口 | T1 |
| Berkeley AI Research | `https://bair.berkeley.edu/blog/feed.xml` | 无对应博客订阅入口 | T1 |
| MIT Technology Review AI | `https://www.technologyreview.com/topic/artificial-intelligence/feed` | 无对应栏目订阅入口 | T2 |
| Import AI | `https://importai.substack.com/feed` | 无对应订阅入口 | T2 |
| Latent Space | `https://www.latent.space/feed` | 无对应订阅入口 | T2 |

合计：**8 个相同 URL、4 个同发布方或栏目但异入口、6 个未配置对应订阅入口**。这个划分只覆盖 AIHOT 的 18 个示例源。Radar 另外配置 Anthropic、Cursor、DeepSeek、Hacker News、国内资讯与大量 X 账号，不能因为不在示范包里就称为多余来源。

Radar 名单文件注明来自既有 AIHOT 来源对齐样本，生产采集使用原始来源端点。这个历史来源说明不证明它等于 AIHOT 当前线上名单；RSS 与 Web、栏目与全站的差异也可能改变候选池，需要后续按实际采集样本判断覆盖。

## 对后续融合的含义

用户已经确定“以 AIHOT 为开发基础迭代 AI Radar”；以下是由代码差异得到的设计输入，不是已批准实施方案。

| 可继承或复用的部分 | 可解决的具体问题 | 仍需决定或验证 |
|---|---|---|
| AIHOT 行业包、统一公开读取、任务队列与回执 | 把行业定制、后台计算和公开出口分开 | Radar 的来源、主题、品牌、模型接入如何映射 |
| AIHOT fact/story、参与角色与衰减热度 | 区分重复报道、后续进展与纯讨论，形成事件热点 | 哪些来源应为 editorial 或 hot_signal；事件合并质量 |
| AIHOT 成刊能力 | 从逐条归档走向有导语、主题组织的刊物 | Radar 日报应保留哪些展示与选材行为 |
| Radar 来源池和微信解读 | 保留既有覆盖与知识库用途 | 活跃源、权限、来源等级、历史微信资产与入口映射 |
| Radar 人评、冻结材料与实验记录 | 用真实误差和人工偏好检验迁移效果 | 哪些标签与读数仍适用于新的评分、事件、成刊对象 |
| 两边评分与精选经验 | 提供不同的价值标准与选择机制 | 双评分或六维、按条门槛或批次配额、是否保留显示分校准 |

未决选择中最承重的是**最终选什么、如何解释分数**。把 Radar 配额、类别系数直接叠到 AIHOT 门槛上，会创造第三种算法；它不是“对齐”的自然结果。类似地，把 163 条配置全导入并默认 editorial，会改变候选量、付费调用与热点参与者含义。这些需要在后续具体开发目标中裁决。

本参考没有判断哪方内容质量更好、哪套算法应直接上线，也没有授权全量迁移。要提出质量结论，需在确定目标后，以相同材料、明确的人评口径和真实运行入口作比较；不能用阶段数、信源数量或页面分数代替这一结论。
