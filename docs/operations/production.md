# 腾讯云生产运维

面向部署维护者，说明 AI Radar 的发布、检查与公网回滚。**腾讯云实例在升级期间必须持续在线（用户于2026-11-11明确）**：候选先准备并验证，稳定入口切到候选后排空旧请求与任务，再退出旧实例；一般部署许可不包含停服例外。下列带日期的部署结果是历史快照，不能替代当前状态查询。公网已于 `2026-10-02T02:25:07Z` 切到新站；腾讯云 API、Web、worker 均 active，worker 已 enabled，生产 `app.env` 的 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 均为 `true`。条款与隐私正文已由用户确认并应用，用户已明确要求继续使用 Qwen Token Plan 生产调用；该决定不改变供应商条款。切站与授权记录见[生产切换记录](../references/20261001-production-cutover.md)。

实时与历史两条模型链均经个人 Gateway，历史启动批已导入并开始处理。实时模型配置见 [app.env.example](../../deploy/production/app.env.example)：预筛与结构抽取使用 `default`，由 `LLM_MODEL` 指向逻辑名 `qwen3.8-flash`，并以 `LLM_EXTRA_JSON={"enable_thinking":false}` 关闭 thinking。个人 Gateway 优先使用公司集群上已就绪的自托管 Qwen，再回退百炼订阅与按量 API，并负责等值转换自托管参数拼法；其余具名模型沿用各自配置。模板中的采集与模型安全阀仍为 `false`，不要把模板默认值当作生产运行值。回填另见[历史回填](backfill.md)：Qwen 允许 self-hosted 与明确批准的个人百炼订阅备用，排除 DashScope 按量；评分、理解与摘要统一使用 DeepSeek V4.1 Flash，唯一候选为 `company_tencent_vod`。请求按允许路由集合与 registry revision 限定。

2026-10-03 已部署 Gateway `ed36698` 和 AIHOT `da3cf98`（release `bailian-fallback-da3cf98`）。当前历史 run `693bfde2-aa5a-499f-b17e-fd674ed7ea4c` 已在 paused 与批次锁下启用百炼备用，主绑定与历史回执身份保留，随后恢复 timer。两次真实小请求均完成：百炼回执 `45956` / Gateway UUID `64e3d7ff-83ea-46c3-a033-e79b5ca9264f`；正常双候选仍选 self-hosted，回执 `45957` / UUID `20569b0e-69f8-4887-93ef-c1df98938078`。二者均与 Gateway 的单次 success attempt 对应，usage 已返回，账本 cost_state 仍为 unknown，不表示免费。本次未人为制造生产故障；502 后冷却与同请求 fallback 的证据来自本地 HTTP fixture。生产 smoke 与公网健康检查正常，旧 unknown 未批量释放或重放。

2026-10-04 首次公众号接入后，release `wechat-colocate-20261004` 已将 Wechat2RSS 迁到腾讯，与调用 SocialData 的 worker 同机。后端私有 `WECHAT2RSS_BASE_URL` 改为 `http://127.0.0.1:18480`，token 保持，22 个来源继续由 worker 的 mp 队列采集。`deploy/production/service.sh` 统一管理 API/Web/worker 和已配置的 Wechat2RSS 容器；Mac mini 旧容器与隧道已停，仅保留外部健康探针。私有目录、起停、验证与迁移边界见[公众号运维](wechat2rss.md)及[同机部署记录](../references/20261004-wechat-colocate.md)。

