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
