# 腾讯云生产运维

面向部署维护者，说明新 AI Radar 的发布、起停、检查与公网回滚。公网已于 `2026-10-02T02:25:07Z` 切到新站；腾讯云 API、Web、worker 均 active，worker 已 enabled，生产 `app.env` 的 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 均为 `true`。条款与隐私正文已由用户确认并应用，用户已明确要求继续使用 Qwen Token Plan 生产调用；该决定不改变供应商条款。切站与授权记录见[生产切换记录](../references/20261001-production-cutover.md)。

实时与历史两条模型链均经个人 Gateway，历史启动批已导入并开始处理。实时模型配置见 [app.env.example](../../deploy/production/app.env.example)：预筛与结构抽取使用 `default`，由 `LLM_MODEL` 指向逻辑名 `qwen3.8-flash`，并以 `LLM_EXTRA_JSON={"enable_thinking":false}` 关闭 thinking。个人 Gateway 优先使用公司集群上已就绪的自托管 Qwen，再回退百炼订阅与按量 API，并负责等值转换自托管参数拼法；其余具名模型沿用各自配置。模板中的采集与模型安全阀仍为 `false`，不要把模板默认值当作生产运行值。回填另见[历史回填](backfill.md)：Qwen 允许 self-hosted 与明确批准的个人百炼订阅备用，排除 DashScope 按量；评分、理解与摘要统一使用 DeepSeek V4.1 Flash，唯一候选为 `company_tencent_vod`。请求按允许路由集合与 registry revision 限定。

2026-10-03 已部署 Gateway `ed36698` 和 AIHOT `da3cf98`（release `bailian-fallback-da3cf98`）。当前历史 run `693bfde2-aa5a-499f-b17e-fd674ed7ea4c` 已在 paused 与批次锁下启用百炼备用，主绑定与历史回执身份保留，随后恢复 timer。两次真实小请求均完成：百炼回执 `45956` / Gateway UUID `64e3d7ff-83ea-46c3-a033-e79b5ca9264f`；正常双候选仍选 self-hosted，回执 `45957` / UUID `20569b0e-69f8-4887-93ef-c1df98938078`。二者均与 Gateway 的单次 success attempt 对应，usage 已返回，账本 cost_state 仍为 unknown，不表示免费。本次未人为制造生产故障；502 后冷却与同请求 fallback 的证据来自本地 HTTP fixture。生产 smoke 与公网健康检查正常，旧 unknown 未批量释放或重放。

2026-10-04 首次公众号接入后，release `wechat-colocate-20261004` 已将 Wechat2RSS 迁到腾讯，与调用 SocialData 的 worker 同机。后端私有 `WECHAT2RSS_BASE_URL` 改为 `http://127.0.0.1:18480`，token 保持，22 个来源继续由 worker 的 mp 队列采集。`deploy/production/service.sh` 统一管理 API/Web/worker 和已配置的 Wechat2RSS 容器；Mac mini 旧容器与隧道已停，仅保留外部健康探针。私有目录、起停、验证与迁移边界见[公众号运维](wechat2rss.md)及[同机部署记录](../references/20261004-wechat-colocate.md)。

