# 腾讯云旧 Radar 数据退役

2026-10-17，用户在获知当前 `news.aiplanet.live` 使用 PostgreSQL `aihot` 与 `/home/ubuntu/aihot/shared/data`、旧库迁移完整性和异机备份尚未核实后，明确表示“不需要回滚到旧版本”，并要求删除旧数据。此决定取代 2026-10-01/02 切站时保留该服务器旧库用于回滚的安排，不表示历史数据已经全部迁入新库。

## 执行边界

删除范围为 `tencent-webserver-china` 上 `/home/ubuntu/ai-radar/data/` 的 `quarantine/`、`basis/`、`radar-8000.db`、`radar-8001.db`、`radar.db.claimed`、`radar.db`、`radar.db.incoming-shm`、`radar.db.incoming-wal`、`llm_usage.db` 和旧 FTS manifest。保留 `nginx/`、信源配置、少量部署状态文件及 `.deploy.lock`。Nginx 的 `/etc/nginx/conf.d/ai-radar-active-upstream.conf` 仍链接到该目录下的配置，不能连目录一起删除。

先停止并禁用旧 8000/8001 Web，以及旧 db-apply、alert 服务和 timer；持有效部署锁，确认删除对象不跨挂载点、不含符号链接，且没有进程打开或映射待删对象后执行。当前 AIHOT、PostgreSQL、发布目录、旧源码及 `ai-radar-img-tunnel` 不在删除范围。

缓存清理只能释放约 1–2 GB；异机归档会增加传输和保存成本；整目录删除会破坏 Nginx 配置引用。因此采用精确删除旧数据、保留微小配置的方案。旧数据删除不可逆，本次不建立恢复副本。

独立决策审查已完成，七项判据均成立，必要修正无。删除前实测五个主要对象合计约 29.50 GB（27.48 GiB）；根盘可用约 434 MiB。删除决定和上述边界在执行前记录。

## 执行结果

2026-10-17 16:57:59（UTC+8），在旧部署 `.deploy.lock` 的排他锁内完成首批 10 个目标删除；执行前确认目标身份、无嵌套挂载或符号链接、待删对象无打开文件或内存映射。目录复查发现旧 8001 库还留有 32 KiB 的 `-shm` 和零字节的 `-wal`，在旧进程 PID 为 0、文件未打开的条件下补清。两次删除均取得递归删除闸要求的单次批准回执。

首批删除前后根盘普通用户可用空间分别为 453,435,392 和 29,962,489,856 字节，净增加约 27.48 GiB；`df` 使用率从 100% 降为 58%。补清后旧数据目录占 88 KiB，只保留微小配置和部署元数据，旧库及同步副本已不存在；没有删除当前 AIHOT 发布目录、PostgreSQL 或共享数据。

旧 8000/8001 Web、db-apply/alert 服务及 timer 均 disabled；旧 Web、两个 timer 和 alert 为 inactive，db-apply 保留既有 failed 状态而非运行状态。当前 AIHOT API、Web、worker 在操作前后的 PID 分别保持 4070966、4050357、4050344，状态均 active；本次没有重启它们。

删除后源站与公网 `/api/health` 均返回 `ok=true, db=ok`，公网 `/api/v1/items` 返回 50 条文章；公网首页返回包含 AI Radar 站名的 HTML。此为两个健康入口、一个文章列表和一个首页请求的现场检查，不是浏览器交互验收或长期可用性保证。Nginx 配置测试成功，旧 upstream 符号链接仍有效。测试同时报告 `prompts.conf` 的 TLS protocol options 重复定义及重复 MIME type 警告；涉及其他站点且未阻断检查，本次不修改，其后续处置归该站点维护者。

本次不建立旧数据恢复副本，不证明全历史已迁移，也不改变现有 AIHOT 告警覆盖；未核实 `ai-radar-img-tunnel` 是否仍有共享消费者，因此保留该服务，不把它作为已退役项。

## 继续清理旧部署资源

