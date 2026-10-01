# 服务运维入口

截至 2026-10-02 的准备阶段快照；公网 Nginx 尚未切到新站。

| 服务 | 环境、守护与当前状态 | 运维入口 |
| --- | --- | --- |
| AIHOT API、Web | 腾讯云 systemd，已启动；只完成内部检查，公开内容尚为空 | [生产运维](production.md)；`deploy/production/service.sh` |
| AIHOT worker | 腾讯云 systemd，已安装并 enabled，但进程停止；采集与模型安全阀关闭 | [启动前置与状态检查](production.md#部署更新与起停)；与 API/Web 共用 `service.sh` |
| PostgreSQL | 腾讯云 PostgreSQL 16，已完成迁移与 seed | [生产运维](production.md)；系统原生 `systemctl status postgresql` |
| 个人 Gateway／代理反向隧道 | Mac Studio launchd：`live.aiplanet.aihot-gateway-tunnel`；腾讯云回环入口已取得响应，未验重启恢复 | [隧道运维](production.md#个人-gateway-与代理隧道)；`deploy/production/gateway-tunnel.py` |
| 旧 RADAR Web／Nginx | 腾讯云原 Web 的 8000/8001 保留，公网仍指旧站 | [公网切换与回滚](production.md#公网切换与回滚)；Nginx 使用系统原生接口 |
| 旧 RADAR 采集、处理、同步 | Mac mini 四条 cron 已移除，在途同步已停；腾讯云 `ai-radar-db-apply.service` 已停止并禁用 | [停止记录与恢复边界](production.md#旧链路保留与恢复边界) |
| AIHOT 本机 MVP | 独立本机环境；既有读数不代表生产状态 | [部署](../deploy.md)、[带日期的本机记录](../migration.md#本机-mvp) |
| Wechat2RSS | 原机服务仍运行；目标迁移未完成，不随本次站点准备切换 | [迁移、起停、验证与告警待办](wechat2rss.md)；`deploy/wechat2rss/compose.yaml` |

服务状态以对应环境的真实入口为准；以上不是持续健康保证。Wechat2RSS 不随 AIHOT 默认 Compose 自动启动。新生产服务的外部告警接管仍由本仓 AIHOT 维护者负责，待办见[根 README 服务章节](../../README.md#服务)；原有服务告警保持。
