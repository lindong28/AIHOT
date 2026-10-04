# Wechat2RSS 接入与部署

部署定义由本仓 `deploy/wechat2rss/` 维护。公众号在 AIHOT 中按独立 `mp_account` 保存，`provider=wechat2rss` 使用原服务的逐账号 RSS，复用文章、去重、处理与公开读取层。私有许可证、RSS token、微信登录态与数据库不提交 Git。Mp2RSS 不在接入范围。

## 腾讯同机部署与统一入口

X ingest 由腾讯云 `aihot-worker` 调用 SocialData；Wechat2RSS 作为它的本地上游容器，同机部署于腾讯，AIHOT worker 仍负责公众号入库和处理。自有适配代码在 `packages/backend/src/sources/wechat2rss.ts`，部署资产在 `deploy/wechat2rss/`；上游服务本体由固定摘要的 Docker 镜像提供，许可证、登录态及数据库不入 Git。

腾讯私有运行目录为 `/home/ubuntu/aihot/shared/wechat2rss/`：`service.env` 保存许可证与 RSS token，`data/res.db` 保存订阅、历史和登录，`compose.env` 只写 `WECHAT2RSS_ENV_FILE`、`WECHAT2RSS_DATA_DIR` 的绝对路径及可选机器人配置。目录 0700、私有文件 0600。首次迁移时必须先停旧实例并取得最终快照，再把 `compose.env` 放到此正式路径；准备阶段只安装引擎、下载镜像，不启动持有同一许可证的副本。

入口与 X 采集相同，从腾讯运行：

```bash
bash /home/ubuntu/aihot/current/deploy/production/service.sh install
bash /home/ubuntu/aihot/current/deploy/production/service.sh start
bash /home/ubuntu/aihot/current/deploy/production/service.sh restart
bash /home/ubuntu/aihot/current/deploy/production/service.sh status
bash /home/ubuntu/aihot/current/deploy/production/service.sh stop
```

`install` 在 Ubuntu 缺少引擎时安装 `docker.io` 与 `docker-compose-v2`；`install/start/restart` 在启动 worker 前通过 Compose 拉起公众号容器，`restart` 重建容器以加载私有环境变更。`stop` 先停 AIHOT 再停公众号容器，`uninstall` 删除本项目容器但保留绑定数据及配置。没有 `compose.env` 时明确报告未配置本机实例，不启动容器；可用 `WECHAT2RSS_COMPOSE_ENV` 显式指定另一配置文件。这里只做原生 Compose 分派，不维护另一个容器状态机。Docker `unless-stopped` 提供宿主机重启后的容器恢复，手动 stop 后须再 start。

容器仅监听 `127.0.0.1:18480`，AIHOT `app.env` 中 `WECHAT2RSS_BASE_URL=http://127.0.0.1:18480`，`WECHAT2RSS_RSS_TOKEN` 与私有服务配置一致。`status` 分开报告容器和微信登录，不能代替来源 `fetch_runs`、模型回执和公开结果。初次部署仍需现有私有许可证/数据，必要时由账号所有者扫码或处理激活；仓库不包含可自动代替这些授权的凭据。

外部探针代码为 `deploy/wechat2rss/healthcheck.sh` 与 `login-status.ts`。Mac mini 继续以原 11/31/51 分频率从 SSH 检查腾讯本机健康 API，保留原 im-notify 去重 key 与 `healthcheck.state`；运行副本为 `~/.local/share/aihot/wechat2rss/healthcheck.sh`。公众号服务和 AIHOT 启动不依赖 Mac mini，外部通知仍依赖该观察机。探针的 SSH 失败仅表示健康未核实。测试通过 `IM_NOTIFY_BIN` 指向实体替身，不向真实通知通道发消息。

Mac mini 的 cron 如下。`zsh -c` 用于加载该机已有 `.zshenv` 中的 SSH 环境；直接从空环境执行 ssh 实测无法认证，不应把交互 shell 成功当作 cron 成功。其他机器须核实自己的非交互 SSH 环境。

