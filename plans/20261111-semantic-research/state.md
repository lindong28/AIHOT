# State — 私有语义资料查询

Mutable snapshot。用户授权分阶段实现、验收并持续迭代；2026-11-11额外明确生产必须持续在线。任务材料 ~/task-artifacts/AIHOT/20261111-semantic-research-6af0/，入口README；原通用search harness工作已经完成，不重开。

## Tasks

- [done] S1/S2 后端/API/CLI纵向实现、权限/幂等/失效及隔离验证。正式v3显式semantic，旧v1/v2关键词保持；publication revision基线bug修复。全部源码尚未commit。
- [in_progress] S3 有界比较：归档正式API+CLI已24次，8题=1真实+5构造+2对照，1896资料1533向量363缺；原问题dense3/8、重写关键词92/105；原句关键词超过6词拒绝，不是无匹配。5篇全文/URL逐字节对照通过，缺向量文章仍可关键词回读。实际provider/覆盖/费用与独立consumer待验。
- [pending] S4 独立agent普通正式CLI任务：真实编码与回读，不能喂答案ID，不用归档stub冒充生产。
- [in_progress] S5 检查/审查/发布：source全新semantic_full_test下528/528，typecheck、Web build、19Web tests通过；本机smoke31通过、3未发布榜单按原契约跳过。CLI原26全套通过，路径fix后10semantic通过（17旧测试可复用）；MEDIUM路径别名覆盖已修。HIGH实际Gateway身份未绑定已修并经原reviewer定向关闭：单route限制和持久回执身份复验，新增4项Gateway测试、原13项semantic回归及typecheck通过。准备私分支检查点，尚未发布。
- [in_progress] D2 在线部署：semantic_backend_build在独立deployment-source实现，semantic_decision_review已放行实现与隔离验收。首次inspector现有boss排空已Node24.21+26/PG17/pgboss12.34演练；HTTP真实Nginx1.31.2/Node24演练保留延后SSR和短MCP请求、结束订阅并重连新槽，先旧Web后旧API退出。真实Nginx1.24现场及完整执行器待验。worker拟提供stage固定候选API/Web+semantic-only gate；parent真实查询验收后resume排空旧业务worker、启用新队列再切流。生产尚未写入。
- [pending] 最终实际diff核心算法合并判断：搜索质量仍需S3/S4；如确需用户批准，准备具体版本和观察收益/不足后经MCP询问。普通部署授权已在，不重复询问维护要求。

## Open Issues / 恢复句柄

- parent source/client-source私树lease和taskrecord见任务README。backend-source已移交parent并释放锁；已逐文件复制9文件SHA一致。parent不能覆写deployment worker拥有的文件。
- parent session 01a1c9c1-599f-7c93-bedf-ad6827b65e6b；当前没有pending用户问题，持续在线已答。
- PG17 task/postgres PID22431，exec6485，10800秒硬上限（13:22UTC时已运行57分钟）；127.0.0.1:55461。semantic_test为旧失败残留，不能跑全suite；semantic_full_test本轮全suite已终态；semantic_replay_test只供回放。结束后pg_ctl -D任务/postgres -m fast stop并核6485退出。
- replay server exec65563，PID7819已发SIGTERM，待核退出；缓存8条旧query vectors回放全部完成，无外调。本机Web smoke及全suite/构建/CLI测试均已退出。
- 真实provider：生产Gateway配置存在，project=aihot，v4/1024；旧两次回执provider=dashscope，route=personal_dashscope/text-embedding-v4/stream，actual_model=openai/text-embedding-v4。新实际付费调用尚未发生，生产无本轮写入。
- production-vector-metadata.json当前1912篇，1549vector+363missing；publicationRevisionDiffers1682仅不同计数器，不能说过期。原现场gateway_configured:false是查错变量的诊断误报，current-provider-config.json已纠正true。
- review报告语义入口在research/semantic-review/report.md；部署review结论在research/deployment-decision-review.md，证据由worker文件接续。恢复后先接agent消息，不因summary重跑已通过检查。