2026-10-07 主题大事记已发布，`current` 指向 `topic-chronicle-20261007-56e1bbb`，API/Web 运行功能提交 `56e1bbb`。本次只重启 API/Web，worker 与在途回填未重启；无新增迁移、seed 或模型配置变更。公网视频、OpenAI、模型发布三个主题 API 已返回大事记，页面交互与站点 smoke 已检查。旧 release `source-gaps-20261006` 保留供代码回切，部署身份、验证范围和选材局限见[发布记录](../references/20261007-topic-chronicle.md#生产发布记录2026-10-07)。

## 环境与持久数据

生产模板使用 `LLM_GATEWAY_ATTEMPT_TIMEOUT_MS=60000`，在线 worker 与 backfill 的 Gateway 客户端实例均读取它；共享 SDK 缺省仍为 30000。次数预算仍默认 3 次（含首次），backoff 仍为 3 秒、6 秒，每次请求派发后独立计算最多 60 秒，backoff 与路由冷却不扣该时间。修改 `app.env` 后需让 worker 和 backfill 在途任务结算退出，再启动新进程；以新回执的 `request.gateway.retry.attemptTimeoutMs` 和 Gateway attempt 关联核对实际值。更长超时不保证每条新闻成功，也不自动清除历史 unknown 回执。

DeepSeek 具名预设与部署模板已改为 `deepseek-v4.1-flash`。摘要、归组、归组复核、综述、报告、翻译与监控选择非思考 V4.1；backfill 评分使用 `-selection`、理解使用 `-low`，明确保留上游 GLM 各角色参数，三种回填 DeepSeek 角色固定腾讯 VOD。完整参数见 [模型配置](../references/model-configuration.md)，执行见[回填接入](backfill.md)。迁移部署时同时检查 `app.env`、数据库 `models.*` 设置和已有回填批次的模型绑定；历史回执保持原名，不批量重写。直连官方 API 的 `default` 示例仍使用厂商原生 `deepseek-flash`，它与 Gateway logical 名分属不同入口。具名预设直连配置使用 `DEEPSEEK_V41_BASE_URL` / `DEEPSEEK_V41_API_KEY`，端点须识别 `deepseek-v4.1-flash`，不复用旧 V4 自托管地址。

V4.1 的仓库配置与校验代码不自动迁移生产 `app.env`、数据库模型设置、运行进程或既有回填绑定。Gateway 项目需显式登记 personal/company 双归属，腾讯账户保持 company_paid；应用预检核对双归属和唯一腾讯路由。启动回填前必须以运行中的 Gateway 完成预检与真实模型验证，不能把源文件已修改视为生产已加载。

| 位置 | 用途 |
| --- | --- |
| 腾讯云 `/home/ubuntu/aihot/releases/` | 各次发布源码；2026-10-02 回执修复与回填状态修复合并运行于 `backfill-content-filter-20261002-r2`，当前版本以 `readlink /home/ubuntu/aihot/current` 为准，旧 release 保留 |
| 腾讯云 `/home/ubuntu/aihot/current` | 指向运行版本的符号链接，systemd 从这里启动 |
| 腾讯云 `/home/ubuntu/aihot/shared/app.env`、`web.env` | 后端与 Web 运行配置；后端凭据文件权限为 0600，不入 Git、不打印内容 |
| 腾讯云 `/home/ubuntu/aihot/shared/data` | 应用持久文件；PostgreSQL 数据由系统数据库服务独立管理 |
| 腾讯云 `127.0.0.1:3001`、`:3000` | 新 API、Web；公网 Nginx 已代理到 Web |
| 腾讯云 `127.0.0.1:39031`、`:39032` | 专用隧道提供的个人 Gateway 与 HTTP 代理 |

腾讯云已安装 Node.js 24.21.0、PostgreSQL 16.15，完成依赖、Web 构建、数据库迁移及来源 seed。代码包不包含 `.env`、`.data/` 或共享目录；更新源码不覆盖这些持久状态。Web 配置模板见 [web.env.example](../../deploy/production/web.env.example)。

## 部署更新与起停

统一入口为 `deploy/production/{install,start,stop,status,uninstall}.sh`；隧道对应入口为 `deploy/production/tunnel/` 下同名脚本。下文的动作分派命令仍可直接使用，两组入口复用同一实现。

以下命令在**腾讯云**执行。将本仓已审核源码放入新 release 目录后，从该目录运行：

```bash
bash deploy/production/prepare-release.sh
```

它安装锁定依赖、构建 Web、应用增量迁移并 seed；不会更新 `current`、启动服务或切换公网。seed 不覆盖已有来源配置。数据库迁移不是随代码回滚而自动撤销的操作。

发布准备完成后，部署更新使用：

```bash
bash deploy/production/service.sh install
bash deploy/production/service.sh status
```

`install` 会再次准备发布、更新 `current`、安装 systemd 定义，并 enable/restart API、Web、worker **全部三个服务**；`start` 和 `restart` 也作用于全部三个。它们不是“只更新前台”的命令。生产 worker 当前 enabled 且运行，主机重启时可被拉起；仅安装或启动成功不代表处理链路健康，还须检查新任务、回执和公开内容更新。开发、离线测试或尚未获准启用的新环境继续保持采集与模型安全阀关闭。

日常操作入口：

```bash
bash /home/ubuntu/aihot/current/deploy/production/service.sh start
bash /home/ubuntu/aihot/current/deploy/production/service.sh stop
bash /home/ubuntu/aihot/current/deploy/production/service.sh restart
bash /home/ubuntu/aihot/current/deploy/production/service.sh status
```

按需运行其中一条。`stop` 保留安装及开机启用状态；`uninstall` 停止并注销三个 systemd 服务，保留发布目录、凭据和 PostgreSQL 数据。修改 `app.env` 或 `web.env` 后，相应进程需重启才读取新值；源码更新走新 release 的 `install`，不能只拉代码而不构建和重启。

## 状态与故障定位

### Gateway 未知回执核对

`unknown` 表示结果或派发状态未确认，不表示已扣费。Gateway 精确 `422` 且无 attempt companion 的 `route_cooldown` / `no_route` 拒绝不再误入 unknown；后续调用通过原有任务退避和预算重试。新版 AIHOT 默认启用 recovery v1，在配套 Gateway、SDK、迁移和 worker 生效后，有有效恢复指令的暂态 HTTP／网络错误可按原 UUID 和持久化上限自动恢复；本说明不表示生产已完成该升级。协议停止、次数耗尽或缺少恢复依据时仍须核对，HTTP 502、断流、缺失账本或不可用响应都不能据此写成“未计费”。旧协议暂态积压可经授权使用 `--transient-only` 筛选冻结，升级顺序、命令与边界见[回执恢复](receipt-recovery.md)。`no_route` 只说明本次没有派发，不表示模型已经恢复，仍须检查 Gateway 的部署状态。

积压核对工具默认预览，仅对个人 Gateway 实账本证实零 attempt 的本地拒绝放行。以权限 0600 保存中间 JSON；stdout 供脚本、stderr 提供完整摘要。先在生产 release 目录导出身份（不含凭据和正文）：

```bash
umask 077
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/reconcile-gateway-receipts.ts --snapshot > /home/ubuntu/aihot/shared/receipt-snapshot.json
```

将 snapshot 复制到个人 Gateway 主机后，在本仓执行：

```bash
python3 scripts/export-gateway-receipts.py --snapshot .data/receipt-snapshot.json --ledger ~/.local/state/llm-gateway/audit.sqlite3 > .data/receipt-evidence.json
```

把 evidence 复制回生产共享目录，15 分钟内预览并应用（超时重新导出，不手改时间）：

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/reconcile-gateway-receipts.ts --evidence /home/ubuntu/aihot/shared/receipt-evidence.json
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/reconcile-gateway-receipts.ts --evidence /home/ubuntu/aihot/shared/receipt-evidence.json --apply
```

这是具数据库权限的维护工具，输入必须来自可信个人 Gateway 账本，不能接受外部上传的证据。仅适用于 AIHOT 独占生成、没有被人工或其他调用方在 Gateway 重发的 UUID；Gateway 的本地拒绝状态本身不是永久终态。项目、模型、UUID、最新应用 attempt 和完整 Gateway attempt 集合均校验，重复应用已恢复的回执无效。费用和以前的 attempt 不会被清空或改成零。

分析任务只恢复同版本的 failed 文章，保留管理员运行标识和各阶段复用；分组、综述分别排入自己的队列，监控识别等待原有 tick。受管 backfill、已处理文章、新版本文章和未支持用途不会被强塞进实时分析队列，输出 `recovery` 说明原因。释放数不等于新排队数，更不等于已发布数：应用后还要检查文章状态、队列及公开页面。其余未知回执仍保留在后台，需供应商账单或可用结果证据后再处理；不要批量点击“未计费”。

腾讯云检查：

```bash
bash /home/ubuntu/aihot/current/deploy/production/service.sh status
systemctl --no-pager status postgresql
curl --fail --max-time 15 http://127.0.0.1:39031/health
curl --fail --max-time 15 http://127.0.0.1:3000/api/health
cd /home/ubuntu/aihot/current
node scripts/smoke.ts --base http://127.0.0.1:3000
node scripts/smoke.ts --base https://news.aiplanet.live
```

`status` 显示 systemd 状态，任一服务 inactive 会使其返回非零，应逐个查看 unit。Gateway health 不证明模型授权或上游可用，Web/内部 smoke 不证明公网路由或内容更新。2026-10-02 切站后的公网 smoke 覆盖 19 个页面、14 个机器出口和 1 次 MCP 握手，均通过，模型榜无跳过项。日后模型榜无发布轮次时，脚本会跳过三个相关入口的 503，不能把这种结果记为榜单可用。

切站时已从公网首页和文章详情读到中文标题、摘要与推荐理由；Gateway 账本取得 Qwen、GLM、DeepSeek 与 embedding 成功调用。短窗口采集与发布证据见[生产切换记录](../references/20261001-production-cutover.md)，不代表长期稳定性验收。SocialData 保留每分钟 10、每小时 100、每日 1,000 的请求预算，按实际滚动窗口释放时间恢复；采集断点、并发保护与费用口径见[增量采集记录](../references/20261002-socialdata-recovery.md)。排查更新停滞时同时核对来源健康、预算、任务及公开内容，不只看进程。

在腾讯云 release 目录执行只读诊断：

```bash
sudo -n -u postgres psql -X -d aihot -v ON_ERROR_STOP=1 -P pager=off < scripts/socialdata-status.sql
```

输出最近一小时请求、重复返回、空页和估计金额，以及待初始化来源、未完成区间和监控积压。`estimated_usd` 是本地估计，不是供应商账单；新空页按每次 0–0.0002 USD 的上界计入，旧空页记录保留旧估计。`attempts_without_cost` 非零表示金额不完整。分片游标在多个来源中保存，分别展示来源条目数与去重后的断点数；缺少恢复边界的区间需要维护者检查。

服务日志在 journald，可用 `journalctl -u aihot-worker.service -n 100 --no-pager`，API/Web 换相应 unit；向外提供日志前先去除凭据和私有 URL。后台“运行”页查看任务与未知回执；新协议只按持久化身份与额度恢复，进程重启不重置额度；不符合自动恢复条件的未知模型结果仍先核对 Gateway 账本或取得业务重放授权，见[回执恢复](receipt-recovery.md)。

所有者明确接受可能再次计费后，可以用[统一回执恢复脚本](receipt-recovery.md)冻结旧异常并受控重放，业务成功后自动结案。它保留原费用未知状态，不能替代供应商核账；同一批次续跑不会自动放行后来新产生的失败。

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

公网已切到新站。当前配置是 `/etc/nginx/sites-available/news.conf`，由 `/etc/nginx/sites-enabled/news.conf` 链接；HTTP 配置 `news-http.conf` 和现有证书保持。切换时 `nginx -t` 成功后执行 reload，并从公网健康接口、首页、详情和 smoke 核对了新站。

旧 Nginx 配置备份已建立。以下保留应用本仓 Nginx 配置的操作入口；在**腾讯云**从新发布目录运行，已有备份不覆盖：

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

再核对公网确实回到旧站。此回滚只恢复公开路由，保留新库和所有回执，不自动回退数据库 schema 或恢复旧采集。旧上游文件 `/home/ubuntu/ai-radar/data/nginx/ai-radar-active-upstream.conf` 仍保留，切站前指向 8001；旧 8000/8001 Web 与数据库保留供回滚，本次未删除。若需回退新站代码，应先确认目标 release 与现有增量 schema 兼容，再从该 release 使用 `service.sh install`，而不是恢复旧数据库覆盖新产生的数据。

## 旧链路保留与恢复边界

Mac mini 于 `2026-10-01T15:38:51Z` 精确移除了含 `collector.sh`、`pipeline.sh`、`deploy/sync/sync-db-cron.sh`、`scripts/collect_aihot_supervised.sh` 的四条 cron，在途同步随后停止；备份位于该机 `~/.local/state/aihot-cutover/20261001T153851Z/`。腾讯云 `ai-radar-db-apply.service` 已 stop 并 disable。旧数据库与 Web 保留；Wechat2RSS 于 10 月 4 日迁到腾讯，旧实例保持停止，见[专页](wechat2rss.md)。

用户要求停旧采集，公网回滚不改变这一决定。若另行恢复旧链路，维护者须先核对备份与届时 crontab 的差异，只恢复获授权的任务，并单独决定是否启用旧库应用服务；不要用整份旧 crontab 覆盖后来新增的任务。

## 2026-10-07 暂态恢复发布

2026-10-07 暂态恢复版本已发布到 `/home/ubuntu/aihot/releases/transient-recovery-20261007-971dee99`，个人 Gateway 已配套升级，迁移 0047 已应用；API、Web、worker 与回填定时器恢复运行，公网 smoke 及实时／回填实际模型请求取得成功读数。模型和 provider 配置保持原样，历史回执按固定授权批次恢复；版本、测试和费用边界见[本次记录](../references/20261007-transient-recovery.md#部署与验证记录)。

## 2026-10-10 仅前台样式发布

GitHub 风格以仅前台方式发布，当前 `current` 为同日第二轮的仅前台发布（目录名 `github-audit-20261010-<提交>`，以 `readlink current` 为准）。这次没有使用 `service.sh install`，因为它会重启全部三个服务。做法是在新 release 目录 `npm ci` 并构建 Web，用 `cp -n` 带入上一版带哈希的静态资源，让已打开的旧页面仍能取到资源。随后原子切换 `current`，只重启 `aihot-web.service`。API 与 worker 进程未变，没有迁移或 seed。这种方式只适用于不改 API、worker 与 schema 的改动。公网 HTML 经 EdgeOne 缓存，`s-maxage` 最长 600 秒，且压缩与未压缩响应分别缓存：发布后最多约 10 分钟内部分页面仍引用上一版样式（上一版带哈希的资源仍在，页面不会坏）。核验发布结果前，用浏览器同样的 `Accept-Encoding` 请求页面，确认引用的根样式已是新文件名，或等缓存过期后再跑批量核验。回滚与验收见[有效设计](../references/github-primer.md#验收记录)。

## 离线测试环境

不要加载生产 `app.env` 跑测试，也不要继承 `LLM_GATEWAY_*` 或供应商密钥。先准备名称以 `_test` 或 `_ci` 结尾的隔离空库并完成迁移，再在**腾讯云发布目录**运行（替换测试库连接）：

```bash
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/home/ubuntu \
  DATABASE_URL='postgres://USER:PASSWORD@127.0.0.1:5432/aihot_cutover_test' \
  NODE_ENV=test COLLECT_ENABLED=false FEISHU_CONTENT_PUSH_ENABLED=false \
  FEISHU_INTERNAL_ENABLED=false INDEXNOW_SUBMIT_ENABLED=false npm test
```

不额外设置 `MODEL_CALLS_ENABLED=false`：测试初始化会启用自身 mock。误继承生产配置的实际后果及处置见[切换记录](../references/20261001-production-cutover.md#2026-10-02-准备阶段补充)。


2026-10-09 公开站点 Feedly 浅色视觉已发布到 `feedly-reader-20261009-r2`，只更新 Web，API/worker 保持原进程。未运行迁移或 seed；旧 release 与哈希静态资源保留。共享设计、模板摘要、验收范围和回退点见[Feedly 有效设计](../references/feedly-reader.md#发布与验收2026-10-09)。

2026-10-10 Feedly 复合组件补齐已发布，current 为 `feedly-components-20261010-3ccd2a9`。本轮更新 Web 与海报 API；worker 保持 PID 928519，不执行迁移/seed。运行身份、回退点、375文件字节对照和取样边界见[本轮验收](../references/feedly-reader.md#本轮发布与取样验收)。

2026-10-10 三种外观选择已发布到 `three-styles-20261010-91a0b9b`：原有亮色为默认，暗色和 Feedly 独立可选。仅重启 Web，API/worker 原进程保持，不运行迁移或 seed；回退为 `feedly-components-20261010-3ccd2a9` 加 Web 单服务重启。源码/静态资源及公网交互读数见[三种风格验收](../references/feedly-reader.md#三种风格的线上验收)。