```cron
11,31,51 * * * * WECHAT2RSS_SSH_HOST=tencent-webserver-china WECHAT2RSS_STATE_FILE=/Users/lindong/.local/share/aihot/wechat2rss/healthcheck.state /bin/zsh -c '/bin/bash /Users/lindong/.local/share/aihot/wechat2rss/healthcheck.sh' >/dev/null 2>&1
```

决定与切换验收见[同机部署记录](../references/20261004-wechat-colocate.md)。下面保留最初接入和旧 Studio 迁移的历史，不作为当前部署入口。

## 首次隧道接入记录（2026-10-04）

本次接入复用 Mac mini 现役 `127.0.0.1:8080`，不搬迁容器或登录。22 个账号清单在 `industry/sources.json`，以 `bizId` 建立稳定来源身份、以 `feedId` 寻址，不再登记一个聚合 RSS 来源。决策与验证记录见[公众号接入记录](../references/20261004-wechat-sources.md)。下方 2026-09-30 是原服务迁移记录，不能当作线上接入状态。

在 **Mac mini** 将本仓的 `deploy/wechat2rss/tunnel.py` 安装到持久目录后，通过 Python 运行 `install`、`start`、`stop`、`status`、`uninstall`。该脚本只管理 `live.aiplanet.aihot-wechat2rss-tunnel`，将腾讯云回环 39033 转发到本机 8080；不管理 Wechat2RSS 容器。`install` 更新并重载 launchd；`stop` 保留定义，`uninstall` 删除定义。日志为 `~/Library/Logs/aihot/wechat2rss-tunnel{,.err}.log`。沿用当前登录会话的 SSH agent，不宣称无人登录重启恢复已验收。

腾讯云后端私有 `app.env` 配置：

```dotenv
WECHAT2RSS_BASE_URL=http://127.0.0.1:39033
WECHAT2RSS_RSS_TOKEN=<原实例 RSS_TOKEN>
```

token 仅经私有文件传输，不打印认证 URL、原始访问日志或上游错误正文。此 provider 只允许部署指定的 HTTP IPv4 回环 origin，不跟随重定向；没有打开生产 `ALLOW_PRIVATE_NETWORK_FETCH`。

从新 release 运行 `node --env-file=/home/ubuntu/aihot/shared/app.env deploy/wechat2rss/register-source.ts` 可单独补登记；正常 release 的 seed 也导入同一清单。两者均保留已有来源配置、暂停状态和游标。变更凭据后重启 worker/API 才使用新环境。账号经现有 `sources.mp` 队列按 15 分钟检查，正文用于模型处理，公开全文开关仍关闭。

首轮每账号最多 8 篇，首轮时间减 7 天是固定接收下界，后续可补齐这个窗口内的剩余条目；不会按最新发布时间推进过滤下界而丢掉延迟收录文章。复用统一历史语义与预算：旧文按来源时间归档，超过 48 小时的历史不增加当前热度。上游每账号 RSS 最多保留 50 条，长时间中断超出此窗口的缺口需维护者另行核查，不自动启动全历史回填。

验收分开核对：认证逐账号 RSS、来源 `fetch_runs`、文章的正文/日期/来源与重复 identity、处理状态/回执、公开 API 或文章页。`status` 或 HTTP 200 不替代这些层。回退时暂停本批 `radar-mp-*`、停止专用隧道并按生产运维切回旧 release；保留文章、回执与原服务数据。

当时未验收隧道端到端外部故障通知；同日同机迁移后隧道已卸载，该待办随对象退役关闭。公众号健康探针已按上方新拓扑迁移，其他生产服务的告警待办不由此关闭。

## 历史状态（2026-09-30，已由腾讯同机部署替代）

Mac mini 的旧实例仍运行。已通过 SQLite backup API 复制一致性快照至本机 `.data/wechat2rss/snapshot-20260930/`：22 个订阅、2,107 篇文章、1 份登录记录、1 份许可证记录，完整性检查为 `ok`。这只是快照，不证明登录态在新机器有效，也不包含复制之后的更新。

Mac Studio 已安装 OrbStack 2.1.1；CLI 启动返回 `start VM: timed out waiting for VM to start`，状态仍为 `Stopped`。打开应用后亦未取得 Docker socket。目标容器尚未启动，微信 RSS 尚未在 AIHOT 入库。执行归属：本次迁移主线程继续处理容器引擎，需系统权限或人工确认时交使用者；停止旧实例及现役 RADAR 消费端安排待使用者确认。

