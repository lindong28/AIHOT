# AI 视频来源配置补充

本次按 [AIHOT 官方 AI 视频主题](https://aihot.news/topics/video)的 8 页、151 条精选清点来源，并以腾讯云 `sources` 表中的启用采集配置及 Wechat2RSS 订阅做比对。清点发生于 2026-10-06，不包括该主题另行统计的全部收录池。官方的来源名称不总是准确账号身份：Sky Computing Lab 对应的六条原文均来自 `@haoailab`，Gemini Notebook 对应 `@NotebookLM`。

## 已写入配置

`industry/sources.json` 新增以下 18 项，复用 `rss`、`web_list`、`json_list`、`x_search`，没有新增类型或修改采集器。已存在的 `rss-xai-news` 原样保留。普通网站初始间隔为 60 分钟，X 为 120 分钟；首次回灌上限均为 8 条，沿用现有预算、后续调度和内容筛选。`site_fulltext` 与 `syndicate_fulltext` 均为 false，公开摘要和原文链接。

| 来源 | ID | 接入方式 |
|---|---|---|
| Manus Blog | `radar-manus-blog` | HTML 博客卡片 |
| Black Forest Labs Blog | `radar-bfl-blog` | HTML 博客卡片 |
| ByteDance Seed Research | `radar-seed-research` | 研究页推荐博客卡片 |
| MiniMax Blog | `radar-minimax-blog` | `/blog` 列表，接受 `/blog/` 和 `/news/` 文章 |
| Gemini API 更新日志 | `radar-gemini-changelog` | 更新日志章节，保留日期锚点身份和章节正文 |
| ByteDance Seed Papers | `radar-seed-papers` | `_ROUTER_DATA` 内嵌论文 JSON，原文为论文链接 |
| Qwen Blog | `radar-qwen-blog` | 官网 `/api/v2/article/retrieval` JSON |
| FireRedTeam GitHub 新仓库 | `radar-firered-repos` | 组织仓库 JSON，排除 fork |
| inclusionAI GitHub 新仓库 | `radar-inclusionai-repos` | 组织仓库 JSON，排除 fork |
| Thinking Machines Lab Blog | `radar-thinkingmachines-blog` | 官方 RSS |
| Together AI Blog | `radar-together-blog` | 官方 RSS |
| Sam Altman Blog | `radar-samaltman-blog` | Atom |
| MarkTechPost | `radar-marktechpost` | RSS；不是停用的历史 `external` 身份 |
| ElevenLabs Blog | `radar-elevenlabs-blog` | HTML 文章卡片，排除分类和分页导航 |
| X：Hao AI Lab | `radar-x-haoailab` | `from:haoailab -filter:replies` |
| X：Jim Fan | `radar-x-drjimfan` | `from:DrJimFan -filter:replies` |
| X：NotebookLM | `radar-x-notebooklm` | `from:NotebookLM -filter:replies` |
| X：谢赛宁 | `radar-x-sainingxie` | `from:sainingxie -filter:replies` |

网站配置按发布日期排序后进入首次导入限制，避免置顶旧文占掉新文名额。GitHub 两个来源只发现最近的新仓库，不等于仓库 release、提交或研究新闻订阅；现有 inclusionAI Hugging Face 模型源仍独立保留。

## 配置覆盖不完整的部分

| 对象 | 已知边界 | 补齐方式；是否需要代码 |
|---|---|---|
| 下表公众号 | 没有真实 `feedId`，当前 Wechat2RSS 也未订阅 | 先补上游订阅并取得真实 `feedId`，再配置现有 `mp_account`；不需要新类型或采集器代码 |
| 龙猫 LongCat 名下文章 | 原文链接出现两个不同 `bizId`，不能按显示名称合并 | 先核实两个账号的真实名称；分别订阅或按核实结果处理身份，无需新增类型 |
| OpenMOSS／联合研究组 | `/blog/cn/` 可读到 12 篇真实文章，但列表及已查 MOVA 详情没有找到发布时间；也不证明覆盖全部联合机构 | 暂未加入启用配置。若找到官方带日期 RSS／JSON 或详情元数据，可用现有配置；否则要明确缺日期文章的时间口径后修改日期处理，或增加站点适配器。新增类型本身不能补出缺失日期 |
| Seed Research | 当前配置只读研究页推荐区；部分文章 slug 从中文换成英文 | 完整更新流需进一步核实官方博客列表／接口：结构符合现有解析器时补配置即可；若必须遍历分页或特殊结构，则扩展现有采集器。URL 变化的去重不能仅凭标题处理 |
| Seed Papers、GitHub、其他网站历史 | 当前配置读当前列表或 feed 窗口，通用列表采集器不自动遍历全部历史分页 | 要补历史，应做独立 backfill；自动遍历更多分页需要扩展现有 `web_list`／`json_list`，不必新增一种来源类型 |

上述 OpenMOSS 和 Seed 完整流问题归后续接入完善，本次不改变日期语义或扩大采集器能力。不能把配置解析成功当成“与官方历史内容完全一致”。

### 待订阅公众号

下列身份来自本次清点文章原文 URL 的 `__biz`；数字 ID 为其 Base64 解码值。没有编造 `feedId`，因此尚未写入启用来源清单。

| 官方显示名称 | bizId | 状态 |
|---|---|---|
| 火山引擎 | `3247557295` | 待订阅 |
| 生数科技 | `3930495401` | 待订阅 |
| 卡尔的AI沃茨 | `3871977637` | 待订阅 |
| 千问APP | `3634190101` | 待订阅 |
| 百度智能云 | `3095493199` | 待订阅 |
| 通义实验室 | `3911621034` | 待订阅 |
| 昆仑万维 | `3253154772` | 待订阅 |
| 可灵AI | `3595904568` | 待订阅 |
| 龙猫 LongCat | `2396491298`、`3621045795` | 两个身份待核实，勿合并 |

沿用[Wechat2RSS 新增流程](../operations/wechat2rss.md#新增公众号与配置生效)：从上游 `/list` 查重，对缺失账号调用 `/add/:bizId`，保存返回订阅链接中的 `feedId`，再写 `provider=wechat2rss` 的账号配置。许可证和 token 继续由中央 env 维护，不写进来源 JSON。订阅操作会改变上游运行状态，本次仓库配置补充没有执行该操作。官方 MiniMax 公众号与现有“MiniMax 稀宇科技”的 `bizId=3191077711` 相同，不重复新增。

## 生效与验证边界

生产 worker 读取 PostgreSQL 的 `sources`，不是实时读取 JSON 文件。部署包含新配置的版本后，用部署环境运行 `scripts/seed.ts` 才会插入缺失来源；已有 ID 不覆盖，且 seed 还执行原有主题和可选模型目录逻辑。更新已有来源应通过后台，不能指望重跑 seed 修改已有记录。本次没有 push、部署、修改生产数据库、增加上游订阅或发起 SocialData／模型付费调用。

来源接入后，新增文章仍需通过本站 AI 相关性筛选和精选评分；不保证官方的每篇精选在本站也入选。首次 8 条的限制不代表已经补回此前清点的全部旧文，也不是累计采集上限；后续非 X 来源沿用每轮最多 60 条的规则。

验证使用实际公开 HTTP 响应的本机离线重放，直接进入当前仓库解析器，覆盖 HTML、更新日志章节、页面内嵌 JSON、公开 JSON API、RSS 和 Atom；X 只核对账号查询与配置，不调用付费 API。这不是腾讯云网络、长期轮询、全文提取或端到端发布验收。

14 个不同网站响应快照（6 个 `web_list`、4 个 `json_list`、4 个 `rss`）共解析出 564 个标题、原文 URL 和日期齐全的候选；另核对了 4 个不同 X 账号的查询配置。Gemini 的 139 个章节各有独立锚点身份及章节正文；inclusionAI 的 30 个输入仓库排除了 2 个 fork。原有 195 项来源配置逐项保持不变，新增后共 213 个唯一 ID。每个网站只覆盖本次取得的一个响应快照，不代表未来页面结构或历史分页均可解析。

本机检查：类型检查、前端构建、11 项前端测试和 smoke 成功；来源配置测试 2 项成功，覆盖全部 213 个配置及 113 个 X 账号的去重、首次单独采集和已有水位后的分片。独立空库迁移和 seed 成功插入 213 项来源，未启动 worker。smoke 在该本机空内容库上检查页面、机器出口与 MCP，不覆盖真实文章发布。

全套后端测试初跑 343 项，316 项成功、27 项失败；其中新增账号导致的旧数量断言（109）已同步为 113，相关测试复验成功。其余 26 项涉及关闭的模型调用安全阀和本机 Python 3.9 缺少 SQLite serialize，不在本次配置任务中修改，也不声称全套测试通过。依赖安装另报告 3 项漏洞（2 moderate、1 high），本次未变更依赖或锁文件，依赖升级留待单独处理。本机验证日志保存在 `.data/video-sources/`，不纳入 Git。
