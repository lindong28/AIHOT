# 已关闭问题

## ISSUE-GATEWAY-20261003-fd64：Gateway 安装覆盖文件句柄上限

- 状态：resolved（2026-10-03）；负责人：个人 Gateway 部署维护者。
- 现场：2026-10-03 自托管 Qwen 的模型管理线程因 `Too many open files` 退出，阻塞全量回填；Mac launchd 默认 maxfiles 256，服务原无覆盖。现场 plist 设置 soft NumberOfFiles 4096 并重启后，路由及新闻终态增量恢复，详见 [回填运维](../../operations/backfill.md#qwen-路由不可用的现场恢复)。
- 原问题：共享 `llm-gateway/install.sh` 重建 Darwin plist 时会丢失现场覆盖。
- 修复：共享安装器支持可选 `LLM_GATEWAY_LAUNCHD_NOFILE`；个人 `ai-agent-config/llm-gateway/install.sh` 每次完整安装固定传入 4096。两仓须同步更新，直接运行共享安装器仍须显式传参。模型、额度与未知回执语义不变。
- 本地提交：共享 Gateway `16ddb98`、个人配置 `24f6e1bd`，均已快进整合至本地 main；未 push。
- 验证：隔离 HOME 下用合成配置从个人入口连续安装两次，生成的 soft limit 均为 4096；复用生成定义的独立 launchd 进程实际读取 RLIMIT_NOFILE soft=4096，并以 exit 0 结束。共享生命周期 52 项、个人配置 9 项测试通过，含两种有效上限、空值、7 种非法值及 Darwin/Linux 渲染分支；本轮未重装生产服务。证据在主 checkout `.data/gateway-nofile-20261003/`。4096 的长期容量尚未验证。
