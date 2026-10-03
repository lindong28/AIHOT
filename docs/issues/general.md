# 未解决问题

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
