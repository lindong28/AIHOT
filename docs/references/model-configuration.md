# 模型与请求参数

面向部署维护者。基线为开源 AIHOT `877d6d5` 的 `.env.example` 中“AIHOT 自己的分工”及调用代码，不是对上游私有生产环境的读取。下表是本仓目标配置；生产是否已加载须读运行配置与回执。

用户 2026-10-03 确认预筛 Qwen3.7→3.8、回填 GLM→DeepSeek；归组复核最终改为 DeepSeek V4.1，以保留上游 MiMo 关闭思考的行为。除此以外保留上游显式参数、提示词及门槛。上游未指定字段不自行补值，见 [ISSUE-MODEL-20261003-7a21](../issues/general.md)。

| 阶段 | 在线模型 | 回填模型 | temperature / 有效 max_tokens / 模型请求超时 |
|---|---|---|---|
| 初筛 | Qwen3.8 Flash | 同左 | 0 / 512 / 120s；enable_thinking=false |
| 双评分 | GLM5.3 Flash selection | DeepSeek V4.1 Flash selection | 1 / 65536 / 180s；thinking enabled、clear_thinking=false、effort=high、top_p=0.95 |
| 内容理解 | GLM5.3 Flash | DeepSeek V4.1 Flash low | 0.2 / 16384 / 180s；thinking enabled、effort=low |
| 标题摘要 | DeepSeek V4.1 Flash | 同左 | 0.2 / 2048 / 120s；thinking disabled、单次调用 json=false |
| 结构抽取 | Qwen3.8 Flash | 同左 | 0.2 / 800 / 120s；enable_thinking=false |
| 事件归组 | DeepSeek V4.1 Flash | 不执行 | 0 / 按候选数计算 / 120s；thinking disabled |
| 归组复核 | DeepSeek V4.1 Flash | 不执行 | 0 / 512 / 120s；thinking disabled |
| 事件综述 | DeepSeek V4.1 Flash | 不执行 | 0.3 / 1200 / 120s；thinking disabled |
| 日报导语、周报/月报 | DeepSeek V4.1 Flash | 不执行 | 0.3 / 800、2500 / 120s；thinking disabled |
| 全文、引用翻译 | DeepSeek V4.1 Flash | 不执行 | 0.2 / 按文本长度计算 / 180s、120s；thinking disabled |
| Codex 监控识别 | DeepSeek V4.1 Flash | 不执行 | 0.1 / 2500 / 120s；thinking disabled |
| 向量 | text-embedding-v4，1024 dimensions | 不执行 | 60s；无 temperature/max_tokens |

归组上限：报道 `max(512,200+90×候选数)`，信号 `max(512,150+60×候选数)`，事件对及复核调用传 400，经上游 wrapper 最小值变成 512。翻译上限：正文 `min(8000,ceil(段落字符数×1.2)+400)`，引用 `min(4000,ceil(字符数×1.5)+200)`，均受 wrapper 最小值 512 约束。未特别覆盖的请求开启 JSON mode。

DeepSeek 原上游使用未钉版本的 `deepseek-flash`；当前 Gateway 使用明确 `deepseek-v4.1-flash`，不能据同族名称声称与上游当时权重完全相同。相同请求参数也不保证不同模型内部采样/推理语义相同；provider 实际接受和行为须分别报告，不能因不支持而静默删参数。评分使用专用 `-selection` preset，避免通用 `-think` 分支额外增加 4000 tokens。

## 查看位置

2026-10-03 17:10 +08 已部署 `model-alignment-20261003`，API 与 worker 已加载。归组复核兼容性调用使用两篇真实报道和原 pair prompt，回执 22478 completed，实际路由 `company_tencent_vod/deepseek-v4.1-flash/stream`；请求 disabled/0/512，返回 reasoning_tokens=0。回填真实流程的评分 22481/22482、理解 22525、摘要 22483 均 completed，分别使用 65536/1、16384/0.2、2048/0.2；评分与理解返回思考 tokens，摘要为 0。这证明接口接受及所测调用完成，不证明不同模型内部参数语义或评分分布相同。完整生产请求/回执证据在主 checkout `.data/backfill-full-run-20261002/model-alignment-live-receipts.json` 与 `group-review-compatibility-result.json`。

- `/admin/models`：在线各角色的 preset 与来源；优先级是数据库 `settings.models.*` → `app.env` → 代码默认。`default` 在当前生产解析为 Qwen3.8；历史用量混合在线和回填，不是当前配置表。
- `/admin/backfill` 的“回填模型与批次信息”：该 run 的五角色模型和限定路由，权威数据为 `backfill_runs.models`。
- 生产 `/home/ubuntu/aihot/shared/app.env`：真实环境配置；仓库 `deploy/production/app.env.example` 只是模板，不包含凭据。`GROUP_REVIEW_MODEL=deepseek-v4.1-flash`。
- `packages/backend/src/providers/llm.ts`：preset 的 thinking、effort、top_p、JSON 行为及 wrapper 默认；`editorial/analyze.ts`：初筛、评分、理解、摘要和结构调用参数；其他阶段在 `events/`、`reports/compose.ts`、`editorial/translate.ts`、`monitor/recognize.ts`。
- `packages/backend/src/backfill/context.ts`：回填 preset；`deploy/production/backfill-models.json` 为路由模板。回填 Qwen 主路线为 self-hosted，`fallbackRoutes` 仅允许个人百炼 Token Plan 订阅；既有批次须经暂停和受锁启用，见[回填操作](../operations/backfill.md)。DeepSeek 仅 Tencent VOD，公司付费。
- 数据库 `receipts.request`：实际 temperature、maxTokens、Gateway timeout；`receipts.response.llm_gateway`：实际 provider、route、model。历史记录保留原参数，不批量改写。

目前后台不显示完整请求参数；需结合这些代码/配置及实际回执查看。逐条原文完整性 LLM 调用已从修复后的执行路径删除，完整性按用户要求由 agent 抽样，缺原文等工程错误仍单独处理。
