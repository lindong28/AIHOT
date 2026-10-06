# 2026-10-06 官方来源缺口清点

本次查询官方公开 API 的全部动态（含非精选），收录时间为北京时间 / 新加坡时间 **2026-10-04 18:26 至 2026-10-06 18:26**。共翻完 25 页、2,447 条七天公开动态；其中窗口内 555 条，归为 115 个来源身份。生产数据库基线是本轮只读导出的 239 条来源，其中启用 223 条。

脚本初筛：44 个未配置（21 个 X 账号、23 个网站／频道）、43 个账号已配置、1 个聚合渠道已配置、27 个同站点待核范围；无停用匹配和无法识别账号。

人工核对同站点候选后，再确认一个缺口：**Codex GitHub Releases**。官方原文是 `github.com/openai/codex/releases/...`；我们的 `radar-claude-code-releases` 只读 `anthropics/claude-code/releases.atom`，虽同为 github.com，不是同一来源。因此本次明确缺口为 **45 个：21 个 X 账号、24 个网站／频道**。

另有 **Hacker News：AI 热帖**（6 条）需要核对官方选帖链路；我们已有 buzzing.cc 热门渠道，不能据此确认两者覆盖等价。这是渠道范围待核项，不把它的每个原文域名都算成新来源。

其余 25 个网站组存在对应站点配置；本次未逐篇验证 RSS 栏目或实时采集健康。近期观测到的两个公众号（数字生命卡兹克 biz 3223096120、可灵 AI biz 3595904568）均已接入，**这个窗口没有发现新增公众号缺口**，不代表官方所有公众号均已覆盖。

