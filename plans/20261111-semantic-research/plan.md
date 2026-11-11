> ⚠️ **Long-task mode** — 本 plan 处于长任务模式
> - 进度状态：`./state.md`
> - 决策日志：`./journal.md`
> - 协议详情：`~/.claude/skills/task-workflows/references/long-task-protocol.md`
>
> 实施时（含 compact 之后）必须先读 state.md 和 journal.md 再决定下一步动作。
> 声称任务完成前必须实际跑本 plan 中当前已确认范围适用的 verify 步骤并贴出输出。

# 私有研究语义查询

状态：实施中；基线 a0f54a80cc8e544955a188ce1a0542e77fab041e；任务材料 `~/task-artifacts/AIHOT/20261111-semantic-research-6af0/`。本计划承接用户 2026-11-11 的“现在就按照以上建议完成分阶段的推进和验收……持续迭代直到验收结果达到预期”，不重新打开已经完成的通用搜索 harness 建设。

## 目标与接受条件

用户要从 AI Radar 已存资料找回记忆中的文章，并在其他真实查询中继续使用。已接受方案：正式私有 API 和共享 query-aihot CLI 显式提供语义查询，保留关键词；复用既有向量与项目 provider/receipt，保持来源、分组、时间、权限与正文回读；混合公式、正文分块及回填由真实查询漏检证据决定。生产留在 AIHOT TypeScript/PostgreSQL，通用 Python search-infra 仅作可选离线比较。用户未给其他明确排除项。

最短正常消费路径：agent 发现来源/时间范围 → CLI 关键词或显式语义查询 → 服务端现有 worker 编码查询 → 读取当前可访问候选及向量覆盖 → 原正式 read 入口核正文和链接。不会因使用语义检索而自动向全库补向量或抓原网站。

| 阶段 | 产物及验证 | 完成条件 |
| --- | --- | --- |
| S1 正式入口 | API/worker/CLI 最小纵向路径 | 关键词原契约保持；语义可提交、恢复轮询、返回候选、回读正文 |
| S2 数据与权限 | 身份、覆盖、失效与任务生命周期 | 时间/来源/组等过滤一致；缺失、过时、维度错误分开；撤回/限制即时生效；无模型、失败、预算/unknown 与过期不伪装成无匹配 |
| S3 有界比较 | 原实际文章查询、可取得的其他真实任务；必要的构造诊断另标 | 同过滤集合比较关键词与语义，记录排名、查询/回读次数、时延和已知/未知成本；混合、分块、回填各有采用或暂缓证据 |
| S4 正常消费者 | 独立 agent 使用正式 CLI 查找并回读 | 不给答案 ID；找到来源并核内容；记录实际入口、读量、失败接续及剩余质量边界 |
| S5 交付 | 项目检查、变更审查、文档、分发及适用部署 | 发布版本与消费者证据对应；主线合并按实际策略风险判断人工批准边界，不以局部测试代替完整交付 |

## 接入决定（D1，2026-11-11 L1 独立评审放行）

决定在现有私有 API 增加明确的异步语义查询，而不在 HTTP/CLI 直接调用模型。保留现有只读 bearer 权限；新增 `RESEARCH_SEMANTIC_TOKEN_SHA256` 显式列出允许提交编码任务的既有 research token 摘要，提交须同时具备读取及编码资格，旧配置不获得付费能力。查询归属绑定当前 bearer 摘要；GET 仍要求有效 research 身份和所属任务，ID 不是权限凭证。能力关闭/撤销不泄露其他任务。

复用 pg-boss 保存短期查询、编码结果与 receipt 引用，不新增独立搜索服务或重复资料库。客户端提供 UUID 和 createdAt，二者共同组成完整请求身份；保留窗口内同一 owner/requestId 不同 payload 冲突，创建后24小时内完整身份重复提交返回原任务，不重付费。记录清理后，同 UUID 配新 createdAt 是新的请求，不承诺永久 UUID 冲突；CLI 恢复必须使用原完整 envelope，不能自动更新 createdAt。超过24小时的 createdAt 在任务删除后仍拒绝重建，未来时间只允许明确时钟偏差。任务声明 expiresAt 并拒绝过期结果；队列自身按有效窗口及有界清理留存。receipt identity 纳入 owner、requestId、createdAt 和 embedding profile，重启沿同一付费身份恢复，不跨任务隐藏复用。单次 query 有长度上限，提交容量有界；复用现有 worker 预算/回执恢复，unknown 不以换 ID 重放。查询编码只做一次 embedding；向量不匹配/不可用时明确失败，不调用词面替身伪装语义成功。

排名采用同模型、同维度、有限非零且当前标题/摘要 hash 匹配的存量 article vectors 的 cosine top-k。复用 reportText（标题+摘要前300 UTF-16 code units）与 reportTexts 的标题/摘要来源顺序，publication.revision 是独立投影变更计数，不能与 article/research revision 比较；有 analysis 时以 p.analysis_id 对应同 article 的 input_revision 核当前输入，无 analysis 时保留合法 raw/manual 读取与 selected。语义表示另按当前 raw/manual 或当前 analysis 文本重算 hash；正文只在现有 read 入口消费。读取实时应用现有 source/group/time/selected/withdrawn/restricted 规则；不缓存文章正文或权限快照。限制或 discarded 资料不让隐藏文本参与语义排名。存量表示空间只在已核 provider/logical-model 映射、固定 model/dims/title-summary-v1 profile 下启用；上线前可作有界重编码核对，抽样兼容证据不冒充全库 provenance。profile 未核时功能保持不可用，不能仅凭模型同名同维默认兼容。覆盖以同一过滤集合为分母，并明确可用、缺失、陈旧、不兼容。结果带表示身份和分数，分数不是相关概率，不造正文命中片段。排名实际工作量先在隔离数据库与历史真实子集测量；不预设新向量数据库/索引或无依据的延迟 SLA。

