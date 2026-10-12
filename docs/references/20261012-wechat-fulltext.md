# 公众号正文修复

读者：维护者。2026-10-12 用户要求所有公众号（历史导入及新采集）补正文，并明确要求实施。覆盖本站展示；RSS 全文许可保持原设置。本文承接本次执行与恢复状态。

## 已批准决定

L1 独立决策审查七项成立，放行（2026-10-12）。公众号本站全文开启，覆盖 mp_account 和三个 archive-radar-wx 来源；已有 HTML 优先、纯文字安全兜底；残缺正文先复用留存版本再定向抓原文，不按字数判完整，不全量重新分析。仅 HTML 修复不改分析；实质正文修复增加 revision，通过新 repair backfill run 复核，旧冻结材料与回执保留。修复采用快照、revision/hash 比对及原批次执行锁；新批次保留原模型绑定和预算。

本决定 supersedes 20261004-wechat-sources.md 的公众号本站全文关闭部分，RSS 与暂停来源状态不变。开启全文会依既有规则影响报告配图候选及时间线代表稿选择（20261006-report-images.md），显式 reportImages=false 继续有效。旧分析不得给修复后的正文授予发布资格。

## 生产基线

2026-10-12 只读查询：4768 篇公众号文章（mp_account 611、mp2rss 3408、wechat2rss 历史 687、知识库 62）；全部正文状态 ok、文字非空，但来源 site_fulltext 全关。63 篇缺 HTML，8 篇为已确认空壳或微信 UI 垃圾。670 条 filtered 历史原材料没有 article_id，不作为页面缺口自动发布。公开样本 i6ffj8wdfv6lsem2l3grt55iz 入库正文 4922 字而 API body=null。

未验证：逐篇原文完整性、所有媒体模板、微信原文可达性；不得把本次覆盖统计称作逐篇全文完整率。

## 生产结果

已部署 `/home/ubuntu/aihot/releases/wechat-fulltext-20261012`，旧 release `github-audit-20261010-978aed2` 保留。43 个 mp_account 和 3 个历史来源全部开启 site_fulltext，46 个来源的 syndicate_fulltext 仍为 false，三个历史来源仍暂停。核对时共 4769 篇（新采集 612、mp2rss 3408、wechat2rss 历史 687、知识库 62），4766 篇投影为 full，3 篇空壳为 unconfirmed；61 篇纯文字通过安全转义展示，不需要伪造 HTML 原稿。该统计表示本站展示资格，不等于逐篇与微信原文比对后的完整率。

恢复 6 篇：`fizc36fpr8lghijfx5ncp0vvg`、`u5va6l23azmqf90f43emz0acz`、`tiaew29f48em5j18j4qjr92bx`、`plct85mq9h79xkv8m999jiwo8`、`xoierx52okkxdeawr9hcy2lcr` 更新正文，`eg7cvvi6coqew37vc44uuis1i` 只补 HTML。五个新 repair 批次全部 complete / published；同一清单生产重放返回 reused，未新增 revision 或分析批次。旧材料及回执未改写。

消费者核验覆盖 3 种来源/正文形态：原问题 mp_account 文章、纯文字知识库 `dn0vtpg3dp13fgv9tm21jo2f8`、修复图文 `fizc36fpr8lghijfx5ncp0vvg`。公网 API 返回正文，headless 浏览器实际页面分别读到 5569、6608、3676 字符；图文页 10 张图片。空壳对照 `geplyuln37mmpbx7hfntpulkh` 返回 body=null、markdownAvailable=false。未宣称全量媒体播放与图片加载均已验收。

本地验证：类型检查、前端构建与 19 项前端测试、站点 smoke、隔离 PostgreSQL 后端 380 项测试通过。最后补充并发计数测试：修复前终端少报来源/投影数，修复后准确累计；计数错误不影响数据库更新。整体实现已过独立审查，两项 HIGH 已闭环；最后计数修正由能复现失败的回归测试验证，不追加外审。非阻塞文本恢复分支与告警后续见 [issues/general.md](../issues/general.md)。

### 尚未恢复的 3 篇

| 文章 ID | 标题 | 当前证据与下一动作 |
|---|---|---|
| geplyuln37mmpbx7hfntpulkh | 我的怎么不行呢：为了你的账号安全，请重新登录 | 归档与上游留存仅“跳转微信打开”；原文需微信验证 |
| y9vhe2nuufpszwear3zvkrwr2 | Claude发现新酶系统，发出类人兴奋 | 同上 |
| ykj3qwz7lqi2gz8hu96r1mk37 | 三招降低Claude成本，而不影响性能 | 同上 |

这三篇保留原始空壳及审计，停止把它们当有效正文。负责人：AIHOT 维护者；下一动作是在微信原文恢复可读或取得合法正文导出后，用 audit 新快照和 apply 清单补齐。当前历史来源暂停，不承诺后台会自动补齐这三篇。抓取侧和生产主机均取得微信验证页，无可用 `#js_content`；未绕过验证、未用模型生成正文。

### 其他数据源的边界

默认只展示摘要及链接是原设计；本次明确改变公众号本站展示策略。生产投影核对仍有 RSS 112640、JSON 列表 2000、网页列表 815 篇不处于 full 模式；external 历史混合源中 14695 篇不处于 full。X 有独立原帖呈现逻辑，不能把 body_mode 非 full 一概称作缺失原帖。其它来源未在本次改变许可或启动全文回填。

### 运维与恢复

生产审计、六篇恢复清单与前后报告留在 `/home/ubuntu/aihot/shared/wechat-fulltext-20261012/`；本机证据保全路径为 `/Users/lindong/research/AIHOT-artifacts/wechat-fulltext-20261012/`，不提交正文及凭据。修复代码落本地分支并整合 main，未授权 Git push。独立工作树及测试 PostgreSQL 在交付前回收；不停止其它实例。

受影响链路检查：正常公众号 RSS 不增加原文请求，仅缺口才补抓；上限 8 对应当前 HTTP/数据库池容量。发布重建仅运维显式调用，逐来源分批；详情清洗只处理当前文章，不扫描全库，读者访问不调用模型。尚无原页面延迟基线，不宣称性能提升。

## 维护入口

`node --env-file=/path/app.env scripts/repair-wechat-fulltext.ts audit <新清单.json>` 只读核对开启状态、缺 HTML 与已观察到的微信空壳，不是全文完整性判官。`enable` 更新公众号本站全文并重建既有公开投影，保留 RSS 全文许可、启停和游标。重复运行可收敛中断的投影重建。

`apply <manifest.json>` 接收数组：`articleId`、审计提供的 `expectedHash`、经核对的 `bodyText`、`bodyHtml`（可为 null）、`evidence`（原文 URL 或冻结版本定位）。逐篇事务提交，原正文留在 audit_log；同一清单重复执行不再修订。仅 HTML 修改不重新分析。实质正文修改为新 revision 并暂缓旧分析对应的入池与精选资格，正文仍可从详情读取；有人工覆盖的条目拒绝自动修复。managed 历史生成暂停的新回填批次，复用原模型绑定，通过已有回填入口显式启动；不改旧批次材料和回执。

Wechat2RSS 仅对当前窗口中缺正文的条目尝试直接原文 HTTP（最多八个并行、每个 20 秒），正常内容不多抓一次。仍取不到的条目不进入分析，正常条目保留，来源与 fetch_runs 报失败并按原间隔再检查。图片消息或验证页可能仍需人工恢复。来源失败继续由既有信源周报呈现；及时正文缺口告警的后续归属见 issues/general.md。
