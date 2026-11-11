# State — 私有语义资料查询

用户授权分阶段实现、验收并持续迭代；生产必须持续在线。任务入口 `~/task-artifacts/AIHOT/20261111-semantic-research-6af0/README.md`。前轮通用 search harness 已完成，不重开。用户已经MCP批准PR1固定5e505，首个在线release已installed/cleanup complete；正在发布现场发现的TLS续期工程修复，最终公网消费验收和文档收尾仍待完成。

## 阶段

- S1/S2 已完成本地工程与候选真实消费：API v3显式语义、原v1/v2关键词/回读，权限/来源/组/时间、覆盖及恢复。后端5e505d71b266d4ef272c352b58bc5e6283df7397已发布main；客户端91ab基于新main无冲突rebase为a3a67c302c16fba87726539089e5aa8ad46e4f38，三份实现/测试/说明blob相同，已整合并发布main。源码仍只在自有私树开发。
- S3 已完成有界比较：归档24次+当前8题（1真实、5构造、2对照）；45来源、10/01–11/12，1917资料/1554有效向量/363缺。原问题两候选关键词93/106、语义3/8；8编码回执228tokens，费用全部unknown。初次关键词30秒超时保留，完整重试2.25秒；根因未核实，不称修好。混合/正文分块/回填维持本轮不启用，理由见journal及acceptance/report.md。
- S4 已完成独立消费者：未提供答案ID；1sources、6search、3semantic+1同身份resume、7read；三回执89tokens、费用unknown。严格月窗口未确认全部三项满足；扩展窗找到两强候选，月费/额度有正文，单价和图像未核。semantic超时同身份恢复成立，关键词一次超时后缩小范围成功。全原始材料在acceptance/independent-consumer/，父线程已核两候选正文承重段落，不把API等值金额当单价。
- S5 工程审查已完成：全新DB完整533/533无skip、typecheck、web build、19web tests；部署控制25/25。CLI27项等价覆盖。5e505的feature CI43045553067及main CI43048857254均check/docker成功。原reviewer关闭部署、来源、仪器及runner问题；新ACME路径及恢复观察器已定向审查无finding，新增排空诊断文本及成功后清除旧reason已定向审查，无新增finding；首次超时根因仍未知。
- 分发：AIHOT PR https://github.com/lindong28/AIHOT/pull/1 的固定5e505已发布main，首release完成；客户端a3a67c30已发布main。自动CI run未出现，已有workflow_dispatch固定SHA检查成功，不能称自动触发已修复。
- 人工合并边界：MCP approve_aihot_semantic_main明确批准5e505，原始回执acceptance/main-approval.json；后续TLS与诊断工程修复不改语义策略，无新算法批准请求。

## 生产与进程恢复

- 首release `/home/ubuntu/aihot/releases/semantic-research-20261111-5e505d7`，ID `066b2630-3d1a-4a3a-bf9e-cc3f57538290`，蓝槽3101/3100，API/Web/全业务worker PID454584/454585/454586；release installed/cleanup complete，旧API/Web/worker已按入口排空停止。766源码文件内容/执行位与固定Git归档一致。证书原11月7日过期，经临时HTTPS ACME修复和单域续期已有效至2027-02-09；原配置恢复后续跑同ID。永久ACME修复待下一固定release，以免后续切流覆盖。
- 候选启动使用独立shared/semantic-research-20261111.env（0600八键），不改原app.env/web.env；固定provider/route/model/profile/dims/registry，真实8回执来源匹配。identity13项0diff、隐藏权重unknown、live语料非固定快照；不扩大兼容性证明。
- 本机SSH forward exec58513/PID92815已自限退出0。独立查询已完成，无待付费请求。PG17和回放server已确认退出，数据保全。
- 有限CI wait exec30616：repo-ci wait固定43045553067、1500秒上限，已exit0；结果acceptance/ci-feature-result.json。旧默认push observer已cancel并确认stopped_at_task_boundary，manifest在acceptance/ci-branch/5dd18e1326c2401ab3f37451bb8b51f8/。
- 原continuity exec4991已结束，首次见新版本后30秒退出早于完整收尾，因此只认该窗口。恢复观察器exec76685从15:35:55UTC运行900秒上限，需最终发布后由caller回收；三HTTP入口暂无请求失败，公网SSE有TypeError中断但可重新ACK，不宣称无订阅中断或全部由切流导致。首次旧API排空RPC超时，诊断副本原身份恢复成功，首个具体超时方法未核，不称根因修好；随后原release resume完成。
- 源码两私树lease/taskrecord见任务README；backend-source/deployment-source已移交释放、保留冻结输入。parent session01a1c9c1-599f-7c93-bedf-ad6827b65e6b。

## 未完成与归属

- 用户：无待答问题。parent：发布并部署永久HTTPS ACME修复、核最终公网API/已安装共享CLI、连续采样和后台业务、完成文档提交及资源收尾。
- 已知基线凭据恢复缺口：research.env经~/.config symlink落system-config，0600但未tracked/ignored且无已登记备份，project-credentials报unignored_target_refused；归system-config凭据维护，本轮不擅自迁移。真实查询能用不代表新机可恢复。
- 原文章完全确认仍缺图片单价；原始任务这里用作检索消费验收，报告候选与边界，不将不完整证据写成完全命中。Draco图片候选保留07-read.json；图片核读不属于本次检索入口实现，不擅自改采集或补正文。
- 初次关键词超时及独立消费者两次超时保留原始退出/时长，尚无根因证据；这不等于新入口恒快。候选可恢复查询已实际完成，后续生产观察继续同一请求身份。
