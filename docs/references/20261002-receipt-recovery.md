# Gateway 回执恢复决定

2026-10-02，用户要求按保留明确失败、核对积压、恢复业务任务三步修复代码。独立决策评审七项通过；实施、本地验证和生产恢复记录如下。

线上初次审计 260 条 unknown：50 条为 Gateway 唯一请求、route_cooldown、零 attempt，其余 210 条包含已派发失败、中断、缺失账本及无可用业务结果的成功。HTTP 状态本身不能证明未计费。

新请求仅识别 Gateway 的精确 `422 / error.code=route_cooldown` 或 `no_route`、无 body/header attempt companion 的拒绝；若带请求 ID 必须匹配。该协议来自 Gateway `_budget_exhausted`、`no_route` 分支和 `ledger.reject_request` 的全 attempt 排除条件。不把单次 attempt 的 not_crossed 当成整个请求未派发。其余错误保留安全的 code 与请求 ID，继续 unknown。

积压核对由维护者在个人 Gateway 主机导出只读 SQLite 一致快照，默认预览；只有项目、模型、当前回执 UUID、最新 attempt UUID 全部匹配，且账本唯一请求本地拒绝、无 active attempt、全部 attempts 为空，才允许事务内放行、恢复任务与写审计。历史 attempt 和未知费用保留，不补零。快照只用于 AIHOT 自行生成且不重发的 UUID：Gateway 自身允许零 attempt 的同 UUID 后续派发，local_rejected 不是全局永久终态。不要把其他调用方或手工重发的 UUID 导入此流程。

分析恢复覆盖预筛、结构、评分、理解、摘要及旧 analyze_article，保留原 attemptTag，并要求文章版本仍匹配、状态 failed、非受管 backfill。分组和事件综述恢复各自队列；监控识别由现有 tick 恢复。未支持用途显式返回未自动恢复，不猜测任务。backfill 仍由独立 runner 管理。

不选把所有 HTTP 错误自动重试（可能已派发并计费）、新增 Gateway 全局 proof 接口（本次精确拒绝已具备可核验语义）或只清旧数据（不能防复发）。已有未知回执不重试的决策继续生效，未被覆盖。

验证采用隔离 PostgreSQL、HTTP fixture 及真实队列，覆盖明确拒绝/不确定响应、身份与项目不符、已有 attempt、重复应用、业务任务恢复及原子回滚。资金与数据完整性取 V2、一轮独立实现审查；生产只应用实账本支持的条目。告警继续由现有运行页与运维摘要消费失败/未知回执，不新增独立服务。

## 实现与本地验证

独立实现审查指出并修正两项：真实分组错误也会写 grouped_at，因此恢复使用普通分组入口的人工/既有归属保护，不用该时间作为成功证明；新增 processing_attempt_tag 增量迁移，使冷却后的定时分析重试保留原管理员运行标识。核对 CLI 等待同组全部事务终态，逐条报告后才因错误停止后续组，避免已经提交的结果漏报。定向复核通过，无遗留 finding。

本机隔离数据库 aihot_receipts_ci 完整测试 203 个通过，Web 原有 11 个测试通过，类型检查与 Web 构建通过。新增恢复用例 22 个覆盖七种分析阶段/评分票标识、九种不合格证据、普通/管理员标识、当前/过期版本、实时/backfill、分析/分组/信号/综述/监控用途，以及队列写入失败回滚。另通过真实 worker handler 验证 cooldown→sweep→同一回执完成、通过真实 groupArticle 验证失败先写 grouped_at 后仍可恢复；Gateway fixture 覆盖成功、压缩、身份异常、断流、明确拒绝及单 attempt 证明不足。没有在测试中调用外部模型。

## 生产核对

第一批核对 268 条，58 条满足未派发条件（50 条冷却、8 条无路由），事务内恢复 54 个分析、3 个分组和 1 个综述任务。其余 210 条保留 unknown：107 条派发失败、48 条中断不确定、54 条账本缺失或不唯一、1 条上游成功但没有可复用的业务响应。这些不能当成未计费，也不能仅凭上游 success 自动完成文章。

恢复期间发现新 `no_route` 拒绝：个人 Gateway 的 DeepSeek-V4-Flash-0731 实例在 2026-10-02 12:09 UTC 变为 failed，无可用自部署路由。对该精确拒绝的分类扩展另经独立决策与实现复核通过；定向 43 个测试通过，包含两种明确拒绝后使用新 UUID 重试及其余不确定错误仍被拦住。分类修复不代表模型恢复，GPU 部署恢复仍由个人 Gateway 模型部署工作负责，不自动改用未获准的付费路线。

补充修复上线后，第二批核对 247 条，35 条满足未派发条件并恢复任务，两批共执行 93 次放行、覆盖 85 条独立回执（8 条在两次发布之间重新误挂后再次核对）。2026-10-02 12:54:57 UTC 剩余 212 条 unknown；恢复关联的 55 篇文章中 24 篇 analyzed、1 篇 blocked、1 篇 failed、29 篇 new，不能把排队数当完成数。余下 unknown 的后续人工核对由 AIHOT 维护流程负责：156 条无法排除派发，56 条无唯一账本证据；本工具不替代供应商计费/缺失账本证据。

12:55 UTC 实际登录公网 `/admin/runs`，页面显示 212 条 unknown、worker 运行中，分组与综述等待重试；抽查恢复文章 `/items/ar6zfy1shuve2eg3anwqe7m83`，可读中文标题、导读、原文入口和评分。新 `no_route` 回执 13976、14010、14012 已记 failed，逐个对照 Gateway 均为 local_rejected/no_route、零 attempt。12:54 UTC 后截至该次观察没有新增 unknown，不将这一短窗口外推为未来永不出现未知。

并发回填修复 `2dbaf15` 已由另一 session 发布；现场逐文件摘要确认当前 `backfill-content-filter-20261002-r2` 同时含本次 Gateway/回执/任务恢复代码与该回填修复，没有用旧 release 覆盖它。生产 API、Web、worker 均 active。核对 JSON 与应用逐条结果保存在本机忽略目录 `.data/receipt-recovery-20261002/`；长期执行方法见生产运维文档。

与 `2dbaf15` 整合后，按项目要求新建空库 `aihot_receipts_final_ci` 并迁移，完整 204 个测试通过；模块解析现场指向本次隔离工作树。此前一次运行误将本地模型 fixture 一并禁用，修正调用环境后复用脏库又受旧测试行干扰，均未作为验收；最终空库日志为 `final-clean-tests.log`。公网 smoke 覆盖 19 个页面、14 个机器出口及 MCP initialize，全部通过；这些检查证明本次入口与协议可访问，不证明 DeepSeek 模型恢复或剩余历史回执费用已确认。