Artificial Intelligence News 与 Claude YouTube 是先前迁移中已记录但未启用的来源（见 [迁移记录](../migration.md)）；此处只重新确认覆盖缺口，不沿用旧故障读数断言当前不可接。OpenMOSS 此窗口未出现，其 [已有 Issue](../issues/general.md#issue-source-20261006-openmoss) 继续保留，不在本次新增来源范围。

本次仅查询与生成工具，没有新增来源、部署或执行 backfill。完整机器快照留在 `.data/source-gap-audit/live/`，最终分组在 `.data/source-gap-audit/final/`；以下保留可随 repo 查阅的来源表。复跑入口：[来源缺口审计](../operations/source-gap-audit.md)。

## 脚本原始分组

收录窗口：2026-10-04T10:26:34.851619+00:00 至 2026-10-06T10:26:34.851619+00:00（discoveredAt）。

比较基线：tencent-webserver-china production sources table；223 个启用来源。扫描 25 页、2447 条去重公开动态，窗口内 555 条、115 个来源身份。

范围：官方 mode=all 的公开动态（包含非精选）；不是内部采集库。完整翻完 API 的 7 天时间轴窗口后按收录时间筛选；已删除、隐藏、过滤掉的内容与窗口外条目不可见。分页不是事务快照。

账号已配置不等于采集健康；网站同域名不证明栏目、过滤规则或文章覆盖相同。此审计不能证明某来源是官方最近新添加的。

未配置 44 · 已停用 0 · 身份待核实 0 · 同站点，需核对范围 27 · 账号已配置 43 · 渠道已配置 1

## 未配置

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|
| x:dair_ai<br>X：DAIR.AI (@dair_ai) | 7 | — | [官方文章](https://aihot.news/items/jcofviov32m3dyzgc3dyapaxb) · [原文](https://x.com/dair_ai/status/2107264582687584567) |
| web:PyTorch：Blog（RSS）<br>PyTorch：Blog（RSS） | 6 | — | [官方文章](https://aihot.news/items/nc1bt76s55iscek4kd86d0li8) · [原文](https://pytorch.org/blog/pytorch-hardware-enablement-updates-from-the-acceleration-integration-working-group/) |
| x:cursor_ai<br>X：Cursor (@cursor_ai) | 5 | — | [官方文章](https://aihot.news/items/njaifxrgpc37o8z5p4yq3q62j) · [原文](https://x.com/cursor_ai/status/2107141004482793827) |
| web:Azeem Azhar：Exponential View（RSS）<br>Azeem Azhar：Exponential View（RSS） | 4 | — | [官方文章](https://aihot.news/items/pqxbt80vhep00dsjnfiuxr6nn) · [原文](https://www.exponentialview.co/p/monday-data-more-ai-more-justice) |
| x:_philschmid<br>X：Philipp Schmid（Google DeepMind 开发者体验） (@_philschmid) | 4 | — | [官方文章](https://aihot.news/items/hn21wr0rndgqbfviuq09coumi) · [原文](https://x.com/_philschmid/status/2106063943479275815) |
| x:cognition<br>X：Cognition (@cognition) | 4 | — | [官方文章](https://aihot.news/items/lucbutb5rb39er8w8t1ramy8c) · [原文](https://x.com/cognition/status/2107223202393166166) |
| x:elevenlabs<br>X：ElevenLabs (@elevenlabs) | 4 | — | [官方文章](https://aihot.news/items/hcy9kryi32i5x708bqrvn709l) · [原文](https://x.com/ElevenLabs/status/2107125925704045038) |
| x:fal<br>X：fal (@fal) | 4 | — | [官方文章](https://aihot.news/items/gpbyftaekhxj0p0b2o8zr6l4w) · [原文](https://x.com/fal/status/2107350357361770548) |
| x:figure_robot<br>X：Figure AI (@Figure_robot) | 4 | — | [官方文章](https://aihot.news/items/f2ong3teje7v0ed8qxei17g6s) · [原文](https://x.com/Figure_robot/status/2105317708539830678) |
| x:khazix0918<br>X：卡兹克 (@Khazix0918) | 4 | — | [官方文章](https://aihot.news/items/ct2x9uvkbu16v7tgqu0996cdr) · [原文](https://x.com/Khazix0918/status/2107395576321208577) |
| x:pixverse<br>X：PixVerse (@PixVerse) | 4 | — | [官方文章](https://aihot.news/items/dafgb11i2n1qtys5y4vuc8la4) · [原文](https://x.com/PixVerse/status/2107078408014549448) |
| web:404 Media（RSS）<br>404 Media（RSS） | 3 | — | [官方文章](https://aihot.news/items/tl4c59as0f69lb25k9mwlr9bk) · [原文](https://www.404media.co/muse-escapes-containment/) |
| web:ChinaTalk（RSS）<br>ChinaTalk（RSS） | 3 | — | [官方文章](https://aihot.news/items/hklpccrihxu4oj64cvs7je2ht) · [原文](https://www.chinatalk.media/p/chinas-ai-safety-money-problem) |
| web:Artificial Intelligence News（网页）<br>Artificial Intelligence News（网页） | 2 | — | [官方文章](https://aihot.news/items/pm416u91q0rsgepa8wgmoq8t3) · [原文](https://www.artificialintelligence-news.com/news/17-countries-ai-priorities-for-government-science-research/) |
| web:Claude：YouTube（RSS）<br>Claude：YouTube（RSS） | 2 | — | [官方文章](https://aihot.news/items/ym1ys8pi35i8o7emy8g0u5f4n) · [原文](https://www.youtube.com/watch?v=yUuFvL1lK4k) |
| web:Factory 研究 / 产品（RSS）<br>Factory 研究 / 产品（RSS） | 2 | — | [官方文章](https://aihot.news/items/e4n1al91nv5j72b9ye62o5cx4) · [原文](https://factory.com/news/factory-analytics-transparency) |
| web:Google AI：DEV 作者专属（RSS）<br>Google AI：DEV 作者专属（RSS） | 2 | — | [官方文章](https://aihot.news/items/jy0birbe79iqblgaw46j52ldt) · [原文](https://dev.to/googleai/activating-your-data-layer-for-production-ready-ai-p3e) |
| web:Redwood Research：Blog（RSS）<br>Redwood Research：Blog（RSS） | 2 | — | [官方文章](https://aihot.news/items/xfyprqmlm7gfsw5rzzpf9cw6l) · [原文](https://blog.redwoodresearch.org/p/frontier-models-state-different-decision) |
| web:Timothy B. Lee：Understanding AI（RSS）<br>Timothy B. Lee：Understanding AI（RSS） | 2 | — | [官方文章](https://aihot.news/items/thx9l5ggh1h2c22d6o3t6sysc) · [原文](https://www.understandingai.org/p/introducing-dan-kagan-kans) |
| x:arcprize<br>X：ARC Prize (@arcprize) | 2 | — | [官方文章](https://aihot.news/items/q6zaeg0glnm3uo9lq6i6sslie) · [原文](https://x.com/arcprize/status/2107168554101682274) |
| x:arena<br>X：Arena (@arena) | 2 | — | [官方文章](https://aihot.news/items/ioumrs17cmgy1xuj6dygwhljh) · [原文](https://x.com/arena/status/2107212767786827788) |
| x:hailuo_ai<br>X：MiniMax Design (H3) (@Hailuo_AI) | 2 | — | [官方文章](https://aihot.news/items/sxnw5aphha05ce0c8y3r86cat) · [原文](https://x.com/Hailuo_AI/status/2107207908396261390) |
| x:higgsfield<br>X：Higgsfield AI (@higgsfield) | 2 | — | [官方文章](https://aihot.news/items/h4f0rn1sn61pin6cc16x8ap1f) · [原文](https://x.com/higgsfield/status/2107112781854245256) |
| x:manusai<br>X：Manus (@ManusAI) | 2 | — | [官方文章](https://aihot.news/items/xluvc1nzlltbbgvl3gph1ab3v) · [原文](https://x.com/ManusAI/status/2107259325907677602) |
| x:meshyai<br>X：Meshy (@MeshyAI) | 2 | — | [官方文章](https://aihot.news/items/ctwyipdca2hehwnddieyfqse6) · [原文](https://x.com/MeshyAI/status/2107232696091181298) |
| web:Amazon Science（RSS）<br>Amazon Science（RSS） | 1 | — | [官方文章](https://aihot.news/items/qhwoo85keery53krfpasqy9cr) · [原文](https://www.amazon.science/blog/graph-centric-agentic-intelligence) |
| web:Canary Media：Data Centers 原创报道<br>Canary Media：Data Centers 原创报道 | 1 | — | [官方文章](https://aihot.news/items/amjznv2bcu22nzd0mojsnxu11) · [原文](https://www.canarymedia.com/articles/data-centers/virginia-new-energy-plan-ai-boom) |
| web:Chips and Cheese（RSS）<br>Chips and Cheese（RSS） | 1 | — | [官方文章](https://aihot.news/items/zla7xavo6xcg8bijsp73lrwdw) · [原文](https://chipsandcheese.com/p/nvidias-olympus-core-pushing-server) |
| web:Cohere 产品与研究博客（网页）<br>Cohere 产品与研究博客（网页） | 1 | — | [官方文章](https://aihot.news/items/f85i66r7g599dhbn61qu9nr35) · [原文](https://cohere.com/blog/embed-5) |
| web:Epoch AI：Gradient Updates（RSS）<br>Epoch AI：Gradient Updates（RSS） | 1 | — | [官方文章](https://aihot.news/items/xiudgrewrvcy62j3hj6gr7k67) · [原文](https://epochai.substack.com/p/hundreds-of-millions-of-ai-agents) |
| web:Liquid AI 模型与工程博客（网页）<br>Liquid AI 模型与工程博客（网页） | 1 | — | [官方文章](https://aihot.news/items/uu1qa3hh83kc9i4u832wpywyp) · [原文](https://www.liquid.ai/blog/d1-decision-model) |
| web:LlamaIndex：产品、工程与评测<br>LlamaIndex：产品、工程与评测 | 1 | — | [官方文章](https://aihot.news/items/zjeivip5evnp9oxep6pt063vm) · [原文](https://www.llamaindex.ai/blog/ocr-is-dead-long-live-agentic-ocr) |
| web:OpenClaw：Blog（网页）<br>OpenClaw：Blog（网页） | 1 | — | [官方文章](https://aihot.news/items/mcmqbwq2gptram74uwpukerw9) · [原文](https://openclaw.ai/blog/tencent-aig-joins-clawscan) |
| web:Preferred Networks：AI 研究与产品<br>Preferred Networks：AI 研究与产品 | 1 | — | [官方文章](https://aihot.news/items/qz27tivk61pms2jhrltijxa5b) · [原文](https://www.preferred.jp/ja/news/pr20261006) |
| web:PromptArmor：Threat Intelligence<br>PromptArmor：Threat Intelligence | 1 | — | [官方文章](https://aihot.news/items/dfcis3hxowljt45i0bvyi3f0n) · [原文](https://www.promptarmor.com/resources/four-databricks-genie-controls-that-dont-stop-malicious-skills) |
| web:Recode China AI（RSS）<br>Recode China AI（RSS） | 1 | — | [官方文章](https://aihot.news/items/ry2ysn1ocnbjfdrqpetrbmo9q) · [原文](https://www.recodechinaai.com/p/deepseek-and-huawei-target-nvidias) |
| web:Replit：Blog（RSS）<br>Replit：Blog（RSS） | 1 | — | [官方文章](https://aihot.news/items/r0u7pz3fxhal9fkp2altyieq8) · [原文](https://replit.com/blog/free-the-models) |
| web:SemiAnalysis 长文 RSS（RSS）<br>SemiAnalysis 长文 RSS（RSS） | 1 | — | [官方文章](https://aihot.news/items/lcxzcuj920lvqlah60vj7utm1) · [原文](https://newsletter.semianalysis.com/p/anthropic-subscriptions-offer-5x) |
| x:arthurmensch<br>X：Arthur Mensch（Mistral CEO） (@arthurmensch) | 1 | — | [官方文章](https://aihot.news/items/n6197c9lea1zi53b5aele4zwq) · [原文](https://x.com/arthurmensch/status/2107196159181639904) |
| x:gemini_notebook<br>X：Gemini Notebook (@Gemini_Notebook) | 1 | — | [官方文章](https://aihot.news/items/wuz0couqpni9do5tspsxv71he) · [原文](https://x.com/Gemini_Notebook/status/2107230392642417113) |
| x:ggerganov<br>X：Georgi Gerganov（llama.cpp） (@ggerganov) | 1 | — | [官方文章](https://aihot.news/items/sq3ff7z555w0pgrqp6zg0i2x6) · [原文](https://x.com/ggerganov/status/2107190267887632462) |
| x:lisasu<br>X：Lisa Su（AMD CEO） (@LisaSu) | 1 | — | [官方文章](https://aihot.news/items/jlhzg0v8j7iaq6pq5jdgixc2g) · [原文](https://x.com/LisaSu/status/2105096138424815971) |
| x:sensetime_ai<br>X：商汤 SenseTime (@SenseTime_AI) | 1 | — | [官方文章](https://aihot.news/items/qjz8f3p0gs46dc0r072lvgsdy) · [原文](https://x.com/SenseTime_AI/status/2107084260876448086) |
| x:tripoai<br>Tripo（官方 X） | 1 | — | [官方文章](https://aihot.news/items/mw7n7xanngfpldvfu2i15gbw4) · [原文](https://x.com/tripoai/status/2106761265020604899) |

## 已停用

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|

## 身份待核实

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|

## 同站点，需核对范围

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|
| web:IT之家（RSS）<br>IT之家（RSS） | 88 | radar-ithome | [官方文章](https://aihot.news/items/rxhcxov9dwcj09krr8o1nrak5) · [原文](https://www.ithome.com/1/010/031.htm) |
| web:HuggingFace Daily Papers（社区热门论文）<br>HuggingFace Daily Papers（社区热门论文） | 83 | radar-hf-daily-papers | [官方文章](https://aihot.news/items/cwa3jqwiycrvx8lce16gjaxf6) · [原文](https://arxiv.org/abs/2610.05879) |
| web:TechCrunch：AI（RSS）<br>TechCrunch：AI（RSS） | 15 | rss-techcrunch-ai | [官方文章](https://aihot.news/items/ql0sq7wg0rnrv5oewtdn1oo9a) · [原文](https://techcrunch.com/2026/10/05/openai-will-start-watermarking-chatgpts-text-in-the-eu/) |
| web:The Verge：AI（RSS）<br>The Verge：AI（RSS） | 13 | rss-the-verge-ai | [官方文章](https://aihot.news/items/mid9e4m377uvvg4frqyrav39s) · [原文](https://www.theverge.com/ai-artificial-intelligence/1005177/google-gemini-call-for-me-expansion-rumors) |
| web:The Decoder：AI News（RSS）<br>The Decoder：AI News（RSS） | 12 | rss-the-decoder | [官方文章](https://aihot.news/items/sz90d8ss53nbmrxixsy4w8tq0) · [原文](https://the-decoder.com/cohere-pitches-north-2-as-the-enterprise-ai-control-room-that-works-with-any-model/) |
| web:MarkTechPost（RSS）<br>MarkTechPost（RSS） | 9 | radar-marktechpost | [官方文章](https://aihot.news/items/m7qlf4epiklectominlmh4eoc) · [原文](https://www.marktechpost.com/2026/10/05/reka-releases-rho-1-a-19b-omni-reasoning-model-that-understands-generates-video-and-outputs-robot-actions-in-one/) |
| web:Hacker News：AI 热帖<br>Hacker News：AI 热帖 | 6 | radar-claude-code-releases | [官方文章](https://aihot.news/items/hiw4ttae0mvd4jtbo23ip8yk8) · [原文](https://edworkingpapers.com/ai26-1551) |
| web:Ars Technica：AI（RSS）<br>Ars Technica：AI（RSS） | 3 | rss-ars-technica-ai | [官方文章](https://aihot.news/items/qbwmal67pa7cx2c3jlu6amsv9) · [原文](https://arstechnica.com/security/2026/10/vulnerability-in-agents-from-google-and-others-exposes-structural-flaw-in-mcp/) |
| web:Simon Willison 博客<br>Simon Willison 博客 | 3 | rss-simon-willison | [官方文章](https://aihot.news/items/oj7q14paghhkh66541sg0xdgy) · [原文](https://simonwillison.net/2026/Oct/5/felix-rieseberg/) |
| web:Claude Code：GitHub Releases（RSS）<br>Claude Code：GitHub Releases（RSS） | 2 | radar-claude-code-releases | [官方文章](https://aihot.news/items/of75wi67qh2ulhsjybw1qh0bs) · [原文](https://github.com/anthropics/claude-code/releases/tag/v2.1.291) |
| web:Databricks：Blog（RSS）<br>Databricks：Blog（RSS） | 2 | radar-databricks | [官方文章](https://aihot.news/items/d32mt5jfepri5irkcpmhdchvz) · [原文](https://www.databricks.com/blog/nearest-join-scaling-vector-search-databricks-runtime) |
| web:Every：最新文章（网页）<br>Every：最新文章（网页） | 2 | radar-every-latest | [官方文章](https://aihot.news/items/sz70i873uzpc0i0e7ljmxct9y) · [原文](https://every.to/working-overtime/before-you-give-ai-another-instruction-try-taking-one-away) |
| web:OpenAI：官网动态（RSS · 排除企业/客户案例）<br>OpenAI：官网动态（RSS · 排除企业/客户案例） | 2 | rss-openai-news | [官方文章](https://aihot.news/items/xx5mgdemrqmqw5zw410sbawcz) · [原文](https://openai.com/index/eu-text-provenance) |
| web:Apple Machine Learning Research（RSS）<br>Apple Machine Learning Research（RSS） | 1 | radar-apple-ml | [官方文章](https://aihot.news/items/ni4dtmayia82t3vu6s6huiy73) · [原文](https://machinelearning.apple.com/research/ontological-boundary-negotiation) |
| web:Claude Platform：开发者版本说明（RSS）<br>Claude Platform：开发者版本说明（RSS） | 1 | radar-claude-platform-releases | [官方文章](https://aihot.news/items/wl285xb5c9mbszzz3dayb1ndq) · [原文](https://platform.claude.com/docs/en/release-notes/overview#october-1-2026) |
| web:Claude：Blog（网页）<br>Claude：Blog（网页） | 1 | radar-claude-blog | [官方文章](https://aihot.news/items/ljn92fwc063j1utnzqkqxw5br) · [原文](https://claude.com/blog/how-cresta-turned-cx-expertise-into-an-agent-builder-on-the-claude-agent-sdk) |
| web:Codex：GitHub Releases（RSS）<br>Codex：GitHub Releases（RSS） | 1 | radar-claude-code-releases | [官方文章](https://aihot.news/items/j3dfbjo2vj825bjwhzwwb8ij0) · [原文](https://github.com/openai/codex/releases/tag/rust-v0.160.1) |
| web:Gary Marcus：The Road to AI We Can Trust（RSS）<br>Gary Marcus：The Road to AI We Can Trust（RSS） | 1 | radar-gary-marcus | [官方文章](https://aihot.news/items/kuigfdd5yemw2br1z4cz35inm) · [原文](https://garymarcus.substack.com/p/coming-soon-new-york-citys-hearing) |
| web:GitHub Blog<br>GitHub Blog | 1 | rss-github-ai | [官方文章](https://aihot.news/items/zgxq1ot57liog5wf5ndbaxn4p) · [原文](https://github.blog/ai-and-ml/github-copilot/reviewbench-an-open-benchmark-for-ai-code-review/) |
| web:Hugging Face：Blog（RSS）<br>Hugging Face：Blog（RSS） | 1 | rss-hugging-face, radar-inclusionai-models, radar-hf-daily-papers | [官方文章](https://aihot.news/items/wxpl3hn2eqb9qcxpjmxoj780o) · [原文](https://huggingface.co/blog/tiiuae/falcon-emirati) |
| web:Latent Space（RSS）<br>Latent Space（RSS） | 1 | rss-latent-space | [官方文章](https://aihot.news/items/krivwcmcv6qloa3az7f5j0jip) · [原文](https://www.latent.space/p/ainews-reflection-beam-501b-a23b) |
| web:NVIDIA Blog（RSS）<br>NVIDIA Blog（RSS） | 1 | rss-nvidia-blog | [官方文章](https://aihot.news/items/xa635y5otvervs1z3d4wf5ywk) · [原文](https://blogs.nvidia.com/blog/ai-breast-cancer-startups/) |
| web:OpenRouter：Announcements（RSS）<br>OpenRouter：Announcements（RSS） | 1 | radar-openrouter-announcements | [官方文章](https://aihot.news/items/a1ctodvpmvag7drmfl5xl1upl) · [原文](https://openrouter.ai/blog/insights/server-side-code-execution-tools-for-ai-agents-compared/) |
| web:Suno：Blog（网页）<br>Suno：Blog（网页） | 1 | radar-suno-blog | [官方文章](https://aihot.news/items/wfk93lrvw1t9zjb1kzgbcud6s) · [原文](https://suno.com/blog/albums-to-discover) |
| web:Together AI 研究与产品博客（RSS）<br>Together AI 研究与产品博客（RSS） | 1 | radar-together-blog | [官方文章](https://aihot.news/items/ef2o8x2jh4m8n7ggsq5bc5eag) · [原文](https://www.together.ai/blog/together-link-frontier-quality-open-models-in-the-harness-you-already-use) |
| web:Tomer Tunguz 博客（VC 分析）<br>Tomer Tunguz 博客（VC 分析） | 1 | radar-tomer-tunguz | [官方文章](https://aihot.news/items/gzwz5hsrdau14waongigd888m) · [原文](https://tomtunguz.com/inference-is-the-most-important-market-in-software/) |
| web:a16z：News（RSS）<br>a16z：News（RSS） | 1 | radar-a16z-news | [官方文章](https://aihot.news/items/f6gfru9zxdjn630xle04z98tm) · [原文](https://www.a16z.news/p/top-100-consumer-ai-apps-seventh) |

## 账号已配置

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|
| x:rohanpaul_ai<br>X：Rohan Paul (@rohanpaul_ai) | 40 | radar-x-rohanpaul-ai | [官方文章](https://aihot.news/items/xvrt741f039zlqt9zo839gakf) · [原文](https://x.com/rohanpaul_ai/status/2107388401565720991) |
| x:testingcatalog<br>X：Testing Catalog (@testingcatalog) | 13 | radar-x-testingcatalog | [官方文章](https://aihot.news/items/naaox3zct2jirkyrmljviyxwh) · [原文](https://x.com/testingcatalog/status/2107379242023739810) |
| x:emollick<br>X：Ethan Mollick (@emollick) | 12 | radar-x-emollick | [官方文章](https://aihot.news/items/clwtjds0asbcdfhjpp54nrg0d) · [原文](https://x.com/emollick/status/2107356794410377510) |
| x:omarsar0<br>X：Elvis Saravia (@omarsar0, DAIR.AI) | 12 | radar-x-omarsar0 | [官方文章](https://aihot.news/items/o0547uzw4bdme530dsv5cq6jv) · [原文](https://x.com/omarsar0/status/2107273821824622885) |
| x:thsottiaux<br>X：Tibo (@thsottiaux) | 11 | radar-x-thsottiaux | [官方文章](https://aihot.news/items/i0xtgnmlh4i4fmph296nlb3xh) · [原文](https://x.com/thsottiaux/status/2107378093635899886) |
| x:elonmusk<br>X：Elon Musk (@elonmusk, xAI) | 9 | radar-x-elonmusk | [官方文章](https://aihot.news/items/wmsl0p67xmfmi0zirzk3t23sr) · [原文](https://x.com/elonmusk/status/2106982949832774039) |
| x:suno<br>X：Suno (@suno) | 9 | radar-x-suno | [官方文章](https://aihot.news/items/i0ti4b3qlnm9cxkr0kgx9psph) · [原文](https://x.com/suno/status/2107268907681956288) |
| x:dongxi_nlp<br>X：马东锡 NLP (@dongxi_nlp) | 5 | radar-x-dongxi-nlp | [官方文章](https://aihot.news/items/m3ssog4stzwizddcd9n0dtidl) · [原文](https://x.com/dongxi_nlp/status/2107353975095963893) |
| x:replit<br>X：Replit (@Replit) | 5 | radar-x-replit | [官方文章](https://aihot.news/items/xrqbltx0qd4yrxeam9rtf121k) · [原文](https://x.com/Replit/status/2107211903760293996) |
| x:semianalysis_<br>X：SemiAnalysis (@SemiAnalysis_) | 5 | radar-x-semianalysis | [官方文章](https://aihot.news/items/cb0ezpqwemd470yabfj9dxmgl) · [原文](https://x.com/SemiAnalysis_/status/2107252022424531076) |
| x:trq212<br>X：Thariq (@trq212) | 5 | radar-x-trq212 | [官方文章](https://aihot.news/items/hkqj1i2ndcz2l4svfrpk65t7e) · [原文](https://x.com/trq212/status/2107294499282293017) |
| x:_akhaliq<br>X：AK (@_akhaliq) | 4 | radar-x--akhaliq | [官方文章](https://aihot.news/items/vc6im4qxdhmq4vk8oim0euc5n) · [原文](https://x.com/_akhaliq/status/2107119868218916980) |
| x:hongming731<br>X：洪明 (@hongming731) | 4 | radar-x-hongming731 | [官方文章](https://aihot.news/items/y1pgcg4agv285kycukmes3d8r) · [原文](https://x.com/hongming731/status/2107256742405140915) |
| x:yuchenj_uw<br>X：Yuchen Jin (@Yuchenj_UW) | 4 | radar-x-yuchenj-uw | [官方文章](https://aihot.news/items/kox7rx4p2i1qfpg75lzueauvi) · [原文](https://x.com/Yuchenj_UW/status/2107296460438159806) |
| x:aravsrinivas<br>X：Aravind Srinivas（Perplexity CEO） (@AravSrinivas) | 3 | radar-x-aravsrinivas | [官方文章](https://aihot.news/items/l6sxjedwpj6f3h0veao48sngx) · [原文](https://x.com/AravSrinivas/status/2107250838553182453) |
| x:artificialanlys<br>X：Artificial Analysis (@ArtificialAnlys) | 3 | radar-x-artificialanlys | [官方文章](https://aihot.news/items/zinjdvbgdlbybgikokxnz1kix) · [原文](https://x.com/ArtificialAnlys/status/2107347774262112765) |
| x:clementdelangue<br>X：Clément Delangue（Hugging Face CEO） (@ClementDelangue) | 3 | radar-x-clementdelangue | [官方文章](https://aihot.news/items/h3n8nie92szwgj9suwc1owxhz) · [原文](https://x.com/ClementDelangue/status/2107194915130356213) |
| x:openai<br>X：OpenAI (@OpenAI) | 3 | radar-x-openai | [官方文章](https://aihot.news/items/qmr1ljb822tb4ujo8t6xecbna) · [原文](https://x.com/OpenAI/status/2107164650249101695) |
| x:openaidevs<br>X：OpenAI Developers (@OpenAIDevs) | 3 | radar-x-openaidevs | [官方文章](https://aihot.news/items/nsv09otluqr8efqcfryt46jkk) · [原文](https://x.com/OpenAIDevs/status/2107242397361139938) |
| x:cohere<br>X：Cohere（@cohere） | 2 | radar-x-cohere | [官方文章](https://aihot.news/items/kyqz6v8s9nb9j0s1nphfor6r2) · [原文](https://x.com/cohere/status/2107096277079200037) |
| x:lumalabsai<br>X：Luma AI (@LumaLabsAI) | 2 | radar-x-lumalabsai | [官方文章](https://aihot.news/items/jzfthnl2a0tica1jalvzn5r1t) · [原文](https://x.com/LumaLabsAI/status/2107161142749544627) |
| x:natolambert<br>X：Nathan Lambert (@natolambert) | 2 | radar-x-natolambert | [官方文章](https://aihot.news/items/fodt4nkmywgehgstbk0jcthci) · [原文](https://x.com/natolambert/status/2107214330529980676) |
| x:thexpin<br>X：X.PIN (@thexpin) | 2 | radar-x-thexpin | [官方文章](https://aihot.news/items/d3tplelqsi5dwpy33upz7g7q1) · [原文](https://x.com/thexpin/status/2107391299460694300) |
| x:thom_wolf<br>X：Thomas Wolf（Hugging Face 联创/CSO） (@Thom_Wolf) | 2 | radar-x-thom-wolf | [官方文章](https://aihot.news/items/zpxsopbvgo4biv5yhvifxm807) · [原文](https://x.com/Thom_Wolf/status/2107220816022966376) |
| wechat:3223096120<br>公众号：数字生命卡兹克 | 1 | radar-mp-3223096120 | [官方文章](https://aihot.news/items/wiip2ye21b67quiydxlnqmeyc) · [原文](https://mp.weixin.qq.com/s?__biz=MzIyMzA5NjEyMA%3D%3D&mid=2647686876&idx=1&sn=55c719c9dded44507dbd2a000a2ec5a7) |
| wechat:3595904568<br>公众号：可灵AI（快手·视频） | 1 | radar-mp-3595904568 | [官方文章](https://aihot.news/items/ape5xs7a4tq0mf7uxc514lbj6) · [原文](https://mp.weixin.qq.com/s?__biz=MzU5NTkwNDU2OA%3D%3D&mid=2247497135&idx=1&sn=3b215e0d3c28efa4a34879133d115377) |
| x:baidu_inc<br>X：百度 Baidu (@Baidu_Inc) | 1 | radar-x-baidu-inc | [官方文章](https://aihot.news/items/laqtxb5qtd1n5ybpteqj3vd2z) · [原文](https://x.com/Baidu_Inc/status/2107108546089525600) |
| x:demishassabis<br>X：Demis Hassabis (@demishassabis) | 1 | radar-x-demishassabis | [官方文章](https://aihot.news/items/qtw9wc46evcrziagij882x6f3) · [原文](https://x.com/demishassabis/status/2106850913474482566) |
| x:ericzakariasson<br>X：Eric Zakariasson (@ericzakariasson) | 1 | radar-x-ericzakariasson | [官方文章](https://aihot.news/items/y4t10ywukec3bz3rs91du6k0p) · [原文](https://x.com/ericzakariasson/status/2107161574247129284) |
| x:googleai<br>X：Google AI (@GoogleAI) | 1 | radar-x-googleai | [官方文章](https://aihot.news/items/qn3uvt9iv39vrx38yppoilr3b) · [原文](https://x.com/GoogleAI/status/2107152626873663898) |
| x:haoailab<br>X：Sky Computing Lab (@haoailab) | 1 | radar-x-haoailab | [官方文章](https://aihot.news/items/ctsuo4u6rnyjmg2jvu7dhjt9y) · [原文](https://x.com/haoailab/status/2107227312911716584) |
| x:jietang<br>X：唐杰（@jietang） | 1 | radar-x-jietang | [官方文章](https://aihot.news/items/k8k8jpywk59n78zu713dse7mw) · [原文](https://x.com/jietang/status/2107325969480720713) |
| x:kling_ai<br>X：可灵 Kling AI (@Kling_ai) | 1 | radar-x-kling-ai | [官方文章](https://aihot.news/items/gf048arpz9hrjjq61wm1ce97l) · [原文](https://x.com/Kling_ai/status/2106727026635808860) |
| x:krea_ai<br>X：Krea AI (@krea_ai) | 1 | radar-x-krea-ai | [官方文章](https://aihot.news/items/v38xd9h0ss08ejternqtt9qpi) · [原文](https://x.com/krea_ai/status/2107138756507763130) |
| x:milichab<br>X：Andrew Milich (@milichab) | 1 | radar-x-milichab | [官方文章](https://aihot.news/items/q7t8o0rujg2s7kk8oiysufk0y) · [原文](https://x.com/milichab/status/2107141590708048091) |
| x:noahzweben<br>X：Noah Zweben（@noahzweben） | 1 | radar-x-noahzweben | [官方文章](https://aihot.news/items/dkmlzieh3jgnl1apsuuja5ov9) · [原文](https://x.com/noahzweben/status/2107226358913130874) |
| x:odysseyml<br>X：Odyssey (@odysseyml) | 1 | radar-x-odysseyml | [官方文章](https://aihot.news/items/t5p0jp60qm46z0dl7z7d6w4pj) · [原文](https://x.com/odysseyml/status/2106980162369667518) |
| x:opencode<br>X：opencode (@opencode) | 1 | radar-x-opencode | [官方文章](https://aihot.news/items/b8za8fg1rmv14tmnoeqmmn433) · [原文](https://x.com/opencode/status/2107398361733104102) |
| x:openrouter<br>X：OpenRouter (@OpenRouter) | 1 | radar-x-openrouter | [官方文章](https://aihot.news/items/ywf6ptrtca88acer8h9xjss6e) · [原文](https://x.com/OpenRouter/status/2107139469174542636) |
| x:swyx<br>X：swyx (@swyx) | 1 | radar-x-swyx | [官方文章](https://aihot.news/items/tl06w2wqinl9o3tvp2ieozwjt) · [原文](https://x.com/swyx/status/2107275361822347406) |
| x:tianyi<br>X：Tianyi Cui（@tianyi） | 1 | radar-x-tianyi | [官方文章](https://aihot.news/items/a38g9lw8b6fpayyhrydpvvmcq) · [原文](https://x.com/tianyi/status/2107030904233460208) |
| x:viggleai<br>X：Viggle AI (@ViggleAI) | 1 | radar-x-viggleai | [官方文章](https://aihot.news/items/qsu8ub2ei28109rjph07d9546) · [原文](https://x.com/ViggleAI/status/2107191460659372080) |
| x:zai_org<br>X：智谱 Z.ai (@Zai_org) | 1 | radar-x-zai-org | [官方文章](https://aihot.news/items/q74v4lhkbjw6z7wg0ziufr9zy) · [原文](https://x.com/Zai_org/status/2107272032073437185) |

## 渠道已配置

| 来源身份 / 官方名称 | 条数 | 本地匹配 | 示例 |
|---|---:|---|---|
| web:Hacker News 热门（buzzing.cc 中文翻译）<br>Hacker News 热门（buzzing.cc 中文翻译） | 20 | rss-ars-technica-ai, radar-claude-code-releases, radar-buzzing-hn | [官方文章](https://aihot.news/items/vt1o40qh9511qufjreh6o5x48) · [原文](https://www.vivienhenz.com/common-lisp) |
