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
