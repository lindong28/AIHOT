# 回填评分与理解改用 DeepSeek（2026-10-03）

状态：下列首次切换记录保留作历史证据。用户后续明确只批准模型替换、未批准参数改变；5024/120s/0.2 与理解关闭思考已被要求修复，现行行为见 [模型配置](model-configuration.md)。评分恢复上游显式参数，理解恢复 enabled/low；不采用曾提出但未应用的16384评分上限。

用户明确要求：“将 backfill 阶段需要用 GLM-5.3-Flash 的地方，都修改配置为用 DeepSeek-V4.1-Flash 完成”。本决定经一轮 L1 独立审查，替代 [2026-10-02 启动决定](20261002-backfill-launch.md)的 GLM 订阅路由，以及后来仅摘要使用腾讯 VOD 的范围；其它历史隔离、原文审核、预算和回执要求继续有效。

评分使用已有 `deepseek-v4.1-flash-think` preset；理解和摘要共用非思考 `deepseek-v4.1-flash` preset。三个角色均绑定唯一 `company_tencent_vod/deepseek-v4.1-flash/stream`，实际模型 `openai/deepseek-v4.1-flash`，账户资金归属 `company_paid`。预筛和结构继续自托管 Qwen；实时模型配置保持原值。请求仍走个人 Gateway 的 `aihot` 双归属项目，无新增供应商凭据。

没有仅替换 binding 后继续继承 GLM 参数：使用对应 DeepSeek preset 才能选择其思考开关和预算。评分沿用现有非 GLM 调用默认值，包含 4000 思考预算后的请求上限为 5024 tokens、超时 120 秒、temperature 0.2；不声称与原 GLM 高推理档或评分分布等价。

切换前生产所有回填批次均已终态，回填 service inactive；停止 timer 后修改默认配置及 9 月 30 日自动导入所读取的共享配置。已完成批次的模型绑定、结果和回执保留，不触发重算。理解和摘要绑定相等由 schema 保证，避免共享 preset 查找绑定时产生歧义；新 GLM 绑定被拒绝。

部署验收需分别核对线上源文件和自动导入配置、Gateway 预检，以及新评分和理解的实际请求回执。旧腾讯摘要成功记录只能证明该路由曾成功，不能代替新角色验证；此记录不把每日覆盖批次等同于全部原始历史已回填。

2026-10-02 22:56 UTC，在腾讯云待发布目录、独立库 `aihot_deepseek_switch_live_ci` 运行原生 `runAnalysis`：1 篇 GPT-4 文本样例，无图、无引用，预筛与结构各 1 次自托管 Qwen，评分 2 次和理解 1 次腾讯 DeepSeek。按 request ID 关联 Gateway 得到 5 次 success；三次 DeepSeek 均为 `company_paid`，两次评分为 93、89，理解返回并通过原生解析。评分请求实际为 5024 tokens、temperature 0.2；理解为 16384 tokens。未写文章业务结果，隔离库回执停在 `received`，不把它们计作正式回填完成。证据在主 checkout `.data/backfill-full-run-20261002/deepseek-role-probe.json` 与 `deepseek-role-ledger.json`，不入 Git。该样例只证明此文本输入上的调用和解析兼容，不证明评分质量等价、图像理解或长期稳定性。

本机 Node 26.8.1、独立空 PostgreSQL 测试库和本地模拟模型：后端现有 207 项测试通过，覆盖回填五角色、拒绝非法路由、未知回执、暂停与并发绑定等；另有 typecheck、Web 构建及 11 项 Web 测试通过。独立审查未发现阻塞项。

2026-10-03 15:08～15:11 +08，统一全量回填首次执行 64 条新闻，33 条到正常终态、31 条异常。55 次评分请求中 9 次返回 `finish_reason=length`、正文为空、5024 个输出 token 全为 reasoning；逐 request ID 关联 Gateway 均为已派发的 `OutputTruncatedError`，不是未派发的路由错误。该读数说明上面的单文本探针不能代表实际全量运行，5024 上限存在已观测的截断失败。统一 run 已暂停领取，原请求、usage 与未知费用保留，不自动重放。评分预算修复及恢复仍待裁决，不能把本记录的旧参数当作已验证适用于全量。证据位于主 checkout `.data/backfill-full-run-20261002/unified-first-run-ledger.json`；统一范围与完成口径见 [plan](../../plans/20261003-unified-history-backfill/plan.md)。
