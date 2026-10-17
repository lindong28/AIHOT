# 腾讯云 AIHOT 历史 release 清理（2026-10-17）

## 范围与决定

复用 `service-workflows cleanup-services` 审计腾讯云 `tencent-webserver-china` 上的 AIHOT 部署及直接依赖。用户在本次专用批准问题中选择“批准一次”，明确覆盖这 87 项删除及旧 AIHOT release 直接回切用途的取消；归档完整验证通过后执行完成，未沿用旧 Python Radar 的退役批准。

已回收 `/home/ubuntu/aihot/releases` 内 50 个旧目录及 37 个旁置安装包、manifest、构建日志，保留唯一现役目录 `private-research-20261013-982479a`。目标清单固定到路径、设备、inode 和类型；临执行复核 current、进程、挂载及目标身份，变化即停止受影响操作。本次不增加自动清理任务或固定版本保留数。

| 保留对象 | 依据 |
| --- | --- |
| 现役 release、current、API/Web/worker 与 backfill timer | 正在承接生产；三个主服务的实际 cwd、打开文件和映射均指向现役 release |
| shared/app.env、web.env、数据、backfill、history 与审计材料 | 配置、业务状态、续跑或审计用途；取消代码回切不包含销毁这些材料 |
| Wechat2RSS 容器及唯一镜像、shared/wechat2rss/data | 现役容器挂载和 compose 来源已核实；Docker 无其它闲置容器、卷或构建缓存 |
| 根目录旧 overlay 包、manifest、日志及 shared 中历史配置/探针记录 | 作为部署过程与配置审计材料保留；不因名字旧就作为可再生运行物删除 |
| PostgreSQL、隧道、代理、TLS、共享 SSH 密钥与其它项目 | 当前依赖或范围外；不改配置、停服或运行全局 prune |

## 删除前证据与保全

现场 `current` 为 `/home/ubuntu/aihot/releases/private-research-20261013-982479a`，`RELEASE_SHA` 为 `982479af7a8931e7d37c233462f9bd106eddd6fb`；API/Web/worker PID 分别为 4070966、4050357、4050344。公开 health 的 release 字段返回 `dev`，不能据它认定实际部署版本。

已从 `/proc` 的 cwd、fd、maps 和 cmdline 核候选引用，并核 systemd/nginx/cron 配置，未发现旧候选消费者，读取无错误。另遍历现役 release 与 shared 的 28 个符号链接，解析目标中候选命中 0、读取错误 0。候选下无嵌套挂载。该证据限现场可见消费者，不代表对任意外部引用或并发部署提供原子互斥保证。

旧 release 大多没有 RELEASE_SHA，不凭名称认定可从 Git 完整重建。源码、旧包及探针资料流式保全到本机持久目录 `/Users/lindong/.local/state/aihot-cleanup/20261017-live/`，排除可再生 node_modules 与 apps/web/build；不在服务器新增一份占用空间的归档。首轮传输在 180 秒超时，部分文件不算备份；确认远端 tar/gzip 已退出后，根据 852381311 字节实际输入规模重新传输。最终归档 `old-release-sources-complete.tar.gz` 共 630977009 字节，SHA-256 为 `ae3aae9be90eb60e2dd84d08e53793f198ce5d158a71eb203967702680131933`；SSH/tar 退出 0，完整读取 gzip 验证 CRC，并核对 87 个顶层目标、30495 个普通文件、852381311 字节原始文件内容总量均匹配。校验结果保存在 `archive-verification.json`。这份源码保全不等于可直接启动的完整旧运行环境，也不是业务数据库备份。

决策与执行脚本各经独立审查，补齐 retained symlink 证据后均通过；归档校验和删除批准由执行者完成，审查不替代批准。执行脚本只针对固定 87 项，并逐项复核身份及进程依赖。

## 执行结果

固定清单的 87 项全部删除，退出码 0；releases 中仅剩 `private-research-20261013-982479a`。清理开始可用空间为 30217904128 字节，完成时为 45012848640 字节，实际增加 14794944512 字节（13.8 GiB）。随后 df 显示根分区使用率 37%，可用约 41.9 GiB；清理前使用率 58%。服务持续写入会使后续容量读数略有变化。

API/Web/worker 的 PID 与删除前一致，均 active/running；backfill timer active/waiting，Wechat2RSS 容器仍 Up 13 days。现役 RELEASE_SHA 和 current 均未改变。没有执行迁移、重启、停止服务、付费模型调用或全局 Docker 清理。

清理前后通过同一公网入口核验 7 条路径：1 个 health（db=ok）、1 个文章列表（各返回 50 条）、1 个首页、2 个现用 JS 资源、1 个固定文章详情 API 和对应的 1 个 HTML 页面，均 HTTP 200。详情 API 核对了同一文章 ID，两项 JS 的响应字节数与清理前一致。另核源站 health 正常；范围仅覆盖这台主机、现役这一个 release 和上述消费者样本，没有声称完整 UI、所有历史浏览器缓存或一次新采集/模型任务均已验证。

证据位于上述本机持久目录：`manifest.json`、`cleanup.py`、`approval.json`、`preflight.jsonl`、`apply.jsonl`、`public-before.json`、`public-after.json`、`retained-symlinks.json` 和 `archive-verification.json`。已删除首轮不完整归档，完整归档保持 0600，不入 Git。其余保留项用途见上表；未完成清理项和未处置 findings：无。

## improve-skill 实跑观察

本次使用的 cleanup-services 指令 SHA-256 为 `fb5f1b4862866dfc83f2fb0b11b86ce4f0a7003ad9a02a48c5006b74f56c3a1a`；改现场前已冻结验收与输入，记录于上述目录 `acceptance.json`。这是一轮知情执行者自检，不是独立盲验或泛化评测。

结论为 **no-fix**：归档超时来自执行者给出的传输预算，符号链接补查来自消费者取证遗漏；现有指令已要求验证保全、检查 symlink 消费者并按现场资源执行。这两项在本次执行中已纠正，实际清理和消费者复验完成，没有发现需继续扩写共享指令的缺口。Claude/Codex 实际入口的内容摘要均与冻结值一致；本轮未修改 harness 源文件，因此没有修订前后效果比较，也不声称提高了未来 agent 的遵循率。案例与证据保存在本记录和上述持久目录。
