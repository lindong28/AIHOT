# 回执业务结案与错误详情

状态：已采纳，2026-10-04。来源：用户要求立即实施新版结案、错误详情、审核拒绝不重复重放三项优化。独立决策审查一轮、两处定向修正后放行；实现与生产验收另行记录。

旧 article revision 的异常可以由同一 article 当前 revision 的完成结果结案：当前 revision 不小于捕获版本、publication 引用的 analysis 输入版本等于当前版本、文章处于 analyzed/blocked、分析时间不早于原回执。仅版本号增长不足以结案。结案证据记录 captured/current revision；不把 publication 自身 revision 当作文章输入版本。后续 failed/unknown attempt 仍阻止旧结果掩盖新异常。

planned/queued 和因版本冲突、内容审核拒绝而 blocked 的记录都可重新核对业务证据。审核拒绝不再通过批量脚本授权重放，但以后出现合格业务结果仍可结案。历史 receipt_attempts 和未知费用原样保留。

Gateway 仅透出白名单结构化失败信息；AIHOT 按 attempt 保存 HTTP 状态、已知 provider code、类别、retryable 和可选审核 role/level。未知值保留未知；不保存上游自由文本、URL 或 prompt。错误详情头不属于调用身份，不参与是否已经派发的判定。普通 429 只说明限流，不能证明额度耗尽。

选择证据驱动结案而非直接把旧 receipt 改为成功，避免改写账单事实；选择安全错误投影而非完整上游错误，避免凭据外泄；选择精确审核拒绝分类而非跳过所有 4xx，避免误伤可恢复失败。本次不调整 provider、冷却策略或重试预算。

验证：隔离 PostgreSQL 中覆盖同版本/新版成功、仅 revision 增长、publication 仍引用旧分析、后续未知 attempt、历史/结构化审核拒绝、回填目标交叠及重复结案；native/compat 错误保存、错误头不冒充身份、无效字段与未知 429 均有离线用例。独立实现审查发现的交叠目标绕过与类型校验问题已修复。类型检查、Web 构建和测试通过；本地认证后台实际读取三类回执，展开请求标识可用。以上是本地验证，未代表生产部署或真实 provider 恢复效果。
