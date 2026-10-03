# 未解决问题

## ISSUE-GATEWAY-20261003-fd64：Gateway 安装覆盖文件句柄上限

- 状态：open；负责人：个人 Gateway 部署维护者；本轮完成运行态恢复，安装器修改属于 Gateway 维护范围，尚未实施。
- 现场：2026-10-03 自托管 Qwen 的模型管理线程因 `Too many open files` 退出，阻塞全量回填；Mac launchd 默认 maxfiles 256，服务原无覆盖。当前服务 plist 已设置 soft NumberOfFiles 4096 并重启，路由及新闻终态增量已恢复，详见 [回填运维](../operations/backfill.md#qwen-路由不可用的现场恢复)。
- 未完成项：共享 `llm-gateway/install.sh` 生成的 Darwin plist 没有资源上限设置，重新安装会覆盖现场修复。后续在 Gateway 所属部署配置与安装入口持久化此值；保持其它消费者、模型、额度与未知回执语义不变。4096 的长期容量尚未验证。

## ISSUE-MODEL-20261003-7a21：将上游未显式指定的模型参数记录到配置

- 状态：open；负责人：AIHOT 维护者；按用户 2026-10-03 指示留待后续处理。
- 基线：开源 AIHOT `877d6d5`。`temperature`、`max_tokens`、timeout 在各阶段调用或 `chatJson` 默认分支已有明确值，不能列为“上游未指定”而自行改动。完整现值见 [模型配置](../references/model-configuration.md)。
- 未显式项：除 GLM selection 外各角色的 `top_p`；MiMo、DeepSeek 非思考及 Qwen preset 的 `reasoning_effort`；除 GLM selection 外的 `clear_thinking`；未传入的 provider 原生采样参数。记录时须区分未传、显式值及模型不支持，不用猜测的厂商默认值冒充运行值。
- 后续范围：由用户发起，将这些字段及有效来源集中到相关配置文件，再确认具体值。本次保留原有省略行为，不新增效果调优或每次运行的核验成本。

## ISSUE-MODEL-20261003-c8f4：Gateway embedding 的缺省分支与上游不同

- 状态：open；负责人：AIHOT 维护者。
- 代码：`providers/embeddings.ts` 在 Gateway 路径缺省为 `text-embedding-3-small`、dimensions=0；上游无自有 embedding key 时缺省为 `text-embedding-v4`、1024。
- 当前影响：2026-10-03 生产 `app.env` 明确指定 `EMBEDDING_MODEL=text-embedding-v4`、`EMBEDDING_DIMS=1024`，运行值对齐；Gateway 下未配置模型时 `embeddingsAvailable()` 返回 false，不能把代码 fallback 当作已发生的外部调用。
- 后续：调整缺省配置时按上游语义与 Gateway 接入契约核对；当前不更换线上 embedding，也不重建历史向量。
