# AI Radar 生产切换

2026-10-01，用户明确要求立即停止旧 AI Radar 采集，并将 `news.aiplanet.live` 切到本仓代码；此前仅本机实施的范围据此更新。历史回填继续等待个人 Gateway 的 GPU 模型，不导入旧评分、标签、分类、精选关系或日报。

采用项目已支持的原生部署：腾讯云现有 Ubuntu 主机运行 Node.js 24、PostgreSQL 16、API、Web、worker，由 systemd 管理。Nginx 保留既有证书、域名和 HTTPS，只将本域名代理到新 Web。个人 Gateway 保留本机权威，通过专用 SSH 隧道只在服务器回环地址提供访问。源码、服务定义及运维入口由本仓维护，凭据另存权限受限文件。

未采用 Docker 整栈：当前主机尚无 Docker，原生路径已经受项目支持。未采用本机运行整个站点再反向代理：服务器本地 Web/DB 可在 Gateway 隧道中断时继续提供已发布内容。没有在服务器另建一份共享 Gateway，也不修改其政策或模型部署。

实施前读数：生产机 4 CPU、3.6 GiB RAM、2 GiB swap、28 GB 可用磁盘；Node/PostgreSQL/Docker 尚未安装。旧站 HTTPS 返回 AI Radar 页面。2026-10-01 15:38 UTC 已停 Mac mini 的四项采集、处理、同步 cron，保留原库和旧 Web；当时正在执行的旧库发布需在新站切换前收尾。

正式切换条件：沿用既有 AI Radar 品牌和原站的沪ICP备2026017013号；不把 MyHOT 或未确认的条款、隐私模板发布为正式内容。Qwen Token Plan 的既有授权仅覆盖本机 MVP，其生产使用另行确认。实际验证新 worker 到 Gateway 的调用和回执、真实来源采集、公开读取层发布以及公网网页。未知项不以进程存活或本机历史测试代替。

独立决策审查：一轮及品牌边界窄复核，七项判据成立，允许安装与准备；上述上线条件仍需兑现。旧 Radar ADR-039 的 DNS/CDN 边界保持，ADR-042 只约束旧仓部署 ref，本次不写该 ref、不执行 git push。

告警待办（归属：本仓 AIHOT 迁移维护者）：接管生产 worker、Gateway 隧道和公开站点故障通知。现有心跳与后台告警不等于已接通推送；未完成前不宣称无人值守通知已验收。

## 2026-10-02 准备阶段补充

此节补充后续实施状态，不改写上方实施前快照。腾讯云已安装 Node.js 24.21.0、PostgreSQL 16.15；`/home/ubuntu/aihot/releases/cutover-20261001` 已完成依赖安装、Web 构建、36 次数据库迁移和 163 个来源 seed，`current` 指向该版本。共享配置与数据独立保存，API/Web 的 systemd 服务已运行；worker 已 enabled 但停止，采集与模型全局开关均关闭。

Mac mini 四条 cron 的精确停止时间为 `2026-10-01T15:38:51Z`，备份在该机 `~/.local/state/aihot-cutover/20261001T153851Z/`；上方记为在途的旧同步进程随后已停止。腾讯云 `ai-radar-db-apply.service` 已停止并禁用。旧 8000/8001 Web 与数据保留，公网 Nginx 尚未修改，Wechat2RSS 仍在原机运行、未完成迁移。

Mac Studio 的专用 launchd 隧道已将本地 Gateway 39011、代理 59527 反向映射到腾讯云回环 39031、39032；启动时经 `/bin/zsh` 与 `.zshenv` 解析原生 SSH agent socket，未固化临时 socket。腾讯云已取得真实 Gateway health 与代理请求的 200，未做重启恢复测试，也未据此认定模型链路可用。

真实原生采集只覆盖 RSS、Web、JSON、X 各一个来源、各 8 条，合计 32 条原始文章；新站公开内容仍为空。内部 smoke 已执行，模型榜三个入口因空数据返回 503 而跳过。首次测试误继承生产环境并发出 5 次真实 Gateway 调用，随后已停止并在干净环境完成离线重跑；误调用不属于生产 worker 验收，账本细项留本次私有证据。

旧 Nginx 配置备份已建立于腾讯云 `/home/ubuntu/aihot/shared/news.conf.before-aihot`，`nginx -t` 成功，旧公网仍返回 200。独立无界面浏览器已从新站内部首页点击“全部 AI 动态”进入 `/all`，显示尚无内容；`/admin` 进入密码登录页。此读数不包含文章质量或连续性验证。

尚待用户确认生产 Qwen 订阅使用范围与条款、隐私正文；`.data/cutover/review/site-pages.md` 是未发布草稿。AIHOT 维护者继续负责真实业务调用与回执、连续 worker 到公开内容的验证、Nginx 切换及外部告警接管；历史回填未启，等待用户提供模型名和部署资源。操作入口与回滚步骤见[生产运维](../operations/production.md)。

## 2026-10-02 页面确认