备选：同步 API 编码违反项目 worker-only 边界；CLI 自行编码绕开项目 provider/receipt 与既有出口；另建 Python/SQLite 服务复制权限和索引生命周期；新建独立业务查询表目前与 pg-boss 短期状态重复。pg-boss 原生任务/结果可用性来自已安装 12.34.0 类型和既有测试定义，跨终态幂等、清理及重启仍待实测；若不能兑现，则先指出具体缺口再调整必要持久层。

范围：只扩展私有研究入口及共享客户端，不改公开站排序、文章生成、归组或采集。现有只读入口继续无模型调用。新增授权配置、短期 query 状态与有限查询费用均服务已批准语义功能；不扩展其他读取 token 权限，不新建凭据载体。客户端改动归 ai-agent-config 的 connector-workflows，生产后端归本仓。

既有决策语料：AIHOT 无 docs/adr 或 docs/decisions.md；相关权威为 plans、docs/private-research-api.md 与 docs/issues。对 RESEARCH_TOKEN_SHA256、query-aihot、semantic/research-model 定向检索命中 20261013 私有 API 及 20261031 查询扩展：前者2026-10-13已有生产108篇正文/鉴权验收，后者2026-10-31保留只读、人工限制、完整性及 live 游标，生产11篇正文与34项smoke。ai-agent-config docs/adr、docs/issues 对 query-aihot/RESEARCH_TOKEN_SHA256/private-article-research 无命中，能力权威为 connector-workflows/references/query-aihot.md。新能力不改变旧只读端点；模型只在 worker 是当前 AGENTS 硬边界。

已取得机制证据：路径探索在任务 research/path-exploration.md；旧有界试验在 `~/task-artifacts/standalone/20261111-ai-radar-retrieval-astra-6af0/REPORT.md`。2026-11-11 快照1896篇、1533既有1024维v4向量，标题/摘要hash匹配；一条真实任务和构造诊断不能证明全分布效果。旧试验已知目标的 dense 首命中3、关键词时间序92，说明值得接入；不将这些离线数当新入口时延/全库效果。hash、权限变更、维度和模型失败均可用正反样本产生不同读数；实际 agent 必须经正式入口验证而非只看离线排名。

未验证：新 API/worker 幂等和生命周期、当前生产模型/向量覆盖、成本账、生产资源与可用性要求、新 CLI 普通任务完成时间。测试/审查来源：项目既定检查；权限/付费状态边界取 V2 的受影响失效域；独立消费者及上述边界来自用户批准的验收，不追加全库 benchmark、长期判官或无根据 SLA。

评审结果：semantic_decision_review（gpt-6-astra/xhigh）七判据成立。保留窗口幂等、当前修订及表示空间边界已经补明，无阻断项。提交容量不等于费用限额：启用须核实际 embedding service budget 与既有消费者共享影响。定向复核纠正了此前“旧分组未核 publication revision”的错误归因：两种 revision 不同义。共享 research/read 的等值 join 才是边界命中的基线缺陷，本轮局部修复，保留无 analysis 的 raw/manual 合法投影；非 Gateway 校验差异只在新语义路径补齐，不扩大原分组策略。v1/v2 已发布契约保持；新语义入口位于 v3，复用 v2 读接口投影。CLI 关键词默认仍 v2，新 semantic 命令默认 v3；显式不兼容版本拒绝而非降级。

## 执行与材料

主线程负责决定、集成、真实验收和交付。明确分区的实现/独立审查按 task-routing 选择原生代理；源码写入本 session 私树并持占用，跨仓客户端另建私树。隔离 PostgreSQL 使用任务目录和独立端口/*_test 数据库；本地测试默认所有外部调用开关关闭。真实模型请求仅沿项目部署既有入口与预算，保留回执；部署前读取实时版本/任务、维护可用性与资源，保护在途付费工作。

原始结果保存在统一任务材料目录，项目文档只保留复用结论与导航。新证据仅调整受影响阶段；不得把构造样本写为真实需求，也不得把暂缓混合/分块/回填写为永远不需要。

## 新增部署约束（用户2026-11-11明确）

腾讯云AI Radar升级必须持续在线。保持原搜索交付范围，增加完成发布所需的单机在线交接：候选固定release准备、业务检查、Nginx切流和失败恢复、旧HTTP及worker在途排空。不得沿旧install直接restart。API/Web现场a0f54a8，worker仍45b6447；完整旧新worker并行违反group localConcurrency:1依赖。首次legacy无安全停取入口，正在隔离验证临时loopback inspector取现有boss并offWork；后续用正式drain。原D1搜索决定不重开，部署D2定向review及证据见任务research/deployment-progress.md。
