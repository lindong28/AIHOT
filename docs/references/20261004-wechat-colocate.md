# Wechat2RSS 与 X ingest 同机部署

2026-10-04，用户要求部署所需脚本、文档与自有代码归本仓，Wechat2RSS 与 X ingest 同机，并随 AIHOT 统一启动。腾讯云 `aihot-worker` 正在采集 X，故目标为腾讯，不是 Mac Studio。本决定更新同日首次接入时暂留 Mac mini 的拓扑；此前不将整个 AIHOT 栈 Docker 化的决定保持。

采用既有固定镜像与 Compose，仅新增生命周期分派并接入 `deploy/production/service.sh`。私有配置及数据库放 `/home/ubuntu/aihot/shared/wechat2rss/`，本地回环 18480。Ubuntu 发行版 Docker 与 Compose 首次安装，后续使用既有引擎。Wechat2RSS 本体由上游镜像提供，不把闭源二进制当成本仓自有源码。

准备期只下载镜像，不启动副本。先停旧实例，再取得最终 SQLite 快照，成功后才将 `compose.env` 放到统一入口读取的正式路径。目标登录与 feed 验证成功后切 AIHOT origin、停旧隧道。迁移失败先停目标再实测旧实例能否恢复；保留数据不保证跨设备许可可回退，不自动取消全部设备激活，不替用户扫码。

未采用继续远端隧道（不满足同机目标）、整栈容器化（超出本次范围）、更换服务商（改变现役方案及费用）。主线程事前读数：腾讯 x86_64、worker active、Docker 未安装、18 GB 磁盘可用、约 1.9 GB 内存可用；旧容器 arm64、约 64 MiB 内存。多架构、许可/登录及真实采集仍须实测，容器 running 不替代它们。

外部健康探针代码迁入本仓，仍由 Mac mini 的既有 im-notify 通道从外部执行，通过 SSH 检查腾讯回环 API；保留五种故障 key、恢复 key、原状态与频率。SSH 失败仅表示健康未核实，不宣称微信发现停止。恢复后的业务证据指向 AIHOT `fetch_runs`。旧告警分级/消息长度债务已有 `ai-radar/docs/issues/alerting.md` 载体，本次不宣称全量告警审核完成。测试应隔离真实投递；本轮曾违反此边界，经过与修复见下。

独立 decision-review（`wechat_decision_review`）七项成立、放行；修正了正式配置落位时点、回退承诺与远程探测结论范围。实现由主线程承担，R/G 采用生产迁移与数据完整性所需的独立审查；不增加整栈重构或额外验收矩阵。

## 实施与验收

2026-10-04 10:01 +08，腾讯 `current` 已指向 `wechat-colocate-20261004`，API/Web/worker 均 active。Docker 与三个服务均 enabled。Wechat2RSS 使用原固定摘要 `sha256:000c3243ebdc5d7edc30cb00e52981b600f02d11f85fefcec27e2226c208082f` 的 amd64 镜像，容器 running，仅监听 `127.0.0.1:18480`。正式切换通过 `deploy/production/service.sh install` 完成，公众号容器先启动、再切 release 并重启 worker。

先暂停旧健康 cron、停止 Mac mini 旧容器，再用 SQLite backup 取得最终快照：22 个订阅、2,221 篇文章，integrity_check 为 ok。原许可证与登录在腾讯可用，健康 API 返回 1 个账号可用且未风控，无需重新扫码。AIHOT 私有 origin 改为 18480，token 与服务配置相等；旧 app.env 以 0600 保存为 `app.env.before-wechat-colocate-20261004`。旧容器状态 exited，旧隧道卸载，腾讯 39033 已不监听。旧数据保留，不承诺未经实测的许可证回退。

22 个逐账号认证 RSS 均返回正文，范围为 22 个不同 feedId/bizId、单一目标实例及当前快照。正式 worker 的 `reason=schedule` 检查在 `02:00:21Z–02:00:41Z` 覆盖全部 22 个账号，均为 ok、新增 0 篇，证明切换后的定时读取及重复采集；不等于本轮产生了新文章。X 来源在 `01:56:21Z` 有成功采集。公众号累计文章状态为 analyzed 151、blocked 38；后者是既有相关性过滤语义，不是本次服务迁移的故障。公开 `/api/site/items/qrjfugj4r9emnsfzrl5j5sc22` 返回 200，含 `mp_account` 身份及微信原文链接。公网 smoke 覆盖当前单一部署的 19 个页面、14 个机器出口和 MCP initialize，无失败或跳过；不宣称视觉体验或主机重启恢复已验收。

Mac mini 外部探针副本与状态移至 `~/.local/share/aihot/wechat2rss/`，仅替换原健康 cron 一行，保留其他 cron 和 im-notify 去重身份。旧 cron 备份与原健康状态保存在该目录 `migration-20261004/`。干净环境直接 ssh 无法认证，而 `zsh -c` 加载既有 SSH 环境后成功，故 cron 显式使用这一入口。以清空环境、真实 SSH/健康 API、通知替身执行完整探针，得到 healthy；没有人为关闭生产服务来测试报警，也没有宣称已观察到下一次 cron 自动执行。

本地独立空库 `aihot_wechat_colocate_20261004_test` 运行后端 288 项、Web 11 项，均通过；typecheck 与 Web build 成功。新增部署测试为 3 项，覆盖登录有效/失效、API 错误/503/缺 token，五类故障身份与恢复，以及配置存在/缺失时 start/stop 顺序；只使用本地 HTTP、通知替身和命令替身，不外推宿主机重启。独立代码审查及修复窄复核已放行；没有未处置的增量 findings。文档按实际变更普通同步，未额外进行独立文档审查。

本轮测试隔离曾出错：仅 mock Bash 函数不能拦截 Python `subprocess`，在 `01:43:59Z–01:44:00Z` 向飞书误发 apierr、noaccount、login、riskctl 共 4 条消息。已向用户说明这些是测试误报。修复为所有语言调用共用 `IM_NOTIFY_BIN`，测试指向实体替身并断言四类 firing 均进入替身；独立复核确认没有新增真实发送。仅清理 Mac Studio 本轮留下的四个测试去重 key，未清理 Mac mini 生产身份。此教训随实现记录在本仓，后续故障分支测试必须沿用实体替身。

本地证据与私有最终快照保存在主 checkout `.data/wechat-colocate-20261004/`；生产安装日志在 `/home/ubuntu/aihot/shared/wechat2rss-preparation/`。私有数据不入 Git，上游程序本体仍由镜像提供。安装、启动、状态、探针、迁移脚本与适配代码均由 AIHOT 仓库维护，不依赖旧 ai-radar checkout。