## 迁移

先启动并核实容器引擎；Mac 上已安装 OrbStack 时可用 `/Applications/OrbStack.app/Contents/MacOS/bin/orbctl start`，Docker CLI 位于同目录的 `../xbin/docker`。使用原生 Docker Compose 运维，不另建容器生命周期包装层。

快照命令只读源端、在目标写新目录，要求远端 `/opt/homebrew/bin/python3` 为 Python 3.11+，本地使用 Python 3。源端 WAL 的已提交内容通过 SQLite backup API 合入快照，不直接复制运行中的数据库单文件：

```bash
python3 deploy/wechat2rss/snapshot.py macmini /Users/lindong/research/ai-radar/deploy/wechat2rss /absolute/path/to/AIHOT/.data/wechat2rss/new-snapshot
```

实际切换时先确认现役 RADAR 微信采集的衔接安排，再停旧 Wechat2RSS、取得最终快照。保留旧数据。新旧实例不要同时主动抓取同一个登录账号；官方迁移流程也是停旧后迁移，不承诺跨机器免扫码或许可证免验证。

将最终快照的 `res.db` 放到 `.data/wechat2rss/data/res.db`，私有 `.env` 放到 `.data/wechat2rss/service.env`；目录权限 `700`、私有文件 `600`。复制仓库 `deploy/wechat2rss/.env.example` 为 `.data/wechat2rss/compose.env`，填写这两个位置的绝对路径。运行资产放在长期保留的主 checkout，不跟随临时 worktree 删除。

## 启停与更新

以下命令从仓库根执行。OrbStack 尚未安装 CLI 插件入口时，完整路径的 `docker compose` 也可能不可用；此时将下列 `docker compose` 替换为 `/Applications/OrbStack.app/Contents/MacOS/xbin/docker-compose`，本机已用它验证配置。Compose 变量文件只填路径与可选通知目的地；不要把配置展开结果或容器原始日志贴到对话，可能包含凭据。

```bash
docker compose --env-file .data/wechat2rss/compose.env -f deploy/wechat2rss/compose.yaml config --quiet
docker compose --env-file .data/wechat2rss/compose.env -f deploy/wechat2rss/compose.yaml up -d
docker compose --env-file .data/wechat2rss/compose.env -f deploy/wechat2rss/compose.yaml ps
docker compose --env-file .data/wechat2rss/compose.env -f deploy/wechat2rss/compose.yaml stop
```

更新仓库配置后重新执行 `up -d`，由 Compose 收敛到固定镜像及配置；`down` 移除容器但保留绑定目录中的数据。服务监听本机 `127.0.0.1:18480`，管理界面不对外公开。容器使用 `unless-stopped`；Mac 开机后的引擎启动仍由 OrbStack 管理，尚未在目标机完成重启验收。

## 原本机迁移接入（已由逐账号登记替代）

原先聚合源 `radar-wechat2rss` 的登记已停用。迁移目标若以后接管服务，同样使用上面的逐账号 `mp_account` 入口；先验证登录和订阅完整性，再修改部署 origin。不要重新登记聚合源。

```bash
node --env-file=.env deploy/wechat2rss/register-source.ts
```

新 provider 无需 `ALLOW_PRIVATE_NETWORK_FETCH=true`。Docker 内的 `127.0.0.1` 不是宿主机，目前此可信入口针对宿主机进程与回环隧道。

该本机迁移路径当时尚未完成；2026-10-04 用户指定腾讯同机部署后的实际结果见顶部入口与同机部署记录。

## 原本机迁移的告警安排

Compose 默认不继承旧实例的机器人投递地址；`WECHAT2RSS_BOT_WEBHOOK_URL` 明确配置后才启用原生投递。腾讯迁移保留既有外部 im-notify 通道，探针代码、状态与 cron 已迁移，故障分支使用隔离通知替身验证，不主动制造生产故障。此轮不宣称宿主机重启恢复或所有告警设计债务已验收。
