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

## 15:14 UTC 真实验收与发布准备

5e505候选已stage，766源码文件与git归档内容/执行位一致；归档664与提取644的初次mode断言不适用，内容未变且可执行位一致，已保留差异及修正说明。真实8题保留全部请求/回执，228tokens、金额unknown，语义3/8、关键词93/106；同45来源1917/1554/363，不能与旧1896快照混称同数据。首次关键词30.08秒超时，直接旧/新一页4.635/5.469秒、正式完整重试2.252秒；未核根因，不用成功重试消除失败证据。runner允许keyword的exit3且traversalComplete=true保留live变化；semantic非零仍停止，独立40组合核对关闭。

独立消费者无答案ID完成1sources/6search/3semantic+1同身份resume/7read；严格月窗口未确认完整三项，扩展窗口找到两强候选，正文只有月费、token总额度和API等值，不能冒充token单价。三编码89tokens、费用unknown。原月窗全来源23190/13344可用/1097缺/143stale/8606policyExcluded；扩展窗126902/3955/46476/8/76463，范围与覆盖不同，不能把45来源样本说成全库。图文候选和7篇正文完整性unverified已记录，parent核两篇承重文字。

持续性观察器3项MEDIUM（首页判据、SSE真实ACK、连接/ACK超时及取消记账）已修并经原reviewer关闭，仍未真实切流。PR1已建、分支5e505已push；自动PR run未出现，沿现有workflow_dispatch启动43045553067，固定SHA检查及Docker两jobs。原默认push observer因入口不同取消，终态已核，不等待不存在的push run。

具体新增语义候选排序仍只有一真实任务的分布质量证据，按用户AGENTS核心算法条款保留分支，准备完整版本与局限后请求最终合并批准。公开生产仍旧版本，候选仅新增semantic队列，不改原业务队列。

## 15:37 UTC 批准与生产续跑

用户经MCP approve_aihot_semantic_main明确批准PR1固定5e505合入main及配套CLI、持续在线发布，原回执在acceptance/main-approval.json。5e505已快进main并普通push，实际远端及tracking相等；feature CI43045553067和main CI43048857254的check/docker均success。客户端在新基线491e6bc无冲突rebase为a3a67c30，三份CLI/文档/测试blob与91ab一致，SKILL保留别人的Lark上下文；已整合本地main待push。

首次resume保留两HTTP实例并停在switch：严格源站TLS报告证书11月7日过期。现有webroot本机HTTP200，公网EdgeOne强制HTTPS后404；certbot timer多次续期失败。临时在HTTPS news配置增加相同ACME webroot，保存原文件并持发布锁；公网HTTP跟随重定向及HTTPS验证文件逐字匹配，随后既有certbot renew单域成功。恢复发布保存的原配置后续跑原ID；没有关闭TLS、换出口或新建付费查询身份。永久修复将随第二固定release发布，不改获批语义策略。

首次连续观察见新release30秒后退出早于完整收尾；保留原窗口，并采用900秒上限、由caller在发布终态后收回的恢复窗口。原reviewer定向核HTTPS路径与仪器两处差量均无finding；公网挑战及续期由parent核实。TLS修复决定L0：既定公开webroot行为、明确404→200证据及原配置回退点；生产必要恢复优先完成，随后持久化修复。
