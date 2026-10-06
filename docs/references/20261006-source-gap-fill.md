# 2026-10-06 来源缺口补齐

范围来自 [48 小时来源审计](20261006-source-gap-audit.md)：21 个 X 账号、24 个网站／频道。用户授权补齐并沿用此前生产部署要求；不执行历史 backfill，OpenMOSS 与 Hacker News 待核渠道不在本批。

## JSON 栏目过滤决定

PromptArmor 的 resources 内含 Threat Intelligence、普通博客、主题和指南。新增可选 `json_list.requireValue: { path, equals }`，按 JSON 标量严格相等筛选；与原 `requireBoolean` 同时配置时按 AND 生效。原字段行为、采集器类型、文章身份、预算与全文许可保持。

没有复用 `requireBoolean` 装字符串，避免字段名误导；也没有导入全部 resources 或创建单独数据源类型。匹配、非匹配、类型不同、字段缺失、显式 null 和草稿过滤组合由定向测试验证。配置错误须被拒绝，不能伪装成空列表。2026-10-06 独立决策审查七项通过，无未消解项；实现和生产验收另记下节。

来源仍默认仅公开摘要与原文链接，初始普通采集上限每源 8 篇。来源告警沿用 [README 服务待办](../../README.md#服务) 的归属（AIHOT 维护者）；本次不建立新的常驻服务或更改告警投递。

## 接入清单与入口

配置维护在 [`industry/sources.json`](../../industry/sources.json)，新增 21 个 `x_search`、18 个 `rss`、4 个 `web_list`、2 个 `json_list`，没有新增数据源类型。此前 223 项配置保持不变。

X 账号：`dair_ai`、`cursor_ai`、`_philschmid`、`cognition`、`elevenlabs`、`fal`、`figure_robot`、`khazix0918`、`pixverse`、`arcprize`、`arena`、`hailuo_ai`、`higgsfield`、`manusai`、`meshyai`、`arthurmensch`、`gemini_notebook`、`ggerganov`、`lisasu`、`sensetime_ai`、`tripoai`。本批 `@PixVerse` 的 ID 为 `radar-x-pixverse-current`，与此前已配置的 `@PixVerse_` 分开维护。

网站／频道：PyTorch、Exponential View、404 Media、ChinaTalk、Google AI Developers、Redwood Research、Understanding AI、Amazon Science、OpenAI Codex Releases、Factory、Claude YouTube、Artificial Intelligence News、Chips and Cheese、Epoch AI Gradient Updates、Recode China AI、SemiAnalysis、Canary Media Data Centers、OpenClaw、Replit、Cohere、Liquid AI、LlamaIndex、Preferred Networks、PromptArmor Threat Intelligence。

可复用的接入细节：

- Artificial Intelligence News 使用公开 WordPress JSON 接口，并配置浏览器 User-Agent；本轮默认采集 User-Agent 返回 403，`/feed/` 返回 HTML，故未当作 RSS 使用。
- Claude YouTube 使用已核对账号身份的 channel ID RSS，不能把 handle 直接替代 channel ID。
- Canary Media 保留 RSS 入口，按 Data Centers 原文路径筛选；本轮 100 条 feed 候选中 3 条属于该栏目。
- Liquid AI 同时覆盖 Models 和 Engineering；LlamaIndex 只解析有日期的文章卡片；Preferred Networks 限本站 news 路径。
- PromptArmor 保留 `isDraft=false` 并限定 Threat Intelligence，实际返回 29 条，其中 1 条上游日期无法解析；不伪造日期。

## 验证与发布

本地使用真实采集器分别读取 24 个不同来源的当前响应（18 RSS、4 HTML、2 JSON，每源一份响应），均取得标题和原文 URL。定向 6 项测试覆盖配置、唯一账号，以及字符串／数字／布尔／null、字段缺失、非匹配、草稿组合和非法配置。全后端测试 345 项、Web 测试 11 项通过，typecheck 与 Web 构建完成；这些读数不证明任意未来页面改版仍可解析。

独立实现审查一轮通过，无未处置 finding。复用上一轮 555 篇官方公开动态的快照重新审计，`missing` 从 44 降至 0；网站同域仍按审计脚本契约标为待核，具体栏目由上述入口和实际采集验证，不能只靠同域匹配宣称接入成功。

生产发布为腾讯云 `/home/ubuntu/aihot/releases/source-gaps-20261006`，使用既有 `service.sh install`；保留数据库、私有配置和 SocialData 预算。seed 增加 45 行，库内共 284 个来源，其中 268 启用、16 个历史 external 来源继续停用。发布前后 239 个旧来源的配置、级别、频率、启停和全文设置哈希一致。公开来源目录已包含 45 个新增来源名称，公开站点 smoke 完成。

2026-10-06 13:34 UTC，45 个新增来源的最近一次生产 `fetch_runs` 均为 `ok`，均已设置首次采集水位并有材料入库：21 个 X 共 168 篇、18 个 RSS 共 137 篇、4 个网页列表共 30 篇、2 个 JSON 列表共 15 篇，总计 350 篇。SocialData 每分钟 10 次请求预算曾使部分账号延后，worker 随后自动重试成功；未提高预算或绕开请求回执。该验收覆盖各来源本次普通首次采集，不外推连续运行或发布数量。

本地原始证据保留在 `.data/gap-fill/`（不入 Git）：`web-final-probe.jsonl`、`production-before.json`、`production-settings-after.json`、`production-after.json`、`public-directory.json`、`production-smoke.log` 及测试日志。

本次仅做正常新来源首次采集和后续调度，不创建或启动历史 backfill 批次。来源已接入不等于其每篇材料都会公开：仍需经过既有 AI 相关性筛选、分析及发布资格检查。
