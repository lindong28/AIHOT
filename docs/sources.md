# 信源

本文说明当前 AIHOT 框架的信源操作。旧 ai-radar 的来源覆盖与入口差异见[两项目对比](references/ai-radar-comparison.md)，后续接入边界见[融合开发指南](development.md)。

公开文章的来源显示原始发布者或原文站点：公众号显示账号名，X 显示原帖账号，Hacker News 聚合显示原文域名和发现渠道。采集工具、归档集合和跟踪账号仍保留为内部来源身份。无法确认的历史公众号显示“微信公众号（账号未识别）”，不会根据正文猜测。规则与边界见[来源展示决定](references/20261005-source-labels.md)。

读者通过桌面导航“来源”或手机“更多 → 来源”进入 `/sources`，按微信公众号、X、Hacker News、网站与博客、开发者平台浏览当前接入来源，并搜索名称、账号或域名。点击分类查看该类新闻，点击账号或站点查看其新闻；默认全部，可切换精选和翻页。当前没有公开新闻的来源仍在目录中，停采来源的历史新闻可从分类页或文章来源进入。新闻卡片与详情的来源名称通向站内来源页，“阅读原文”通向原文。后台管理保持 `/admin/sources`，`/sources` 不再作为后台旧地址重定向。设计与验证见[来源目录](references/20261006-source-directory.md)。

来源目录、分类和账号页均可通过“仅看精选”小圆点开关选择范围：开启仅看精选，关闭显示全部 AI 相关新闻。分类和账号计数、卡片目标及分页随选择变化。主题目录 `/topics` 与主题新闻页使用相同控件，但默认精选；来源默认全部。两个目录的开关和搜索框在同一行，主题可按名称或介绍关键词搜索，不区分大小写。点击放大镜或按 Enter 搜索；切换开关也会应用框内当前输入，清除搜索保留范围。URL 的 `q` 保存搜索词，`tab=selected` / `tab=all` 保存范围，切换时回到第一页。“全部 AI 相关新闻”只含通过相关性筛选且已公开、可列出的新闻，不包含所有采集材料；未发布、撤回、隔离和不符合公开资格的内容不在其中。主题计数沿用短期缓存，发布变化后可能稍有延迟。

部署后先运行数据库迁移，再用 `node scripts/repair-source-labels.ts` 预览已有公开投影的修复，确认输出后加 `--apply` 执行；`--json` 输出机器可读结果。脚本复用实时与 backfill 的来源生成规则，可重复运行；同步搜索、日报引用、当前热榜展示和 selected 增量更正，不重跑模型、不发送通知、不修改原始材料或公开资格。运行环境使用既有后端配置，例如腾讯云在当前 release 下执行 `/usr/local/bin/node --env-file=/home/ubuntu/aihot/shared/app.env scripts/repair-source-labels.ts --apply`。

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

2026-09-30 迁移配置保留原 18 个 RSS，新增 36 个公开来源和 109 个 X 账号。Google Research、Mistral 已有 RSS，不重复加网页；Sierra 使用新发现的官方 RSS。`scripts/seed.ts` 可重跑，只添加尚不存在的来源，不覆盖后台编辑。3 个故障 RSS 的处置沿用[迁移记录](migration.md)，Mp2RSS 已明确排除；xAI 的后续 RSS 接入见下节。

X 使用 AIHOT 原生 SocialData，支持 `SOCIALDATA_API_KEY` 和别名 `SOCIAL_DATA_API_KEY`，同时配置时前者优先。只把所需凭据放进本机 `.env` 或 `AIHOT_CREDENTIALS_DIR/collectors.env`，不要把整个个人凭据文件复制进仓库。账号首次回灌单独采集，取得水位后自动分组搜索。每页保存后更新断点，未读区间持续保留；每轮最多两页新内容和两次旧区间请求，积压续采约一分钟后重新调度，正常轮询频率不变。预算耗尽等到实际滚动窗口释放再调度；游标失效时用已保存的 ID 边界续采，没有可恢复边界的旧区间保留错误供排查。Wechat2RSS 部署与原生 RSS 登记见[运维说明](operations/wechat2rss.md)。

