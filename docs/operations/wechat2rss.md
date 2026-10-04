# Wechat2RSS 接入与部署

部署定义由本仓 `deploy/wechat2rss/` 维护。公众号在 AIHOT 中按独立 `mp_account` 保存，`provider=wechat2rss` 使用原服务的逐账号 RSS，复用文章、去重、处理与公开读取层。私有许可证和固定密钥归 ai-agent-config 的加密 `env`，不提交到 AIHOT；动态登录态和数据库的持久边界见下文。Mp2RSS 不在接入范围。

## 两个仓库与新机器恢复

这里的“自包含”指 AIHOT 和 ai-agent-config 两仓提供部署所需代码、固定输入及操作说明，不要求把上游镜像源码放进本仓。私有仓访问与 ai-agent-config 的 git-crypt 解锁需已有授权；解锁材料沿用该仓已有分发方式，不能放入它自己加密的 `env`。新机器先按两仓 README 安装 Node.js 24、Python 3、Git/OpenSSH 和 AIHOT 的 PostgreSQL 等前置依赖，按 ai-agent-config 安装说明建立 `~/.claude/.env → <ai-agent-config>/env`。不要 `source ~/.claude/.env`。

| 权威位置 | 必须保存的内容 | 运行时副本 / 重建方式 |
| --- | --- | --- |
| AIHOT `deploy/wechat2rss/compose.yaml` | 固定镜像摘要、端口及采集保留配置 | `service.sh install` 安装 Ubuntu Docker/Compose，再按摘要下载启动 |
| AIHOT `industry/sources.json` | 公众号 bizId、feedId、名称、启用状态 | `restore-subscriptions.ts` 恢复上游缺失订阅；AIHOT seed 登记来源 |
| ai-agent-config `env`，经 `~/.claude/.env` 读取 | `WECHAT2RSS_LIC_EMAIL`、`WECHAT2RSS_LIC_CODE`、`WECHAT2RSS_RSS_TOKEN`、`WECHAT2RSS_RSS_SECRET`、`WECHAT2RSS_RSS_PROXY_SECRET` | `configure.ts` 生成 mode 0600 的 `service.env`、`compose.env` 和 AIHOT 配置片段 |
| 同一中央 env | `WECHAT2RSS_PROBE_SSH_TARGET`、`WECHAT2RSS_PROBE_SSH_PRIVATE_KEY_B64`、`WECHAT2RSS_PROBE_SSH_KNOWN_HOSTS_B64` | `probe-install.ts` 生成专用 SSH 身份、主机信任、执行脚本和 cron |
| ai-agent-config `im-notify/` 与中央 env | 通知程序及 `FEISHU_GENERAL_ALERT_WEBHOOK` | `bash im-notify/install.sh`；运行时直接读取中央 env |

生成器不依赖旧机器的 `.env`，只读取上述字段，不把整个中央 env 复制进服务。`RSS_SECRET` 不能随意重新生成，须与公开的 `RSS_ENC_FEED_ID=1` 一起保持，恢复脚本会核对 feedId。固定私有字段已纳入 ai-agent-config 的加密 `env`，本地提交为 `3667d810`；两仓均需同步到包含这些改动的版本，不能只 clone 尚未更新的远端。

在服务机器上，先准备 AIHOT 自己完整的 `app.env`，再运行：

```bash
node deploy/wechat2rss/configure.ts \
  --root /home/ubuntu/aihot/shared/wechat2rss \
  --app-env /home/ubuntu/aihot/shared/app.env
bash deploy/production/service.sh install
bash deploy/wechat2rss/service.sh status
```

