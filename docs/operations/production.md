# 腾讯云生产运维

面向部署维护者，说明新 AI Radar 的发布、起停、检查与公网回滚。截至 2026-10-02 仍处准备阶段：腾讯云 API/Web 已运行，worker 已 enabled 但停止，`COLLECT_ENABLED=false`、`MODEL_CALLS_ENABLED=false`；公网仍是旧 RADAR。生产 Qwen 订阅使用与条款、隐私正文仍待用户确认。实时与历史两条模型链均经个人 Gateway，历史回填尚未启用；实时模型配置以 [app.env.example](../../deploy/production/app.env.example) 为准，回填另见[历史回填](backfill.md)。

## 环境与持久数据

| 位置 | 用途 |
| --- | --- |
| 腾讯云 `/home/ubuntu/aihot/releases/cutover-20261001` | 本次发布源码；后续发布使用新的 release 目录 |
| 腾讯云 `/home/ubuntu/aihot/current` | 指向运行版本的符号链接，systemd 从这里启动 |
| 腾讯云 `/home/ubuntu/aihot/shared/app.env`、`web.env` | 后端与 Web 运行配置；后端凭据文件权限为 0600，不入 Git、不打印内容 |
| 腾讯云 `/home/ubuntu/aihot/shared/data` | 应用持久文件；PostgreSQL 数据由系统数据库服务独立管理 |
| 腾讯云 `127.0.0.1:3001`、`:3000` | 新 API、Web；Nginx 切换后代理到 Web |
| 腾讯云 `127.0.0.1:39031`、`:39032` | 专用隧道提供的个人 Gateway 与 HTTP 代理 |

腾讯云已安装 Node.js 24.21.0、PostgreSQL 16.15，完成依赖、Web 构建、数据库迁移及来源 seed。代码包不包含 `.env`、`.data/` 或共享目录；更新源码不覆盖这些持久状态。Web 配置模板见 [web.env.example](../../deploy/production/web.env.example)。

## 部署更新与起停

统一入口为 `deploy/production/{install,start,stop,status,uninstall}.sh`；隧道对应入口为 `deploy/production/tunnel/` 下同名脚本。下文的动作分派命令仍可直接使用，两组入口复用同一实现。

以下命令在**腾讯云**执行。将本仓已审核源码放入新 release 目录后，从该目录运行：

```bash
bash deploy/production/prepare-release.sh
```

它安装锁定依赖、构建 Web、应用增量迁移并 seed；不会更新 `current`、启动服务或切换公网。seed 不覆盖已有来源配置。数据库迁移不是随代码回滚而自动撤销的操作。

生产模型使用范围和正式页面正文确认、真实链路验证安排就绪后，部署更新使用：

```bash
bash deploy/production/service.sh install
bash deploy/production/service.sh status
```

`install` 会再次准备发布、更新 `current`、安装 systemd 定义，并 enable/restart API、Web、worker **全部三个服务**；`start` 和 `restart` 也作用于全部三个。它们不是“只更新前台”的命令。准备阶段保持 worker 停止；若需在此阶段安装服务，应由实施者在关闭安全阀的前提下操作并停止 worker，不把一次全服务启动算作连续验收。worker 当前 enabled，主机重启时可被拉起；关闭的安全阀仍应保留到生产启用条件完成。

日常操作入口：

```bash
bash /home/ubuntu/aihot/current/deploy/production/service.sh start
bash /home/ubuntu/aihot/current/deploy/production/service.sh stop
bash /home/ubuntu/aihot/current/deploy/production/service.sh restart
bash /home/ubuntu/aihot/current/deploy/production/service.sh status
```

按需运行其中一条。`stop` 保留安装及开机启用状态；`uninstall` 停止并注销三个 systemd 服务，保留发布目录、凭据和 PostgreSQL 数据。修改 `app.env` 或 `web.env` 后，相应进程需重启才读取新值；源码更新走新 release 的 `install`，不能只拉代码而不构建和重启。

## 状态与故障定位

腾讯云检查：

```bash
bash /home/ubuntu/aihot/current/deploy/production/service.sh status
systemctl --no-pager status postgresql
curl --fail --max-time 15 http://127.0.0.1:39031/health
curl --fail --max-time 15 http://127.0.0.1:3000/api/health
cd /home/ubuntu/aihot/current
node scripts/smoke.ts --base http://127.0.0.1:3000
```

`status` 显示 systemd 状态，准备阶段 worker inactive 会使其返回非零；这不等于 API/Web 也停止。Gateway health 不证明模型授权或上游可用，Web/内部 smoke 不证明公网已切换或有新内容发布。模型榜无发布轮次时，三个相关入口的 503 是跳过项，不能记为榜单可用。

本次原生采集仅覆盖 RSS、Web、JSON、X 各一个来源，每源 8 条；32 条是原始入库量，公开内容仍为空。生产启用后应从真实采集、处理、公开页面/RSS/API 及 Gateway 回执核对同一批内容，再观察 worker 持续更新。

服务日志在 journald，可用 `journalctl -u aihot-worker.service -n 100 --no-pager`，API/Web 换相应 unit；向外提供日志前先去除凭据和私有 URL。后台“运行”页查看任务与未知回执；未知模型结果先核对 Gateway 账本再恢复，不因进程重启自动重复请求。