2026-10-07 主题大事记已发布，`current` 指向 `topic-chronicle-20261007-56e1bbb`，API/Web 运行功能提交 `56e1bbb`。本次只重启 API/Web，worker 与在途回填未重启；无新增迁移、seed 或模型配置变更。公网视频、OpenAI、模型发布三个主题 API 已返回大事记，页面交互与站点 smoke 已检查。当时旧 release `source-gaps-20261006` 保留供代码回切（该保留已于 2026-10-17 清理时取消），部署身份、验证范围和选材局限见[发布记录](../references/20261007-topic-chronicle.md#生产发布记录2026-10-07)。

## 环境与持久数据

2026-10-31 研究查询扩展已部署 `056b551c757efb2cd15685d1f5cc3dadb950b7e4`，current 为 `research-query-20261031-056b551`；API/Web 加载新release，0054迁移与三个时间索引有效。worker PID4020930 仍运行 `image-recovery-20261027-ad9bea8`，该旧目录仍有运行消费者，不能作为空闲release删除。未改采集/模型配置，分组与别名按用户要求保持空。共享CLI已完成两公众号11篇正文导出验收，34项公网smoke与GitHub check/docker通过；正文完整性仍为unverified。分组管理、时间轴与导出用法见[私有资料API](../private-research-api.md)，版本及证据边界见[实施记录](../../plans/20261031-research-query.md#2026-10-31-发布与生产验收)。

私有文章资料 API 于2026-10-13部署功能提交 `982479af7a8931e7d37c233462f9bd106eddd6fb`，current 指向 `private-research-20261013-982479a`；API/Web/worker 加载同一 release，0048迁移与存量构建完成。令牌摘要沿0600 `shared/app.env` 配置，用户已授权客户端原始令牌存于本机 `~/.config/aihot/research.env`（0600、不入Git）。`RESEARCH_TOKEN_SHA256` 为空时关闭。配置、轮换及回滚后的重建要求见[私有资料API](../private-research-api.md)，实测见[计划U5](../../plans/20261013-private-article-research-api.md#u5-发布执行记录)。

本次真实CLI已核对目标公众号108篇列表及正文；公网34项smoke全部成功，正常／错误／匿名／已撤销令牌和CDN no-store行为均已检查。backfill timer恢复active。构建结束时根分区剩余约1.32–1.34GB（df约99%），历史releases约15GB；容量仍需维护者关注，清理或扩容另行确定范围，本次没有删除旧release。一次三页列表读取16.051秒，仅为现场读数，不是延迟SLA。

生产模板使用 `LLM_GATEWAY_ATTEMPT_TIMEOUT_MS=60000`，在线 worker 与 backfill 的 Gateway 客户端实例均读取它；共享 SDK 缺省仍为 30000。次数预算仍默认 3 次（含首次），backoff 仍为 3 秒、6 秒，每次请求派发后独立计算最多 60 秒，backoff 与路由冷却不扣该时间。修改 `app.env` 后需让 worker 和 backfill 在途任务结算退出，再启动新进程；以新回执的 `request.gateway.retry.attemptTimeoutMs` 和 Gateway attempt 关联核对实际值。更长超时不保证每条新闻成功，也不自动清除历史 unknown 回执。

DeepSeek 具名预设与部署模板已改为 `deepseek-v4.1-flash`。摘要、归组、归组复核、综述、报告、翻译与监控选择非思考 V4.1；backfill 评分使用 `-selection`、理解使用 `-low`，明确保留上游 GLM 各角色参数，三种回填 DeepSeek 角色固定腾讯 VOD。完整参数见 [模型配置](../references/model-configuration.md)，执行见[回填接入](backfill.md)。迁移部署时同时检查 `app.env`、数据库 `models.*` 设置和已有回填批次的模型绑定；历史回执保持原名，不批量重写。直连官方 API 的 `default` 示例仍使用厂商原生 `deepseek-flash`，它与 Gateway logical 名分属不同入口。具名预设直连配置使用 `DEEPSEEK_V41_BASE_URL` / `DEEPSEEK_V41_API_KEY`，端点须识别 `deepseek-v4.1-flash`，不复用旧 V4 自托管地址。

V4.1 的仓库配置与校验代码不自动迁移生产 `app.env`、数据库模型设置、运行进程或既有回填绑定。Gateway 项目需显式登记 personal/company 双归属，腾讯账户保持 company_paid；应用预检核对双归属和唯一腾讯路由。启动回填前必须以运行中的 Gateway 完成预检与真实模型验证，不能把源文件已修改视为生产已加载。

| 位置 | 用途 |
| --- | --- |
| 腾讯云 `/home/ubuntu/aihot/releases/` | 各次发布源码；2026-10-02 回执修复与回填状态修复合并运行于 `backfill-content-filter-20261002-r2`，当前版本以 `readlink /home/ubuntu/aihot/current` 为准；2026-10-17 已清理全部非 current 的旧 release，仅保留现役版本 |
| 腾讯云 `/home/ubuntu/aihot/current` | 完成发布的导航链接；在线槽的systemd固定到release绝对路径，具体运行身份仍查PID/cwd |
| 腾讯云 `/home/ubuntu/aihot/shared/app.env`、`web.env` | 后端与 Web 运行配置；后端凭据文件权限为 0600，不入 Git、不打印内容 |
| 腾讯云 `/home/ubuntu/aihot/shared/data` | 应用持久文件；PostgreSQL 数据由系统数据库服务独立管理 |
| 腾讯云 `127.0.0.1:3001`、`:3000` | legacy API/Web；在线迁移后blue使用3101/3100，green使用3201/3200 |
| 腾讯云 `127.0.0.1:39031`、`:39032` | 专用隧道提供的个人 Gateway 与 HTTP 代理 |

腾讯云已安装 Node.js 24.21.0、PostgreSQL 16.15，完成依赖、Web 构建、数据库迁移及来源 seed。代码包不包含 `.env`、`.data/` 或共享目录；更新源码不覆盖这些持久状态。Web 配置模板见 [web.env.example](../../deploy/production/web.env.example)。

## 部署更新与起停

正式入口为 `deploy/production/service.sh`，`install.sh`、`start.sh`、`restart.sh`、`status.sh`、`stop.sh`、`uninstall.sh` 都转到同一实现。`install/start/restart` 采用同一在线替换流程，要求固定完整 Git revision；`stop/uninstall` 默认拒绝，不保留旧的三服务同时 restart 路径。需停服维护或退役时应另行取得该实例、动作和窗口的明确许可并形成对应操作，不能绕开入口直接 stop 来完成普通升级。

单机 API/Web 采用 blue（API 3101 / Web 3100）、green（API 3201 / Web 3200）两槽。生成的 `aihot-{api,web,worker}-{blue,green}.service` 固定到 release 绝对目录；`current` 只在收尾指向最终版本，不再作为这些进程的工作目录。首次迁移识别 legacy `aihot-{api,web,worker}.service` 的实际 PID、启动身份与 cwd，旧 worker 即使运行另一 release 也保留其身份。新旧普通 worker 不同时取业务任务：归组只保证进程内串行。候选只先消费新增 `research.semantic-query`，其余队列在旧 worker 全部回调排空后才启用。

### 发布接口

采用 `service-release/v1` **mapped** 契约，目标固定为 `aihot/tencent-news`；以下命令均在腾讯云执行，入口位于本次获准的固定 release。源码包从已审完整 commit 构建并保留 `REVISION` 文件（仅该完整 SHA）；有 Git 元数据时入口核 HEAD 和 dirty 状态。上传身份与源码对应仍由发布者核实，不能仅写一个 SHA 就宣称未校验的文件包来自该 commit。配置沿 `shared/app.env`、`shared/web.env`，不放入源码包。

| 操作 | 命令后缀 | 结果与恢复 |
| --- | --- | --- |
| 构建准备 | `prepare --expect FULL_SHA`，或 `prepare-release.sh --expect FULL_SHA` | 只安装锁定依赖、构建；不迁移、不 seed、不切流。拒绝改写正在被进程使用的 release；已准备且身份匹配的运行物可只读复用 |
| 候选验收 | `stage --expect FULL_SHA [--override-env PATH] [--json]` | 新建 release ID，候选 API/Web 和语义队列 ready 后返回；旧业务与公网仍在原实例。exit 0 仅表示候选可验收，发布状态仍是 blocked / cleanup pending |
| 一次在线发布 | `install --expect FULL_SHA [--override-env PATH] [--json]` | 完成准备、候选检查、业务队列交接、切流与排空；start/restart 同义，不是 stop/start |
| 查询 | `status [--id ID] [--json]` | 只读发布记录并附对应 unit 的当前 PID/cwd；历史 installed 不等于当前消费者健康。显式不存在 ID 返回非零 |
| 续跑 | `resume --id ID --expect FULL_SHA [--json]` | 仅原 ID / revision / 配置身份；保留已完成阶段。超时不换 ID，不重新付费编码已有查询 |
| 放弃候选 | `abandon --id ID --expect FULL_SHA --reason TEXT [--json]` | 仅在旧业务交接开始前；候选 worker 先完成在途，保留记录、源码和回执。清理未完可原样重试；进入 worker-drain 后须 resume，不把已交接的版本改为 abandoned |

发布记录在 `shared/online-releases/<ID>/release.json`，锁覆盖目标身份校验和改变，状态与清理分开记录；`active` 指向完成版本，`latest` 指向最近发布。尚有未完成清理时拒绝新建发布。错误、排空超时、身份变化或无法核实时返回非零并保留进度；先 `status` 查原记录，再 resume/abandon，不凭命令超时假定没有发生切流。服务状态与发布状态不互相冒充。

本次无 SQL 迁移：入口比较候选与现役 API release 的 migration 文件集合及摘要，差异会阻止交接。后续有迁移的发布需先形成并执行独立审核的兼容迁移方案，不能恢复旧 prepare 的自动 migrate/seed 行为。

候选语义配置可独立放到 `shared/` 下的0600文件，以 `--override-env` 加载。仅允许 `RESEARCH_SEMANTIC_TOKEN_SHA256`、`MODEL`、`DIMS`、`PROFILE`、`PROVIDER`、`ROUTE`、`ACTUAL_MODEL`、`REGISTRY_REVISION`（后七项同带 `RESEARCH_SEMANTIC_` 前缀）；每行一个赋值，不含其他凭据或多行值。API/worker 在基础 app.env 后加载该文件，旧进程配置不变；文件路径和配置摘要随发布固定，resume 时改变配置会被拒绝。基础凭据不复制到发布记录、Git 或终端。

```bash
# 从已审固定 release 执行；把 FULL_SHA 替换为真实完整提交 ID。
bash deploy/production/service.sh stage --expect FULL_SHA --override-env /home/ubuntu/aihot/shared/release-config/semantic.env --json
# 通过返回的候选 API/Web 回环端口完成真实 provider + 独立 CLI 验收后：
bash deploy/production/service.sh resume --id RELEASE_ID --expect FULL_SHA --json
bash deploy/production/service.sh status --id RELEASE_ID
```

stage 提供的端口可经既有 SSH 隧道供正式 CLI 使用，不新增公网私有 API 暴露。候选验收失败且尚未进入业务交接时用 abandon 回收；不能覆盖原配置后把它当作同一验收版本继续。Wechat2RSS、PostgreSQL、Gateway 隧道、backfill timer 在普通更新中保持运行，分别由原入口管理；此入口不再隐式重启这些依赖。

### 在途交接与排空

旧 worker 的195秒 pg-boss stop期限不构成全部回调上界：JSON generation 重试和归组链可能超过它。交接先为原 unit 写入归属本 release ID 的临时 `Restart=no` drop-in，daemon-reload 后核 PID/启动身份未变及策略已生效，再通过临时、仅loopback的 Node inspector 获取**已有** pg-boss 实例（12.34.0），对全部用户队列（含 cron handler）同时 `offWork(wait:true)`。回调完成且worker集合为空后，正常停止原 unit，核 MainPID=0、inactive/failed、dead/failed 且无待执行 Job，才激活候选的业务队列。原PID消失不能代替unit终态；已换PID不得使用旧排空回执。完成发布时只删除本ID的重启抑制文件并重载，避免影响未来槽的正常重启。不新建 boss、不以一次 active-count=0 代替停取、不修改 receipt 身份、不强杀。新 worker 自身也先 drain 再进入 bounded stop。排空超过前台等待上限时进程继续完成工作，原 release ID 仍可续跑。

候选健康检查同时核 API 的 DB/release、经 Web 转发的同一 release、首页响应和 worker ready 标记与实际 PID。每次切流前保存当前 Nginx worker 的 PID/启动身份；生成候选端口配置，`nginx -t` 后 reload，稳定 origin `/api/health` 确认目标 revision。切流或核验失败时保留两边HTTP进程，恢复原配置、重新校验及reload，并在稳定origin核对原API版本；恢复前与写入前核当前配置仍属于原配置或本次候选；发现外部修改即拒绝覆盖。恢复未核实则保留pending，下一次先恢复再继续。再次切流重新捕获Nginx worker集合，不复用首次切流前的快照。active槽索引成功写入后才记录cleanup完成；写入失败保留finish阶段供同ID恢复。

MCP 订阅可能无限保持，不能只等旧 Nginx worker 自行结束。切流后，临时 inspector 在已核旧 API 源码精确位置使用始终返回 false 的条件断点捕获已有 MCP handler，立即移除断点，再从已有闭包取得 SDK2.1.0 的 `listenRouter`，只执行订阅 `closeAll`。**不调用整个 handler.close**，因为那还会关闭普通 MCP 工具请求。旧 API/Web 继续处理已有短请求和 SSR；旧订阅正常结束，客户端在新入口重连。等旧 Nginx worker 退出后先关闭旧 Web，再关闭旧 API，保住旧 SSR 对 API 的依赖。

inspector 不作为常驻服务：绑定127.0.0.1，PID/启动时刻/cwd/release ID校验，排空 promise 留在原进程供断连接续；退出时移除已登记断点并核调试端口关闭。端口已被未归属会话使用、实例不唯一、版本或作用域不符即拒绝，不扩大扫描、不创建替代对象。首次旧实例默认端口9229，新槽仅预设 API9231 / worker9232（指定端口本身不启动调试监听）。生产操作仍由发布 owner 执行，隔离演练不授权绕过身份检查。

### 验收、容量与材料

源码控制测试覆盖正常切换、候选失败、配置/版本冲突、并发锁、worker与HTTP排空超时、Nginx失败还原和同ID续跑；真实隔离PG验证preview/全队列门控与在途结算。Node24.21.0下已演练原生inspector恢复及MCP订阅关闭；本机真实Nginx1.31.2演练覆盖延迟SSR和短MCP调用保留、订阅新槽重连。**这不代表生产Nginx1.24或本次公网切换已验收**；发布 owner 需连续采样实际公网/私有消费者、记录错误与等待、核目标版本以及真实任务/回执。

发布前记录当前进程RSS、MemAvailable、已有release大小和可用磁盘，确保至少有另一个当前规模实例/release的测量余量；这是前检估算，不是峰值资源或零故障SLA。两槽、新旧hashed assets及构建会产生瞬时额外占用；旧hashed assets只补到尚未启动的候选，避免旧缓存HTML引用的文件消失。保留前次运行release、在途使用目录及发布记录，沿下方既有清理入口确认消费者后回收；不按年龄自动删除，不把 current 一条链接当全体消费者。

发布记录每次一份，保存固定身份、阶段、配置摘要、Nginx原配置和临时drain证据，不保存凭据值/文章/向量。已完成记录、回滚目录与旧hash资产的清理由AIHOT维护者按实际恢复用途处理，未完成记录及其锁不删除。常驻故障告警沿既有worker heartbeat（role保持worker）；槽unit/前台故障的外部push覆盖仍是本仓维护者的既有待办，发布前台失败即时可见不替代该覆盖，见[服务运维](services.md)。

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

### X 图片出口与加载失败

2026-10-27 排查发现：图片冷缓存请求经过腾讯云 `39032`、Mac Studio `59527` 后，落到 `us-agent-group` 的住宅节点；该节点连接超时，导致图片代理返回 502，已有磁盘缓存仍可显示。用户已批准仅将 Mac Studio 的 `pbs.twimg.com` 请求改走现有 `Tencent-SG`，其他域名与全局节点选择保持不变。

在 Mac Studio 的本仓 checkout 执行以下入口；需要系统 Ruby/YAML、curl、正在运行的 Clash Verge，以及 `~/research/system-config` 的现有管理标记：

```bash
ruby deploy/production/image-egress.rb check
ruby deploy/production/image-egress.rb apply
```

入口只在 `LocalHostName=macstudio` 执行，在当前本地 profile 和当前 runtime 的规则前加入 `pbs.twimg.com` 的精确 TCP 规则；原文件除这一行外保持不变。它原子替换文件、重载 Mihomo，并核对规则及 `us-agent-group` 选择未变；失败会尝试恢复本次写入前的配置。原始配置与回执位于本机权限受限的 `~/.local/state/aihot-image-egress/`，含敏感配置，不复制到公开日志或任务附件。重复应用不新增规则；发现配置漂移时停止，不覆盖。需要撤销时运行同入口的 `rollback`。Clash 重启后从本地 profile 生成配置；重新安装或更换 profile 后须重新核对并按实际新配置处理，不能盲目复用旧回执。本入口不改变 system-config 的跨机器默认配置，不新增后台服务或自动切换出口。

安装成功只证明规则生效。随后从腾讯云经正式 `39032` 入口检查原失败图片，并在公网首页、详情页滚动到图片、打开大图，核对实际加载与解码；不能只看 `/api/health` 或静态 Logo。开发中的可见图片检查入口见[开发检查](../development.md)。

应用层的临时图片失败响应使用 `no-store`；日志按资源哈希和域名保留阶段、异常原因链，不记录完整带签名 URL。预生成先完成同篇其他图片，再以失败状态交给现有队列重试（一次，延迟 120 秒）；成功缓存保留。失败卡片提供替代内容，详情可打开原文；刷新页面或切换到新资源后可以重新加载，不承诺同一已挂载图片自动无限重试。

## 旧部署与历史版本清理

复用 `service-workflows cleanup-services`，明确目标为腾讯云 AIHOT、版本回收或整套退役，再按现场的 current、进程实际 cwd/打开文件、挂载和消费者引用裁定。迁移后切换 current 不代表旧任务已经退出；保留目录内指向旧版本的符号链接也属于消费者。

2026-10-17 已按本次明确批准删除 50 个旧 release 和 37 个旁置文件，取消其直接回切用途；保留现役 `private-research-20261013-982479a`。实际释放 13.8 GiB，根分区使用率 58% → 37%，服务 PID 未变。独有源码与资料已保全到本机，需恢复历史代码时先确认源码、依赖、构建和当前 schema 的兼容性，不能再直接切到已删目录。

本次 [2026-10-17 历史 release 清理记录](../references/20261017-release-cleanup.md) 保存范围、归档及执行状态。后续版本清理重新核对当时的回滚用途和在途任务，不把本次候选清单作为周期删除规则。业务数据、配置、续跑与审计材料按自身用途保留，不能随 release 名称一起删除。实际释放空间以目标文件系统前后 df 为准。

持续写入的容量与生命周期另见 [2026-10-17 存储审计](../references/20261017-storage-audit.md)：包括业务数据库、缓存、日志和备份。该审计是现场快照及候选改进，不是新的自动删除授权或保留策略。

2026-10-17 已经批准部署 `23c5c78`，current 为 `storage-20261017-23c5c78`，迁移 0049/0050 和 `RECEIPT_SINGLE_COPY=true` 已生效。API/Web/worker 与回填均使用新版，旧 release 暂留发布对照；关闭开关不会恢复省略字段，不能直接回退旧读者。启用/回退和每日清理见[存储运维](storage.md)，真实回执、私有读取与公网验证见[部署记录](../references/20261017-storage-optimization.md#生产部署与消费验证)。worker 现有 120 秒 systemd 停止期限短于应用 195 秒，本次以定向 SIGTERM 和回执/作业结算读数排空，后续修复见[项目问题](../issues/general.md)。

## 公网切换与回滚

公网已切到新站。当前配置是 `/etc/nginx/sites-available/news.conf`，由 `/etc/nginx/sites-enabled/news.conf` 链接；HTTP 配置 `news-http.conf` 和现有证书保持。切换时 `nginx -t` 成功后执行 reload，并从公网健康接口、首页、详情和 smoke 核对了新站。

普通更新只使用上文在线发布器生成槽端口配置并reload；不要手动安装模板 `news.conf`（模板中的3000/3001是legacy初始端口），否则会绕过候选检查和排空。HTTP配置、TLS/ACME仍沿原生Nginx运维，改动另行验证。

代码回退同样是一次固定revision的在线发布，先核schema兼容，再通过stage验收后resume；不把旧数据库恢复覆盖新数据。切流后出现错误但旧HTTP尚未排空时，保留两边和原记录，按实际阶段恢复，不把退出非零当作未切流。2026-10-17用户已取消旧RADAR回滚，旧数据库与8000/8001服务已退役；`news.conf.before-aihot`仅是历史材料，不能重新用于切回旧站。历史退役边界见[退役记录](../references/20261017-old-radar-retirement.md)。

## 旧链路保留与恢复边界

Mac mini 于 `2026-10-01T15:38:51Z` 精确移除了含 `collector.sh`、`pipeline.sh`、`deploy/sync/sync-db-cron.sh`、`scripts/collect_aihot_supervised.sh` 的四条 cron，在途同步随后停止；备份位于该机 `~/.local/state/aihot-cutover/20261001T153851Z/`。2026-10-17 已删除腾讯云旧库和同步副本，随后清理旧部署、虚拟环境、bare 仓、ops 和私有配置，并注销旧双槽 Web、db-apply/alert 服务及 timer、`ai-radar-img-tunnel`。独有源码历史已归档到本机，位置与校验见[退役记录](../references/20261017-old-radar-retirement.md#继续清理旧部署资源)。`sg_img_tunnel` 私钥与公钥仍供 `sjtu-aaa-fetch-tunnel.service` 使用，必须保留；新加坡代理未在本轮清理。Wechat2RSS 于 10 月 4 日迁到腾讯，旧实例保持停止，见[专页](wechat2rss.md)。

用户要求停旧采集，并已取消旧站回滚。本次未核实完整异机备份，旧链路不再有可直接使用的本机数据库；恢复旧链路属于新的任务，需要先确认可用数据来源，不能只启动旧服务或恢复历史 crontab。

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