## xAI 官网 News

`industry/sources.json` 已加入 `rss-xai-news`，名称为“xAI：News”，采集 [xAI 官网 News](https://x.ai/news/) 文章。发现入口是 [Olshansk/rss-feeds 提供的第三方 RSS](https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_xainews.xml)，不是 xAI 官方 RSS；仅接收 `https://x.ai/news/` 下的原文链接。此来源使用原生 `rss` 采集与正文提取，不需要 X API 或 SocialData key，也不替代已有 X 账号来源。

配置的首次回灌上限为 8 篇，初始抓取间隔为 120 分钟；`fetchPublicContent` 用于提取原文供后端处理，`site_fulltext` 与 `syndicate_fulltext` 仍为 false，不开放站内或订阅全文。通用提取器已知会遗漏原文示例代码块，不保证完整保留页面内容。

既有站点要应用这份配置，需在包含它的部署版本中、使用部署原有环境运行 `scripts/seed.ts`；例如原环境文件为 `.env` 时执行 `node --env-file=.env scripts/seed.ts`。信源只补不存在的 ID；同 ID 的启停、频率和其他后台设置不会被覆盖，需在后台调整。seed 也会按既有逻辑更新主题，并在模型榜启用时补目录，不是单源导入命令。本次仓库配置变更不表示已部署或已在生产登记；已有本机三篇样本的采集、日期、正文与去重证据及未验范围见[2026-10-06 接入记录](migration.md#2026-10-06-xai-news-本地接入)。

## 六种信源

2026-10-06 根据官方 AI 视频主题的来源清点，配置新增 14 个网站／开发者渠道、4 个 X 账号和 10 个公众号，保留既有 xAI News RSS。名单、生产登记与采集验证见[视频来源补充记录](references/20261006-video-sources.md)。OpenMOSS 暂不添加，已记录 Issue；本次不做历史 backfill。既有数据库需通过 seed 或后台新增来源，文件变更本身不代表 worker 已读取。

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按返回条数计费，空响应可能有最低费用；请求次数另受预算限制 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

每种信源认哪些配置项写在 `packages/backend/src/sources/config-keys.ts`。填了不认识的配置项，保存会被拒绝、抓取会直接失败并在后台显示原因，不会悄悄退回通用解析。

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

可选：`summaryIsBody`（订阅里的摘要就是全文）、`allowCategories` / `denyCategories`（按订阅里的分类过滤）。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

上述默认使用 Dajiala，每个公众号按抓取间隔检查，列表与正文按次计费。旧 AI RADAR 订阅使用已有 Wechat2RSS：

```json
{ "provider": "wechat2rss", "bizId": "3236757533", "feedId": "上游订阅的 feed_id" }
```

每个公众号一个来源，文章进入统一材料表与处理队列，保留作者、日期、正文、原文链接及来源身份，不使用推文专有 `x_post` 字段。认证与隧道由后端部署环境配置，来源 JSON 不含 token。首次取最近 7 天最多 8 条，后续可以补齐该固定窗口；详细边界和运维见 [Wechat2RSS](operations/wechat2rss.md)。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。
- **刊物配图**：来源的 config JSON 可独立设置 `"reportImages": true` 或 `false`，适用于日报、周报和月报封面；后台“信源 → 配置”编辑，也可写入 `industry/sources.json` 中来源的 config。未配置时沿用 X 图片及全文文章的配图资格；false 优先禁止，true 允许摘要文章提供图片。普通媒体、公众号在确认允许配图后可单独开启，不需开放正文或全文 RSS。只选头条或同事件已公开文章的合尺寸图片，并标记实际供图来源。无图或加载失败时使用紧凑布局；历史刊物读取时生效，已有页面可能仍受缓存影响，无需重生成日报。规则见[刊物配图决定](references/20261006-report-images.md)。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

X 分页抓取已保存的页面保留进度，失败页下次从断点继续；预算等待不增加信源失败次数。其他连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。
