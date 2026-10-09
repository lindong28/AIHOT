# AI Radar · Feedly 清爽阅读器有效设计

2026-10-09 按 user-scope `web-ui-workflows apply-ui-template` 应用。来源：[模板定义](https://prompts.aiplanet.live/api/webui/v1/templates/feedly-reader.json)，id `style:feedly-reader`；本次原文字节 SHA256 `08e20c1f1b6c34e6f840285a781a993286001e3bfb724d1ddefc0316b1d60e29`，副本见 [template.json](feedly-reader/template.json)。这是公开 Feedly 阅读器风格的适配，不是官方 token 或像素复刻。

## 共享实现与继承

`root.tsx` 的 `SiteShell.public-site` 是所有公开路由（含错误详情）的继承入口；`reader.css` 是本次唯一浅色覆盖。变量在带公开 shell 的浅色根元素解析，让 Tailwind 语义颜色、圆角和阴影保持一致。新增公开页面复用 SiteShell、语义 token、Controls、PillTabs；信息流复用 FeedItem，不复制页面私有颜色。后台不进入该 shell，深色继续用 app.css 的原定义。

白色画布、#f7f8f7 导航、#f4f6f4 辅助面；正文 #202521、摘要 #59635d、元信息 #66716a，边线 #e6eae6；强调 #187b3c、淡绿选中 #edf7ef。条目标题18px/1.45、摘要15px/1.75、来源12px；桌面摘要和理由最长72ch。常态条目无外框、无阴影，细线及留白分隔；控件/缩略图6px，浮层12px。

## 项目例外

- 保留 AI Radar 名称与青色品牌圆点，深色圆点仍沿既有青色；热点红、精选金、状态色保持业务含义。
- 原系统字体栈、页面/刊物标题尺寸、详情17–18px正文及760px上限、页面响应式宽度保留。模板字号是适配基线；刊物题头、榜单、时间线不改为同一种列表。
- 保留既有筛选的小尺寸与触摸高度、圆形图标按钮、标签形状、报告及监控的业务分组。共享文字按钮和筛选切换使用6px圆角；不全局抹掉语义分组。
- X 动态没有新造标题；摘要仍沿原来的折叠行数，完整内容从详情访问。无全文条目继续提示阅读原文，不伪造正文。图片资格、代理和加载不变。
- 不新增侧栏、订阅、封面、收藏或视图切换；只重绘已有部件。深色保留原设计，后台排除于视觉应用范围。

## 覆盖与核验

[scope.json](feedly-reader/scope.json) 固定 [有效规则](feedly-reader/effective-design.json) 与 [项目绑定](feedly-reader/project.json) 的完整摘要。覆盖精选/全部/搜索忙状态、热点/事件、日周月报及归档、主题与分页、来源目录及详情、模型榜各子页、重置监控及历史、收藏、接入、关于/条款/隐私/更新/反馈/更多、两种条目详情。查询覆盖类别、一手、精选/全部切换。`/items/:id/original` 是原文出口，保留原行为，不作为新阅读页；管理后台不是应用目标。

基础扫描覆盖41个路由/查询样本 × 2视口（1440×1000、390×844），检查画布、强调/边线变量及整页溢出；FeedItem页面另查字号和阴影。人工阅读与交互独立记账，机器扫描不证明可读性，也不代表穷尽全部内容。执行器：`python3 ~/.claude/skills/web-ui-workflows/workflows/apply-ui-template/verify-ui.py --scope docs/references/feedly-reader/scope.json --output <持久证据目录> --jobs 4 --capacity-reason '共享公网API与本机浏览器容量' --screenshots --direct`。

## 发布与验收（2026-10-09）

部署到 `tencent-webserver-china:/home/ubuntu/aihot/releases/feedly-reader-20261009-r2`，通过既有 release → current → systemd Web 流程发布。执行锁定依赖安装与 Web 构建，未执行 migration/seed；只重启 Web。API PID 928505、worker PID 928519 保持；上一版本 `transient-recovery-20261007-971dee99` 保留，可回切 current 后只重启 Web。复制上一 release 的哈希静态资源以兼容已打开的页面；不改 Nginx/CDN 策略。

420 个运行源码文件与本地逐字节一致，公网 `root-B-AdSWON.css` SHA256 为 `5564c13e88bec62fd695ad5db45300b5605b53dec13f5e15979169904285f4cb`，与本地构建相同。本地 `npm run typecheck`、Web 构建、11 个 Web 测试通过；独立 PostgreSQL 55439/aihot_feedly_test 中迁移后372个测试通过，测试cluster已停止。公网既有 `scripts/smoke.ts` 全部检查通过。独立审查一轮无遗留finding，浮层修正另由原reviewer限定复核。

批量首轮发现榜单前三名卡片的提示浮层越界：1440视口整页1480px。浅色桌面 Podium 的提示改为向卡片内侧对齐；生产修正后1440/1152/1800三个CSS视口分别与整页宽度相等。后两者作为125%/80%缩放的布局视口等效检查，不声称操作了浏览器原生缩放或验证其他渲染引擎。

| 条款 | 实际取样与边界 |
|---|---|
| FR-V01 | 共享root变量覆盖公开页；品牌青色圆点保留，后台登录仍为暖底/青色。浅色、深色、跟随系统控件沿用；深色实测回到 #13191c/#12ccd8，切浅恢复白底/绿色。 |
| FR-V02 | 首页长标题的 InfoQ、短 X 动态 Tibo、有视频缩略图的 Sundar Pichai；1440与390宽度阅读，来源/时间与正文关联，图片不挤占无图条目。 |
| FR-V03 | 普通FeedItem没有卡片阴影，以细线和留白分隔；推荐理由保留为辅助层，热点/刊物/模型榜分组按项目例外保留。 |
| FR-V04 | 模型分类切换后URL及选中态一致；来源与进展展开、日期折叠、键盘焦点、详情菜单、收藏后在收藏页回显已操作；指针及键盘均有实际操作读数。不提交反馈、不触发分享外发。未人为制造全部禁用/失败状态，禁用定义未改。 |
| FR-V05 | 宽窄屏阅读无全文提示及阅读原文、X正文702字符和视频缩略图，滚动至来源；手机日报阅读题头、长段落、插图与后续条目。保留原全文权限，不将摘要当全文。 |
| FR-V06 | 代码diff仅共享视觉和语义样式标记，无业务功能新增；品牌/路由/内容/已有业务语义保留。未覆盖其他浏览器引擎、已认证后台和所有数据/异常排列。 |

N-1浏览器资源存在 `transferSize=0, decodedBodySize>0` 缓存命中，发布后普通reload曾短暂取得旧HTML；沿既有缓存时效再次普通reload取得新白底/绿色与新资源，未清空缓存冒充暖缓存验收。该读数覆盖一个桌面会话，不外推全部CDN节点。原文外站阅读及视频外站播放不属于本次视觉验收。

原始扫描、截图、人工阅读记录、源码字节核对和review保存在本机 `/Users/lindong/.local/state/aihot-feedly-20261009/`；机器扫描与实际阅读分别报告，未运行状态不计为通过。最终同一 scope 的41个页面/查询状态 × 2种视口（1440×1000、390×844）共82个组合全部执行：机器规则检查360项PASS、0项FAIL，370项有依据的NA，8项实际阅读记录闭合；执行与清理错误为0。最终证据为 `public-confirmed/results.json`、`observations-confirmed.json` 与 `delivery-confirmed/delivery.md`。前两轮日报就绪超时和首次榜单越界保留于原报告，均已复验，不覆盖历史读数。