外部故障通知的责任与待办见[根 README 服务章节](../../README.md#服务)。当前 systemd 重启、后台状态和日志不能替代外部通知；原有服务告警继续保留。

## 个人 Gateway 与代理隧道

以下命令在 **Mac Studio 本仓 checkout** 执行，按需要选一个动作：

```bash
python3 deploy/production/gateway-tunnel.py install
python3 deploy/production/gateway-tunnel.py status
python3 deploy/production/gateway-tunnel.py stop
python3 deploy/production/gateway-tunnel.py start
python3 deploy/production/gateway-tunnel.py uninstall
```

`install` 更新并加载用户 launchd 作业 `live.aiplanet.aihot-gateway-tunnel`；`stop` 保留 plist，`uninstall` 才移除它。Mac Studio 的 `39011` Gateway 和 `59527` 代理分别反向映射到腾讯云回环 `39031`、`39032`。代理端口改变时以 `install --proxy-port 实际端口` 重建；默认 SSH 主机别名为 `tencent-webserver-china`，可用 `--host` 指定已配置别名。

启动经 `/bin/zsh` 读取该机 `.zshenv` 配置的原生 SSH agent socket，不把某次登录的 socket 路径写死。此路径依赖 Mac Studio 的登录环境、本地 Gateway、代理和 SSH 认证。`status` 只证实 launchd 注册；还须从腾讯云实际请求 Gateway health，并通过 `http://127.0.0.1:39032` 请求所需上游以核对代理出口。已有一次成功响应，尚未做重启/重新登录恢复验证。日志位于 Mac Studio `~/Library/Logs/aihot/gateway-tunnel.log` 和 `gateway-tunnel.err.log`。隧道脚本不管理本地 Gateway 服务本身。

## 公网切换与回滚

此节是待执行操作；当前未替换 Nginx。目标配置是 `/etc/nginx/sites-available/news.conf`，由 `/etc/nginx/sites-enabled/news.conf` 链接；HTTP 配置 `news-http.conf` 和现有证书保持。先完成生产模型使用及正式正文确认，并取得真实内容发布读数。

旧 Nginx 配置备份已建立，配置检查已通过，旧公网仍返回 200。在**腾讯云**从新发布目录运行；已有备份不覆盖：

```bash
set -e
if [ ! -e /home/ubuntu/aihot/shared/news.conf.before-aihot ]; then
  sudo cp -a /etc/nginx/sites-available/news.conf /home/ubuntu/aihot/shared/news.conf.before-aihot
fi
sudo install -m 0644 deploy/production/news.conf /etc/nginx/sites-available/news.conf
sudo nginx -t
sudo systemctl reload nginx
```

只有 `nginx -t` 成功才 reload。检查 `https://news.aiplanet.live/` 的实际新站内容、详情及公开出口；仅有 200 不能区分新旧站。记录切换时间和结果。配置检查或公网验证失败时，恢复旧配置：

```bash
set -e
sudo cp -a /home/ubuntu/aihot/shared/news.conf.before-aihot /etc/nginx/sites-available/news.conf
sudo nginx -t
sudo systemctl reload nginx
```

再核对公网确实回到旧站。此回滚只恢复公开路由，保留新库和所有回执，不自动回退数据库 schema 或恢复旧采集。旧上游文件 `/home/ubuntu/ai-radar/data/nginx/ai-radar-active-upstream.conf` 仍保留，准备阶段指向 8001；旧 8000/8001 Web 仍在，切站确认前不删除。若需回退新站代码，应先确认目标 release 与现有增量 schema 兼容，再从该 release 使用 `service.sh install`，而不是恢复旧数据库覆盖新产生的数据。

## 旧链路保留与恢复边界

Mac mini 于 `2026-10-01T15:38:51Z` 精确移除了含 `collector.sh`、`pipeline.sh`、`deploy/sync/sync-db-cron.sh`、`scripts/collect_aihot_supervised.sh` 的四条 cron，在途同步随后停止；备份位于该机 `~/.local/state/aihot-cutover/20261001T153851Z/`。腾讯云 `ai-radar-db-apply.service` 已 stop 并 disable。旧数据库与 Web 保留，Wechat2RSS 仍原机运行，迁移状态见[专页](wechat2rss.md)。

用户要求停旧采集，公网回滚不改变这一决定。若另行恢复旧链路，维护者须先核对备份与届时 crontab 的差异，只恢复获授权的任务，并单独决定是否启用旧库应用服务；不要用整份旧 crontab 覆盖后来新增的任务。

## 离线测试环境

不要加载生产 `app.env` 跑测试，也不要继承 `LLM_GATEWAY_*` 或供应商密钥。先准备名称以 `_test` 或 `_ci` 结尾的隔离空库并完成迁移，再在**腾讯云发布目录**运行（替换测试库连接）：

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ubuntu \
  DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/aihot_cutover_test' \
  NODE_ENV=test COLLECT_ENABLED=false FEISHU_CONTENT_PUSH_ENABLED=false \
  FEISHU_INTERNAL_ENABLED=false INDEXNOW_SUBMIT_ENABLED=false npm test
```

不额外设置 `MODEL_CALLS_ENABLED=false`：测试初始化会启用自身 mock。误继承生产配置的实际后果及处置见[切换记录](../references/20261001-production-cutover.md#2026-10-02-准备阶段补充)。
