# AI Radar · GitHub Primer 有效设计

2026-10-10 按 user-scope `web-ui-workflows apply-ui-template` 应用 `style:github-primer-product-ui`。定义来源：[模板 API](https://prompts.aiplanet.live/api/webui/v1/templates/github-primer-product-ui.json)，本次所用字节副本见 [template.json](github-primer/template.json)，SHA256 记录在 [effective-design.json](github-primer/effective-design.json) 的 `template.sha256`。模板依据 2026-10-10 实际观察的 GitHub Feed（登录态）与仓库公开页面，是视觉适配而不是 GitHub 页面复刻；本仓不使用 GitHub 标志、全局顶栏或仓库业务结构。

## 风格选择与继承入口

外观现有四个独立选择：亮色（默认）、暗色、Feedly、GitHub。`aihot-theme` 保存 `light` / `dark` / `feedly` / `github`，取值集合在 `lib/local-state.ts` 的 `THEMES`，首帧脚本、切换器、跨标签页通知与备份导入共用它；未保存或无效值回到亮色。旧版本代码遇到 `github` 会按无效值回到亮色，回退不需要迁移数据。

| 决定 | 依据与取舍 |
| --- | --- |
| GitHub 作为第四个可选风格，默认仍为亮色 | 用户 2026-10-10 对 Feedly 的同类问题明确要求“保留暗色和亮色，把新风格作为额外选项，亮色作为默认”；本次未改变该站点级默认（历史决定照旧遵守：前提与适用范围未变）。替换默认亮色或替换 Feedly 均被否决。独立 L1 决策评审一轮，无 blocker。 |
| GitHub 覆盖公开页、详情和后台 | 本次请求包含管理页面。后台没有独立切换器，跟随同一浏览器保存的选择，与暗色在后台的既有行为一致；管理员在公开页侧栏或“更多”页选 GitHub 后，后台即使用 GitHub。比较过的备选：后台固定 GitHub（会改变后台默认外观，未获要求）、后台另加切换器（新增界面，超出视觉应用范围）。 |
| 切换器改为 2×2 | 四个选项在 180px 侧栏单行会截断“Feedly”“GitHub”。该控件在四种风格下都变为两行；“更多”页外观行改为最小高度并加上下内边距，四种风格下控件均在行内。 |

`apps/web/app/github.css` 是 GitHub 选项的唯一视觉覆盖，全部选择器限定在 `:root[data-theme="github"]`；不使用 `:has(.public-site)`，所以公开 `SiteShell` 与后台 `admin-site` 都继承。新增页面复用 SiteShell / 后台 layout、语义 token、`buttonClass`、`PillTabs`、`Badge`、`ScoreLabel`、`FeedItem`、后台 `Card` / `Stat` / `DataTable` / `Button` / `Field` 即自动继承，不复制私有颜色。为了让样式能区分角色，本次只给既有组件加了无行为的钩子：`ui-button--{variant}`、`data-pill-kind="nav|tabs"`（链接切换与页内切换）、后台 `admin-card`、`admin-card-head`、`admin-stat`、`admin-badge--{tone}`、`admin-table`、`admin-btn--{tone}`、`admin-input`、`admin-chip`、`admin-dialog`、`admin-nav-item` / `admin-nav-active`；后台监控页的两个标签链接补了 `aria-current`。

## 页面、组件与状态盘点

范围来自 `apps/web/app/routes.ts`、侧栏/底栏/后台导航与真实页面，共 54 个路由样本：公开 41 个（含查询参数视图、条目/事件详情、分页、刊物期次与历史日期），后台 13 个。`/items/:id/original` 是外站跳转出口，不作为阅读页；`/admin/content/:id`、`/admin/selectbench/:runId` 在隔离库中没有数据，以列表页和同组件详情（信源详情）代表。

| 页面组 | 路由样本 | 组件与状态 | 模板条款 → 实现 |
| --- | --- | --- | --- |
| 框架 | 全部公开页 | 侧栏导航（当前/hover）、手机底栏、外观切换、回到顶部、导航进度条、跳到正文 | 应用框架与侧栏导航：白底、中性当前底+600字重+4×24px 蓝色竖条；底栏当前项 600+2px #fd8c73 底标；回到顶部改 6px 默认按钮 |
| 信息流 | `/`、`/all`、`/?category=`、`/all?channel=`、搜索忙 | 分类 UnderlineNav、搜索框、热点条、日期组、时间列竖线、新闻/X 条目、媒体缩略图、精选与评分标签、多信源与进展展开、推荐理由、收藏、加载更多 | 信息流事件卡（宽屏卡片 1px/6px/resting 阴影；窄屏分隔行）、带时间列的竖线与白心节点、Label 描边 pill、推荐理由 #f6f8fa 嵌入面 |
| 详情 | `/items/:id`（新闻、X）、`/story/:id` | 标题、来源行、阅读原文按钮、AI 导读、正文 prose、媒体、标签、推荐理由侧栏、更多操作菜单、分享海报弹窗、事件分段标签、事件时间线、热度图 | 正文与代码（16px 正文、600 标题、蓝色链接、代码块 #f6f8fa）、浮层（菜单 6px+浮层阴影）、页内分段（选中白底加边）、侧栏卡片与时间轴 |
| 热点与排行 | `/hot`、`/leaderboard`、分类榜、来源榜、规则、模型详情 | 头条卡、热度趋势图、前三名卡、榜单表格、名次、证据提示层、指标 | 数据表与排行（名次中性、无渐变/奖牌色、表头 muted）、指标（中性 #1f2328、600） |
| 刊物 | `/daily`、`/daily/archive`、日/周/月报期次 | 往期列表、刊头、期号日期块、统计带、头条、分栏、条目、手机期次 chip | 刊物与报告页（题头收敛、点阵日期隐藏、分节 20px 600）；期次 chip 为分段选中样式 |
| 目录 | `/topics`（含 `?tab=all`）、主题详情与分页、`/sources`（含 `?tab=selected`）、来源分组与详情 | 目录工具栏、搜索、仅看精选开关、主题卡、大事记时间轴、来源头像 | 分组列表 Box、搜索与表单（白底 1px、蓝色 focus）、开关轨道开启 #0969da |
| 监控 | `/codex-reset`、历史日期 | 状态卡、原帖引用、重置日历（今天/选中/确认/预告）、日期详情 | 指标、图表与热度格（贡献色阶 #aceebb 等、选中 2px #0969da 外框）、侧栏卡片 |
| 说明与表单 | `/about`、`/terms`、`/privacy`、`/changelog`、`/agent`、`/feedback`、`/more`、`/starred` | 介绍页大标题与信号河、条款长文、更新列表、代码块、反馈表单（禁用/启用/错误）、更多页分组列表、收藏空态与条目 | 正文、表单、空态（Box 内说明+链接）、按钮主次 |
| 后台 | `/admin/content`、`sources`、`sources/new`、`sources/:id`、`monitor`、`feedback`、`runs`、`backfill`、`models`、`selectbench`、`settings`、`audit`、`login` | 后台侧栏与手机横向导航、页头、统计卡、Box 卡与头部、数据表、状态 Badge、筛选 chip、表单字段、原因确认对话框、Toast | 管理后台与设置页（Box 头部 #f6f8fa、绿色主按钮、默认按钮、危险按钮红字）、导航当前项、浮层 12px 对话框 |

## 项目例外

- AI Radar 名称、青色品牌圆点、“AI日报”刊名与后台标志保留；交互强调改为 #0969da，主动作改为 #1f883d。
- 系统字体栈保留中文回退，不加载 Mona Sans。
- 手机端信息流保持既有“时间列 + 分隔行”结构，不改为逐条卡片；宽屏才使用事件卡。
- 业务状态色保留含义：热度上升、“爆”、失败、精选、确认/预告日均映射到 Primer 语义色，不改为中性。
- 介绍页“信号河”动画保留原结构，颜色随强调色；分享海报由 API 渲染，保持上一版固定白底，不随网页风格变化。
- 暗色、亮色与 Feedly 不受影响；后台以前只有亮色/暗色，Feedly 覆盖仍不进入后台。

## 核验

批量规则：[effective-design.json](github-primer/effective-design.json) 编译 29 条规则（20 条机器规则、9 条人工阅读），公开与后台分别由 [scope-public.json](github-primer/scope-public.json)、[scope-admin.json](github-primer/scope-admin.json) 固定完整分母（41×2 与 13×2 个页面状态/视口组合，1440×1000 与 390×844）。执行：

```bash
python3 scripts/verify-github.py --scope docs/references/github-primer/scope-public.json --output <持久证据目录> --jobs 6 --capacity-reason '共享公网 API 与本机浏览器容量' --direct
python3 scripts/verify-github.py --scope docs/references/github-primer/scope-admin.json --output <持久证据目录> --jobs 4 --capacity-reason '本机隔离后台' --direct
```

后台 scope 指向隔离实例 `http://127.0.0.1:3312`：本机独立 PostgreSQL 测试库（迁移+seed，268 个信源、无内容）、`DEV_AUTH_ROLE=admin` 的本机 API 与 Web，采集/模型/推送安全阀全部关闭；不登录生产后台。阳性对照：同一组规则在默认亮色上运行，画布、文字、强调、边线、标题字重、控件圆角、标签、下划线、排行渐变、名次与指标规则均报 FAIL；“导航当前项 600 字重”在亮色下同样成立，不能区分风格，只作回归检查。

本地读数、生产读数与人工阅读记录见下文“验收记录”。

## 验收记录

2026-10-10 生产发布为 `releases/github-primer-20261010-5f6bd70`（前一版 `github-primer-20261010-fd19748`），只重启 Web；API、worker、数据库迁移与 seed 未动。公网根样式 `root-BBPBvc73.css` 与本地构建逐字节一致。撤下 GitHub 选项时把 `current` 指回 `three-styles-20261010-91a0b9b` 并只重启 Web；旧代码把保存的 `github` 当无效值回到亮色。原始结果、截图与阅读记录保存在维护者本机 `~/.local/state/aihot-github-primer-20261010/`。

| 读数 | 范围 | 结果 |
| --- | --- | --- |
| 生产批量（fd19748 与 5f6bd70 各一次） | 公开 41 状态 × 2 视口 | 机器规则 832 PASS、0 FAIL、0 执行错误；562 项为该页没有对应组件（无样本），246 项 NA |
| 生产人工阅读 | 同上，按 finalize 闭合 | 27 个页面状态/规则组合 PASS（首页、模型分类、新闻与 X 详情、日报、周报、热点、排行、重置日历、主题、来源、反馈、收藏、Agent、关于、更多），629 项未逐一阅读，82 项 NA |
| 本地后台批量 | 隔离实例 13 状态 × 2 视口 | 修复前 `/admin/runs` 390px 1 FAIL；修复后 242 PASS、0 FAIL，90 项无样本，188 项 NA；人工阅读 5 项 PASS |
| 阳性对照 | 同一规则跑默认亮色 | 72 FAIL，规则能区分风格（“导航当前项 600”除外） |
| 公网 smoke | `scripts/smoke.ts --base https://news.aiplanet.live` | 两次发布后均通过 |

真实操作读数（生产，1440 与 390）：新浏览器默认亮色；侧栏和“更多”页选择 GitHub 后写入并刷新保持，2×2 切换器在行内；分类切换出现 2px #fd8c73 底标；信源与进展展开；详情菜单 4 项与分享海报弹窗（12px 圆角、1080×1440 图、可关闭）；日报期次 chip 选中为 #0969da；排行榜 390 页面宽 390；重置日历选日；反馈表单空时提交禁用、输入后可用（未提交）。

`/admin/runs` 的窄屏溢出最初被误判为 Box 头部不换行；实际原因是单列 grid 中的 Box 按表格 640px 最小宽度撑开。修复为 Box `min-width: 0`，同时更正了模板的回写。亮色与暗色下该页仍宽 656px，属于既有问题，本次未改。

后端测试首次运行 5 个失败；全新测试库重跑与改动前基线均 372/372 通过，判为环境性不稳定，未改测试。

本仓 [template.json](github-primer/template.json) 是本次应用与核验所用的模板字节。模板随后只修订了“分组列表 Box”中 grid/flex 内取 `min-width: 0` 一句，本仓已按修订实现；下次重新应用时再同步副本与 SHA。

### 覆盖与未覆盖

| 类别 | 项目 | 原因与处置 |
| --- | --- | --- |
| 模板没规定 | 分享海报图片 | API 渲染的固定白底图片，不随网页风格变化，按项目例外保留 |
| 模板没规定 | 介绍页“信号河”动画、外观切换器形态 | 产品特有组件，只随 token 改色 |
| 产品未落实 | 后台 Toast | 继承语义 token 与浮层圆角，没有专门规则，也未在页面上触发观察 |
| 产品未落实 | 亮色下排行榜 1440 宽到 1480px、后台运行页 390 宽到 656px | 既有亮色问题，不在 GitHub 风格范围 |
| 尚未验证 | 生产后台 | 只在隔离本地实例核验，未登录生产后台 |
| 尚未验证 | `/admin/content/:id`、`/admin/selectbench/:runId` | 隔离库无数据，用同组件详情代表 |
| 尚未验证 | 其余 629 个公开组合的逐页阅读、非 Chromium 浏览器、旧版本缓存升级 | 机器规则已通过，人工阅读只覆盖上表页面 |
| 尚未验证 | 用户审美认可 | agent 检查不等于用户认可 |
