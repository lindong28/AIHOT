# State — 私有语义资料查询

Mutable snapshot。用户授权分阶段实现、验收并持续迭代；2026-11-11额外明确生产必须持续在线。任务材料 ~/task-artifacts/AIHOT/20261111-semantic-research-6af0/，入口README；原通用search harness工作已经完成，不重开。

## Tasks

- [done] S1/S2 后端/API/CLI纵向实现、权限/幂等/失效及隔离验证。正式v3显式semantic，旧v1/v2关键词保持；publication revision基线bug修复。后端检查点f8547ddda2747c229a44c644e49767c264e0b670，客户端91ab0400506aed97f2515e3382fcb98506675f8b；均在私有分支，未发布/整合。
- [in_progress] S3 有界比较：归档正式API+CLI已24次，8题=1真实+5构造+2对照，1896资料1533向量363缺；原问题dense3/8、重写关键词92/105；原句关键词超过6词拒绝，不是无匹配。5篇全文/URL逐字节对照通过，缺向量文章仍可关键词回读。实际provider/覆盖/费用与独立consumer待验。
- [pending] S4 独立agent普通正式CLI任务：真实编码与回读，不能喂答案ID，不用归档stub冒充生产。
- [in_progress] S5 检查/审查/发布：source全新semantic_full_test下528/528，typecheck、Web build、19Web tests通过；本机smoke31通过、3未发布榜单按原契约跳过。CLI原26全套通过，路径fix后10semantic通过（17旧测试可复用）；MEDIUM路径别名覆盖已修。HIGH实际Gateway身份未绑定已修并经原reviewer定向关闭：单route限制和持久回执身份复验，新增4项Gateway测试、原13项semantic回归及typecheck通过。准备私分支检查点，尚未发布。
- [in_progress] D2 在线部署：11文件已移交集成，旧Wechat依赖联动测试更新为独立管理入口；全新semantic_acceptance_test下完整533/533、0skip，typecheck通过。首轮审查2HIGH+1MEDIUM（切流失败无验证回滚、旧unit自动重启竞态、active索引提交失败无法续跑）已在parent source修复，4红→24绿；复核新增回退覆盖外部Nginx配置的MEDIUM，已增加写前归属检查，实际resume先红后绿共25项，原reviewer定向确认四种场景关闭且无新增finding，见research/deployment-change-review.md。冻结deployment-source保留原输入。真实Nginx1.24/systemd现场和公网连续窗口待验。生产仅创建未载入的shared/semantic-research-20261111.env（8键、0600、现有身份/profile匹配），旧app.env/服务未动；无新模型请求。
- [pending] 最终实际diff核心算法合并判断：搜索质量仍需S3/S4；如确需用户批准，准备具体版本和观察收益/不足后经MCP询问。普通部署授权已在，不重复询问维护要求。

## Open Issues / 恢复句柄

- parent source/client-source私树lease和taskrecord见任务README。backend-source和deployment-source均已移交parent并释放锁；部署冻结11文件是当前review输入，审查期间不得修改该输入。后续修复在parent source，自有并发边界保留。
- parent session 01a1c9c1-599f-7c93-bedf-ad6827b65e6b；当前没有pending用户问题，持续在线已答。
- PG17 task/postgres在完成所有本地DB测试后已于14:43UTC由pg_ctl fast stop，exec6485确认task_postgres_exit 0。无在飞本地DB/测试进程。数据目录仍保全，可在确需补测时用同一自限入口恢复；全suite须新建空*_test库，不复用旧测试残留。
- replay server exec65563，PID7819已发SIGTERM并核退出0；缓存8条旧query vectors回放全部完成，无外调。本机Web smoke及全suite/构建/CLI测试均已退出。
- 真实provider：13:48 UTC正式Gateway discovery为project=aihot、v4、logical_model scope、ready，唯一eligible路线dashscope/personal_dashscope/text-embedding-v4/stream/openai/text-embedding-v4，三registry revision一致。固定早期/近期各6条回执与1024维存量向量逐float32相等；仪器两项MEDIUM修复经独立定向复核关闭。仅12样本，不外推全库来源或隐藏权重。新实际付费调用尚未发生；生产仅有上述未载入候选配置文件。
- production-vector-metadata.json当前1912篇，1549vector+363missing；publicationRevisionDiffers1682仅不同计数器，不能说过期。原现场gateway_configured:false是查错变量的诊断误报，current-provider-config.json已纠正true。
- review报告语义入口在research/semantic-review/report.md；部署review结论在research/deployment-decision-review.md，证据由worker文件接续。恢复后先接agent消息，不因summary重跑已通过检查。
