# Wechat2RSS 接入与部署

部署定义由本仓 `deploy/wechat2rss/` 维护。公众号在 AIHOT 中按独立 `mp_account` 保存，`provider=wechat2rss` 使用原服务的逐账号 RSS，复用文章、去重、处理与公开读取层。私有许可证、RSS token、微信登录态与数据库不提交 Git。Mp2RSS 不在接入范围。

## 线上接入（2026-10-04）

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

TODO（本仓，负责人：AIHOT 维护者）：新增隧道的端到端外部故障通知尚未验收；原机 Wechat2RSS 探针不变。进程与来源健康记录可供主动排查，不能宣称无人值守告警已完成。

## 当前状态（2026-09-30）

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

服务搬迁仍需分别确认目标登录有效、22 个订阅保留、认证 RSS、作者/日期与重复采集。这项搬迁尚未完成，不影响使用原机服务的线上接入。

## 告警待办

本机 Compose 默认不继承旧实例的机器人投递地址；`WECHAT2RSS_BOT_WEBHOOK_URL` 明确配置后才启用原生投递。本仓本次迁移主线程负责在正式接管前迁移旧健康探针与告警身份、处置 Mac mini 旧探针，并验证登录失效或服务退出能被发现。此项尚未完成，当前不能把目标服务宣称为无人值守可用。不得为了健康检查测试向旧通知通道发消息。