用户随后明确要求继续清理旧 AI RADAR 占用的相关资源。本阶段限中国服务器，接续前一阶段保留的旧源码、虚拟环境、bare 仓、运维目录、私有配置、systemd 定义和无消费者的旧 Nginx upstream；不清理当前 AIHOT release、PostgreSQL、共享数据或其他主机。

现场发现 `sg_img_tunnel` 私钥被旧图片隧道和 `sjtu-aaa-fetch-tunnel.service` 共用，因此保留私钥、公钥、SJTU 隧道及新加坡服务。只退役旧图片隧道的 39148 入口；当前 AIHOT 的 egress 使用 39032。当前 `news.conf`、`news-http.conf`、TLS 与 ACME 配置继续使用，不能按旧名称或注释删除。

远端 bare 的 `refs/heads/main` 为 `0aff4f57faa0be2ef47e0d0d9b9f772bdc97d28c`，本机参照仓没有该对象。已先归档旧源码、计划资料、bare 与 ops 到本机 `/Users/lindong/.local/state/aihot-retirement/20261017-resources/old-radar-history.tar.gz`（210,545,841 字节；SHA-256 `d739d575d3b1d8a49fb91344e6b66c0aae31bbfc1780a6cfd139afdc8f40206c`）；归档有 3,644 个成员，完整读取成功，提取 bare 后 main 身份一致且 `git fsck --full --no-reflogs refs/heads/main` 退出 0。此为历史源码归档，排除了虚拟环境、缓存、旧 data 和 `.env`，不构成旧站数据恢复备份。

独立决策审查七项均成立。执行前提为持旧部署锁、核对精确路径及挂载、停用旧服务、确认无其他进程持有旧目录文件或映射。先移除无消费者的 upstream symlink，配置测试和 reload 成功并验证当前公网健康后，再删除其旧目标目录；若配置测试或 reload 失败，恢复链接并停止后续删除。

### 第二阶段结果

2026-10-17 17:18:29—17:18:32（UTC+8），取得递归删除闸的单次批准后，在旧部署锁内执行。四个目录 `/home/ubuntu/ai-radar`、`/home/ubuntu/ai-radar.git`、`/home/ubuntu/ai-radar-ops`、`/etc/ai-radar` 已不存在；删除 6 个旧 systemd 定义、1 个模板备份、旧 upstream symlink、2 个未启用的旧站配置和 3 个旧 `news.conf` 备份。旧 db-apply 的 failed 状态已清除，daemon-reload 后 `ai-radar*` 无注册 unit。旧部署及 bare 删除前 `du` 合计约 680 MiB；根盘可用空间实测从 30,093,447,168 增至 30,395,727,872 字节，净增约 288 MiB，使用率仍为 58%。目录占用合计不等同于文件系统净释放量，实际容量结果以 `df` 为准。

删除后 39148 不再监听，现役 39032 和 SJTU 39248 仍监听。AIHOT API/Web/worker 的 PID 保持 4070966/4050357/4050344，SJTU 隧道 PID 保持 2877091，四者均 active。源站和公网健康接口各一次均为 `ok=true, db=ok`；公网文章列表一次返回 50 条，HTTP 一次返回 301 至 HTTPS；同一张现有签名代理图片在操作前后均返回 200、`image/webp`、1,966 字节。签名代理图片读数可能命中缓存；另从中国服务器经现役 39032 代理请求同一原图，返回 200、`image/webp`、2,008 字节。该单样本证明此时现役 egress 可取图，不外推所有来源或长期抓取。Nginx 配置测试及 reload 成功，前述其他站点的既有警告仍在，本轮不修改。

本阶段已完成所列中国服务器资源清理；保留的共享密钥有实际 SJTU 消费者，新加坡服务不在本轮范围。当前 AIHOT 发布目录、PostgreSQL 和共享目录未清理。本机归档和参照仓保留用于历史查阅，不提供旧业务数据恢复能力。未处置的本阶段新增 finding：无。