用户随后明确采用使用规则和隐私说明草案，正文已替换 `industry/pages/` 的模板。对 Qwen 用户要求解释套餐用途冲突，尚未选择线上资金路径；因此生产模型和公网切换仍待该决定。再次核对[百炼个人版说明](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview)，“订阅前须知”仍排除自定义应用后端及非交互式批量调用。此前将延续订阅列为推荐不妥，已向用户更正；调用成功与经过 Gateway 均不改变其用途限制。

## 2026-10-02 生产启用

用户在知悉前述用途条件后明确要求：“不要管百炼的套餐用途限制，直接将 token plan 用在线上生产所需要的自定义应用后端和无人值守的批量调用”。这是用户在已知条件下作出的生产选用决定，更新此前仅本机的任务授权，不表示供应商条款改变。生产预筛与结构抽取两个 Qwen 角色以 `default` 指向 Token Plan selector，其余具名角色保持；配置经过一次独立窄审，无 finding。本轮未修改业务代码。

以下为实施主线程在腾讯云、个人 Gateway 和公网真实入口取得的启用窗口读数。systemd 显示 worker 于 `2026-10-02 10:23:15 CST` 启动，观察时 `NRestarts=0`。Nginx 配置替换并于 `2026-10-02T02:25:07Z` reload，原域名、证书和 TLS 保持；紧接 reload 的首次源站请求返回 404，随后公网 `/api/health` 返回新站的 200，页面、详情、RSS 与公开 API 均读到新内容。首次 404 保留为切换期间的异常读数，不将后续正常状态解释为全程无中断。

公网 `smoke.ts` 本次完成页面、公开机器出口与 MCP 检查，无失败、无跳过项；范围为同一生产部署的一次执行，包含三个模型榜页面，不外推长期可用。独立浏览器从首页点击进入 `/items/c546c99nua4z79qvy4kj1mtst`，读到中文标题、摘要、来源及推荐理由；详情内容观察为 1 篇，不外推所有文章质量。此前离线后端 153 项和 Web 11 项测试属于既有验证，本轮没有重新执行。

同一公网部署、1440 × 900 视口下，从精选点击“全部AI 动态”至 main 内容变化，首次为 1152.6 ms、再次为 67.3 ms，阴性对照为 `no_change`。这是一个导航动作的两次读数，不代表全站性能。

约 `10:27 CST` 的数据库快照为 588 篇文章：`new=545`、`analyzed=41`、`blocked=2`；41 篇满足公开条件，其中精选 5 篇。来源健康快照覆盖 40 个 RSS、10 个 `web_list`、4 个 `json_list`，均为 `ok`；109 个 X 账号为 21 个 `ok`、88 个 `unknown`，首次触发 SocialData 预算后退避 15 分钟。既有 `10/min`、`100/hour`、`1000/day` 预算保持，不将退避中的账号记为采集成功或来源失效。调度记录中 `sources.schedule` 四轮成功，`monitor.tick` 一次分钟预算失败后四轮成功，`leaderboard.round` 成功；这些是启用窗口观察，不是长期连续性保证。

本次最终观察冻结于 `2026-10-02 10:30:00 CST`：文章增至 682 篇，满足公开条件 88 篇（其中精选 12 篇），未知回执为 0，`sources.schedule` 累计七轮成功。此快照表明上述启用窗口内采集与公开内容继续增长，不将变化中的总量作为固定验收目标。

该窗口 Gateway 成功账本快照为 Qwen `personal_bailian_token_plan` 91 次、GLM `personal_zai` 103 次、DeepSeek `personal_deepseek` 43 次、Embedding `personal_dashscope` 30 次。调用仍在增长，这些计数不是冻结批次、全量账单或总费用。主线程将下列应用回执请求身份逐一与 Gateway SQLite 账本核对：4 种模型各 1 例，均只有 1 个 attempt，`project=aihot`、`outcome=success`，profile 与 model 相符；不据此宣称全部请求均已逐条对账。

| 模型路径 | 已关联的请求身份 |
| --- | --- |
| DeepSeek | `6156289f-8edc-497c-be6b-c227a71a25f1` |
| GLM | `0b25da09-5cb0-4892-a3d1-abb8e9e5a1f0` |
| Qwen | `6fbd62e5-fe58-4e01-97ed-ac4deabec960` |
| Embedding | `a847b194-334c-481d-9efb-ef132bb034e3` |

旧 cron、在途同步和腾讯云旧库应用服务继续保持停止，旧 Web、数据库和 Nginx 配置备份保留。Wechat2RSS 仍在原机运行，迁移未完成；历史 `backfill_runs=0`、受管回填文章为 0，继续等待用户提供 GPU 模型及资源。AIHOT 维护者负责跟进剩余 X 首采与退避、待处理及 blocked 文章、worker 长期运行、隧道重启恢复和外部故障通知接管；外部告警尚未验收。运维与回滚沿用[生产运维](../operations/production.md)，不因公网回滚自动恢复旧采集，也不覆盖新数据库。
