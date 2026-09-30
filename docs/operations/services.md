# 服务运维入口

| 服务 | 当前范围 | 运维入口 |
| --- | --- | --- |
| AIHOT API、Web、worker、PostgreSQL | 本机 MVP；自动采集和模型任务尚未启用 | [部署](../deploy.md)、[迁移状态](../migration.md) |
| Wechat2RSS | 可选，本次已授权迁到本机；数据快照已复制，容器引擎启动尚未解决，目标未启用 | [迁移、起停、验证与告警待办](wechat2rss.md)；`deploy/wechat2rss/compose.yaml` |

服务状态以对应环境的真实入口为准；以上不是健康检查结果。Wechat2RSS 不随 AIHOT 默认 Compose 自动启动。
