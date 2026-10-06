# 对比官方 AIHOT 的近期来源

用途：查询官方 AIHOT 最近约 48 小时收录的公开动态（含非精选），按公众号、X 账号与网站来源，对比我们的来源配置，生成缺口清单。以后遇到“官方有、我们没有哪些来源”时，复用 `scripts/audit-source-gaps.py`，无需重新手工翻页。

首轮实际结果见 [2026-10-06 来源缺口清点](../references/20261006-source-gap-audit.md)，包括全部来源表与同域不同项目的人工复核。

## 运行

需要 Python 3.9+，只用标准库，无需 npm、数据库迁移、模型或采集服务。下面命令从仓库根目录执行。

对比腾讯云**当前生产数据库**（推荐；需已有 SSH 权限和远端只读 psql 权限）：

```bash
python3 scripts/audit-source-gaps.py --ssh tencent-webserver-china --hours 48 --out .data/source-gap-audit/20261006
```

`--ssh` 只执行 `SELECT`，读取远端 `aihot` 数据库的 `sources` 表，区分启用和停用。只导出名称、ID、类型、启停与匹配需要的配置字段，不读取环境文件或完整 config，不改变订阅、来源、新闻或运行服务。当前命令适用于已有腾讯云部署的 PostgreSQL/sudo 布局。

只对比仓库配置（**不代表线上状态**）：

```bash
python3 scripts/audit-source-gaps.py --sources industry/sources.json --hours 48 --out .data/source-gap-audit/repo-check
```

也可以把前次的 `inventory.json` 交给 `--sources`。仓库种子缺少 `enabled` 时按 seed 的默认值 true 处理。seed 不覆盖已存在的生产行，所以线上核查优先 `--ssh`。

输出目录必须是新目录，避免覆盖旧证据。`--help` 查看选项；`--base` 可指定兼容的 AIHOT API 站点；`--until` 接受含时区的 ISO 时间。窗口须位于当前 API 的七天可见范围内，`--hours` 最大 144 小时，为滚动窗口留出余量。

## 看结果

- `report.md`：人读的清单，缺口优先，每个来源有条数、匹配来源 ID、官方新闻与原文示例链接。
- `report.json`：同一结果的结构化数据，含每组全部新闻，可供后续 session 继续核对。
- `inventory.json`：本次比较基线；生产导出含采集时刻与主机标签。
- `page-*.json`、`capture.json`：原始公开 API 页面与完整抓取快照，保留分页证据。

| 状态 | 可以得出的结论 |
|---|---|
| 未配置 | 未找到对应账号身份或原文站点配置；聚合 RSS、镜像与跨域跳转还需人工核对 |
| 已停用 | 找到配置候选，但它们全部停用 |
| 账号已配置 | 公众号 biz ID 或 X `from:` 账号命中启用来源；不是采集成功、无漏帖或过滤规则一致的保证 |
| 渠道已配置 | 已核实的显式渠道映射命中启用来源；聚合渠道下各原文站点不再分别算缺口 |
| 同站点，需核对范围 | 配置 URL/feedUrl/urlTemplate/allowUrlPrefixes 与原文同主机；栏目范围、分页与过滤规则仍需核对，不能据此宣称完全接入 |
| 身份待核实 | 原文缺少可解析的公众号 biz ID 或 X 作者；不根据名称猜账号 |

公众号从原文 `__biz` 解码获得数字 ID；X 从原帖 URL 取得 handle，大小写归一。普通网站按官方来源名称分组，组内保留所有原文主机，避免把聚合渠道拆成一批假缺口，也避免把同一网站不同栏目、arXiv 聚合渠道或 GitHub 项目混为一个来源。`www.` 归一，但不会擅自合并子域。原文重定向与第三方 RSS 别名不自动猜测。

`industry/source-audit-aliases.json` 保存人工核实的“官方来源名称 → 本地 source ID 数组”，默认包含 Hacker News buzzing.cc 渠道（本地 `radar-buzzing-hn` 的入口为 `https://www.buzzing.cc/feed.xml`）。只有确认采集渠道对应时才添加映射；不能用它把相关但不同的博客、X 账号或 GitHub 项目强行标成覆盖。可用 `--aliases` 指定另一文件，报告目录保存本次 `aliases.json` 供复核。

**时间和完整性边界**：请求 `/api/v1/items?mode=all&window=7d&by=timeline&limit=100`，沿 cursor 读到 `hasMore=false`，再按 `discoveredAt` 筛选本次固定起止时间。完整性仅覆盖该 API 的公开七天时间轴，不包括内部未公开、已删除、被过滤内容；若旧文章的 timeline 不在七天范围，也无法从此入口发现。它反映“近期收录来源”，不能证明“官方近期新添加来源”。分页期间可能有发布变化，API 不是事务快照。官方 `mode=all` 的相关性判断由官方负责，脚本不再调用模型筛选。

请求按 cursor 串行，每页后等待 1.1 秒，遵循官方每分钟约 60 次的限流提示。达到 `--max-pages`（默认 200）、重复 cursor、响应字段错误或请求失败均退出非零，不产出完整报告；已取页面保留。排查后用新目录重跑。不会重试付费请求，也不触发本项目模型调用。

## 离线复用与测试

更改本地来源配置后，可复用同一批官方数据，不重新访问网络：

```bash
python3 scripts/audit-source-gaps.py --sources industry/sources.json --replay .data/source-gap-audit/20261006 --hours 48 --out .data/source-gap-audit/recompare
python3 -m unittest discover -s scripts -p test_audit_source_gaps.py -v
```

离线模式沿用快照的截止时刻；`--hours` 仍控制筛选长度。报告中的基线标签、抓取时间与 inventory SHA 用于确认比较的到底是哪一份配置。后续接入来源另按[信源说明](../sources.md)执行；本脚本不会自动新增、启用来源或运行 backfill。
