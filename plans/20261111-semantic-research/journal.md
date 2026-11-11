# Journal — 私有语义资料查询

## 2026-11-11 决定与纠正

用户批准先加显式语义入口、保留关键词；混合、正文分块、全库回填仍由真实问题决定。只有1条真实问题，构造题不充当独立泛化证据。归档回放API实测dense第三，随机词仍返回top-k，必须正文核实；没有新的已观察漏检支持全量回填或chunk化。

publication.revision为投影变更计数，article/research revision为输入版本。最初把两者等价的诊断错误已撤回；正反例与独立review核实，使用关联analysis.input_revision并保留raw/manual合法分支。全suite须空*_test库且不额外MODEL_CALLS_ENABLED=false（测试自身loopback mock）；错误环境与脏DB失败不算产品代码回归。

持续在线是用户明确要求，不从现有restart脚本推断可停服。现场worker仍45b6447；group依赖单进程localConcurrency1，不能让完整新旧worker并跑。旧195秒shutdown并非整个回调上界，改systemd超时也不能保证；首次迁移须可控停取并结算原WIP。MCP handler.close会关全部inflight请求，不能冒充仅关SSE，需要更窄订阅级drain。

任务在出现生产迁移、两仓发布、不同阶段review和不可重放付费身份后提升long-task，以保全全部原始目标与实际句柄；不是另开program或增加评测范围。

Gateway来源绑定HIGH经复现修复：结构化provider/route/actualModel冻结于任务，单路线约束派发；paidRequest复用response后仍核身份，错配unknown不重付费。registry revision只约束dispatch，不入语义身份；同身份下隐藏权重变化仍不可观测。红测3/3缺预期拒绝，修后4/4（配置缺失3值、首次来源漂移3字段、缓存2状态×4错配/缺失、正式job→worker和registry变化复用）及原semantic13/13、typecheck通过。原reviewer关闭HIGH，未发现修复新增问题。

S3正式API归档回放（旧查询向量，未新编码）共8题：1真实+5构造+2对照。同1896篇过滤集合内1533可用、363缺，标题/摘要表示hash匹配；全文关键词和标题摘要语义表示不同，不能归因为单一算法优劣。原真实问题原句关键词超过6词被拒；“订阅 Token”命中120篇，已知两候选排名92/105；原句语义排名3/8。5条构造题首候选keyword/dense为5/2、18/1、4/1、17/1、4/1；精确标题对照均1，无关随机字串关键词0但语义仍返回100候选，说明top-k不提供不存在判定。4个已知目标及1个缺向量资料均正式read回读，正文与URL匹配快照。语义本机排序166–194ms，整条CLI约1.25秒含轮询与缓存stub，不是实际编码时延。新外部调用0；fixture回执费用null不代表生产免费。

混合：旧有界实验在原问题rank1，但2条构造题出现1→4退化，只有1真实任务不足以新增默认权重；本轮保留显式两入口，不采用自动混合。正文分块：当前原问题标题摘要已召回，尚无真实“证据只在正文而漏召回”样本，暂不增加块索引。回填：363缺向量可见且关键词全文读取仍可用，尚无与用户目标有关的漏检证据，暂不自动全量回填；未来按真实漏检定位范围后再判。这些是本轮有界决定，非永久排除。

13:48 UTC补完固定12条存量向量/回执来源核验及正式Gateway discovery。独立review指出绝对1e-7误差和缺scope字段可能误判；修成双方1024有限number、float32逐项相等并复取同12IDs，补view_scope与project_allowed_logical_model_ids，两项MEDIUM关闭，未发现新问题。早期6条来自10月4日、近期6条11月11日；仅批次首条文章，不是全库provenance。完整原始输出与审查在任务research/vector-provenance-review.md及acceptance目录。

后端检查点f8547ddda2747c229a44c644e49767c264e0b670（15文件）、客户端91ab0400506aed97f2515e3382fcb98506675f8b（4文件）已逐blob核对并保留在自有分支，未push/主线整合。最初后端commit body字面转义已在自有未发布tip立即amend，无代码变化。部署仍由worker独立实现；原PG上限至约15:25UTC，回放server已确认退出0。

下一单元为候选真实API/worker/CLI验证，使用原8题与45来源、同日期过滤在当前语料比较；历史和当前语料身份分开。runner逐题顺序以避免本批竞争污染时延，不以顺序限制普通业务吞吐；每请求保留身份可恢复，失败不换UUID。仪器审查复用独立semantic_change_review，Codex原生/R14 gpt-6-astra high；无wrapper候选，主线程自判不能提供独立视角。仅脚本审查，不触达真实服务/模型。尚未开始真实编码。

补登记研究CLI/API既有凭据入口时，project-credentials发现现有~/.config/aihot/research.env虽为0600，却经~/.config软链接落在system-config/config/aihot/research.env，既未tracked也未ignored，因而安全恢复检查报告unignored_target_refused。未读取/打印值、未复制或更换凭据。本轮既有CLI仍可按授权读取；这不等于新机可恢复。该独立基线问题及未登记备份来源保留在本记录，归system-config凭据维护，不为当前检索功能擅自扩大到另一仓的凭据迁移或发布。

发布恢复三项经定向复核关闭；复核新增MEDIUM：switch拒绝外部配置后，统一rollback会覆盖。parent复现RED，再在switch异常恢复、rollback及健康读取后写前核原配置/候选配置归属；25项控制测试通过，独立复核四场景确认关闭且无新增finding。准备固定候选检查点，stage是正式线上增量发布的候选验收阶段，只启用新增语义队列；不触发旧业务交接或公网切流。
