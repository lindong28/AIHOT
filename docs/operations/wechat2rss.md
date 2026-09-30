# Wechat2RSS 本机迁移与部署

部署定义由本仓 `deploy/wechat2rss/` 维护，使用现有 Wechat2RSS 镜像和 AIHOT 原生 RSS 采集器。私有许可证、RSS token、微信登录态与数据库保存在 `.data/wechat2rss/`，不提交 Git。Mp2RSS 不在接入范围。

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

## 接入 AIHOT

先确认目标服务的认证 RSS 返回真实条目，再登记来源。该命令只更新其自有 `radar-wechat2rss` 配置，不覆盖已有启停状态、游标或其它来源；带 token 的 URL 只写后端数据库，不进入版本控制：

```bash
node --env-file=.env deploy/wechat2rss/register-source.ts /absolute/path/to/AIHOT/.data/wechat2rss/service.env
```

本机进程访问回环 RSS 需要既有开发开关 `ALLOW_PRIVATE_NETWORK_FETCH=true`。它允许采集器访问私网，不是单源白名单；只在确认的本机部署启用。生产模式拒绝这个开关，未来生产拓扑必须另行确定，不能把本机配置直接上线。Docker 内的 `127.0.0.1` 也不是宿主机，本配置目前只面向宿主机运行的 AIHOT 后端。

验收需分别确认：目标登录仍有效、22 个订阅保留、RSS 含文章和原文链接、AIHOT 原生采集入库保留作者/日期、重复抓取不产生重复文章。进程运行和 HTTP 200 均不能替代这些条件。聚合 feed 沿用旧服务的 50 条输出上限，来源身份为一个聚合 RSS，尚未改成每公众号独立来源。

## 告警待办

本机 Compose 默认不继承旧实例的机器人投递地址；`WECHAT2RSS_BOT_WEBHOOK_URL` 明确配置后才启用原生投递。本仓本次迁移主线程负责在正式接管前迁移旧健康探针与告警身份、处置 Mac mini 旧探针，并验证登录失效或服务退出能被发现。此项尚未完成，当前不能把目标服务宣称为无人值守可用。不得为了健康检查测试向旧通知通道发消息。