这会只更新 `app.env` 的两个微信字段，保留其他模型、预算、数据库和安全阀配置；不会重建 `data/res.db`。迁移时仍须先停旧授权实例，不能同时启动同一许可证的副本。全新数据库可能需要按[上游激活说明](https://wechat2rss.xlab.app/deploy/active)完成许可验证、按[上游登录说明](https://wechat2rss.xlab.app/deploy/guide)扫码；动态登录会过期，不能把一份旧登录缓存当作永久凭据。管理端口只对回环开放，使用部署管理员已有的 SSH 端口转发访问，不使用下述只读探针 key。

登录可用后，先核对再恢复缺项：

```bash
node deploy/wechat2rss/restore-subscriptions.ts
node deploy/wechat2rss/restore-subscriptions.ts --apply
```

脚本完整读取 `/list` 分页，只对缺失的启用账号调用 `/add/:bizId`；已有暂停状态不改、已有账号不重复触发刷新。官方 API 对已经存在的账号调用 `/add` 仍会触发抓取，故不能把它当作每次启动的无副作用检查。feedId 不符会报错，不擅自改写清单或现有 AIHOT 数据库。最后检查正常 worker 的 `fetch_runs` 及公开内容，而非只看订阅数量。

**历史边界：**用户已明确中央 env 只维护环境变量、凭据等元数据，历史正文由数据库维护。Wechat2RSS 历史保存在 `data/res.db`，AIHOT 已入库的业务历史保存在 PostgreSQL，这些数据库不塞入 env。上游不保证重新抓到全部历史，因此空库重建订阅只恢复后续采集，不等价于迁移历史。现役数据库本次保持完整。

需要迁移现有 Wechat2RSS 历史时，从管理员机器取得快照（腾讯已具备 `/usr/bin/python3` 3.12）：

```bash
python3 deploy/wechat2rss/snapshot.py tencent-webserver-china \
  /home/ubuntu/aihot/shared/wechat2rss /absolute/private/new-snapshot \
  --remote-python /usr/bin/python3 --env-name service.env
```

切换时先停旧实例再取得最终快照，把 `res.db` 恢复到新实例的 `data/res.db`（目录 0700、文件 0600），再从中央 env 生成服务配置并启动。快照的 `.env` 是私有恢复副本，配置权威仍是中央 env。AIHOT PostgreSQL 的既有数据须另外用 `pg_dump`/`pg_restore` 或对应数据库备份迁移；此脚本只迁 Wechat2RSS SQLite，不迁 AIHOT 的 PostgreSQL。

外部观察机也 clone 两仓并解锁中央 env。先从 ai-agent-config 安装 im-notify，再从长期保留的 AIHOT checkout 生成探针文件：

```bash
bash /path/to/ai-agent-config/im-notify/install.sh
node deploy/wechat2rss/probe-install.ts
```

将生成的 `~/.local/share/aihot/wechat2rss/probe-key.pub` 传到服务机器，使用部署管理员身份在那里执行（只需公钥，不传中央 env 或探针私钥）：

```bash
node deploy/wechat2rss/probe-install.ts --authorize-key /path/to/probe-key.pub \
  --server-root /home/ubuntu/aihot
```

该 key 只允许强制执行 `login-status.ts`，`restrict` 禁止端口/agent/X11 转发、PTY 和 user-rc。观察机固定用中央 env 内的 `user@hostname`、专用 key 和已核实的 known_hosts，禁用通用 SSH config 与 agent；目标变更时先更新中央 target 和主机信任，不能自动接受未知主机 key。SSH 是探针传输，不是部署管理员凭据，二者不得互换。

在观察机用真实 SSH、隔离通知工具验证，再安装原频率 cron：

```bash
IM_NOTIFY_BIN=/usr/bin/true bash ~/.local/share/aihot/wechat2rss/probe.sh
node deploy/wechat2rss/probe-install.ts --install
```

安装器仅替换本探针的带标记 cron 或文档中的旧健康检查行，保留其他 cron。同目录重装保留 `healthcheck.state`；改变 `--root` 时需同时迁移已有状态文件，安装器不自动寻找旧路径。故障分支测试必须使用实体通知替身，不能只 mock Bash 函数；安装器不发送测试消息。动态健康状态与 im-notify 去重账本可重新建立，不作为固定配置入仓。决定和验证边界见[双仓恢复记录](../references/20261004-wechat-portable.md)。

## 腾讯同机部署与统一入口

X ingest 由腾讯云 `aihot-worker` 调用 SocialData；Wechat2RSS 作为它的本地上游容器，同机部署于腾讯，AIHOT worker 仍负责公众号入库和处理。自有适配代码在 `packages/backend/src/sources/wechat2rss.ts`，部署资产在 `deploy/wechat2rss/`；上游服务本体由固定摘要的 Docker 镜像提供。2026-10-04 已切换中央配置生成的服务环境及外部专用探针。

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

容器仅监听 `127.0.0.1:18480`，AIHOT `app.env` 中 `WECHAT2RSS_BASE_URL=http://127.0.0.1:18480`，`WECHAT2RSS_RSS_TOKEN` 与私有服务配置一致。`status` 分开报告容器和微信登录，不能代替来源 `fetch_runs`、模型回执和公开结果。许可证来自中央 env；初次部署必要时仍由账号所有者扫码或处理激活，已有登录缓存不保证跨机器有效。

外部探针代码为 `deploy/wechat2rss/healthcheck.sh` 与 `login-status.ts`。Mac mini 继续以原 11/31/51 分频率从 SSH 检查腾讯本机健康 API，保留原 im-notify 去重 key 与 `healthcheck.state`；入口为 `~/.local/share/aihot/wechat2rss/probe.sh`，代码运行副本在同目录 `source/deploy/wechat2rss/`，最小私有输入副本为 `probe-input.env`，均从两仓生成/复制。公众号服务和 AIHOT 启动不依赖 Mac mini，外部通知仍依赖该观察机。探针的 SSH 失败仅表示健康未核实。测试通过 `IM_NOTIFY_BIN` 指向实体替身，不向真实通知通道发消息。

Mac mini 的 cron 如下。新探针使用固定专用 key 和 known_hosts，禁用 SSH config/agent，不再依赖 `.zshenv`；已从 `env -i` 空环境验证真实健康命令。提交任意另一条 SSH 命令也只返回强制健康结果。

```cron
11,31,51 * * * * /bin/bash '/Users/lindong/.local/share/aihot/wechat2rss/probe.sh' >/dev/null 2>&1 # aihot-wechat2rss-probe
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
