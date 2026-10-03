# 服务运维入口

截至 2026-10-02 的切站后快照；公网 Nginx 已代理到新站，自动采集与模型处理已启用。

| 服务 | 环境、守护与当前状态 | 运维入口 |
| --- | --- | --- |
| AIHOT API、Web | 腾讯云 systemd，active；公网首页、详情与公开出口已取得新站内容 | [生产运维](production.md)；`deploy/production/service.sh` |
| AIHOT worker | 腾讯云 systemd，enabled 且 active；生产采集与模型安全阀开启，已观察到多轮调度和新增文章 | [部署更新与起停](production.md#部署更新与起停)；与 API/Web 共用 `service.sh` |
| 历史回填执行器 | 腾讯云 timer 已安装启用；08:07 UTC active/waiting，oneshot service 正常结束（Result success、exit 0）；首批 43/44、needs_attention，不自动重试，新 ready 批仍可执行 | [有界 drain 与生产调度](backfill.md#有界-drain-与生产调度)；`deploy/production/backfill-service.sh` |
| 历史回填监督 | Mac launchd `live.aiplanet.aihot-backfill-probe`，每 300 秒只读生产；scheduler inactive、恢复与批次 needs_attention 通知均已发送，重复批次通知 skipped(unchanged) | [Mac 监督与通知](backfill.md#mac-监督与通知)；`deploy/production/backfill-monitor.py` |
| PostgreSQL | 腾讯云 PostgreSQL 16，已完成迁移与 seed | [生产运维](production.md)；系统原生 `systemctl status postgresql` |
| 个人 Gateway／代理反向隧道 | Mac Studio launchd：`live.aiplanet.aihot-gateway-tunnel`；腾讯云回环入口已取得响应，未验重启恢复 | [隧道运维](production.md#个人-gateway-与代理隧道)；`deploy/production/gateway-tunnel.py` |
| 旧 RADAR Web／Nginx | 腾讯云原 Web 的 8000/8001 保留供回滚，公网 Nginx 已指向新站 | [公网切换与回滚](production.md#公网切换与回滚)；Nginx 使用系统原生接口 |
| 旧 RADAR 采集、处理、同步 | Mac mini 四条 cron 已移除，在途同步已停；腾讯云 `ai-radar-db-apply.service` 已停止并禁用 | [停止记录与恢复边界](production.md#旧链路保留与恢复边界) |
| AIHOT 本机 MVP | 独立本机环境；既有读数不代表生产状态 | [部署](../deploy.md)、[带日期的本机记录](../migration.md#本机-mvp) |
| Wechat2RSS | Mac mini 原服务保留，22 个公众号经专用回环隧道接入腾讯云；服务搬迁未完成 | [接入、起停、验证与告警待办](wechat2rss.md)；`deploy/wechat2rss/tunnel.py`、`compose.yaml` |

服务状态以对应环境的真实入口为准；以上不是持续健康保证。Wechat2RSS 不随 AIHOT 默认 Compose 自动启动。回填已有上表中的专用监督，范围不覆盖公开站点可用性；其余新生产服务的外部告警接管仍由本仓 AIHOT 维护者负责，待办见[根 README 服务章节](../../README.md#服务)；原有服务告警保持。
