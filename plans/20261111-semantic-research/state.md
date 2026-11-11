# State — 私有语义资料查询

S1–S5实施和验收完成。用户要求生产持续在线；MCP approve_aihot_semantic_main已明确批准PR1固定5e505，回执在任务acceptance/main-approval.json。最终运行18ee663，客户端a3a67c30，两仓main已发布。任务入口：~/task-artifacts/AIHOT/20261111-semantic-research-6af0/README.md；详细结果acceptance/report.md；私树最终回收回执在该入口，不依赖源码目录继续存在。

| 阶段 | 结果与边界 |
| --- | --- |
| S1/S2 | v3显式异步语义、既有worker/Gateway/receipt/budget；v1/v2关键词、过滤和正文回读保持。固定text-embedding-v4/1024/title-summary-v1/provider/route，权限和失效覆盖、同身份恢复及unknown不重付费已验证。12条存量向量float32核对只证明样本兼容，隐藏权重未知 |
| S3 | 8题=1真实+5构造+2对照，45来源、10/01–11/12；1917资料/1554有效/363缺。原问题两候选关键词93/106，语义3/8。原句关键词超过6词限制被拒。构造输入不是实际任务；相似度top-k不提供不存在判定 |
| S4 | 独立消费者未获答案ID，1sources/6search/3semantic+1同身份resume/7read；扩展日期后找到两强候选。严格最近月窗及每百万token单价未确认，图片未核，正文完整性unverified，不能称原文章完全匹配 |
| S5 | 后端533/533无skip、Web19项、typecheck/build、部署25项、CLI27项等价覆盖，具体维度见报告。5e505的feature/main CI及18ee663的main CI均check/docker成功。自动触发未观察到，使用既有workflow_dispatch。共享安装CLI真实公网semantic/resume/search/read完成 |
| 策略取舍 | 本轮不启用默认混合、正文分块、自动回填。RRF有构造例退化；未见真实正文独有漏检；缺向量仍可关键词查询。后续按真实漏检定位范围，不作永久排除 |

## 发布与真实消费

- 后端5e505已按批准合main，PR1已merged；18ee663仅补HTTPS ACME路径、排空诊断及文档。生产release 94703e1c-686f-4175-b165-1be4a2656cc2 installed/cleanup complete，路径/home/ubuntu/aihot/releases/semantic-research-20261111-18ee663。green API/Web/worker PID482985/482986/482987，blue已inactive，调试端口无监听；基础app.env/web.env及semantic配置摘要保持。
- 客户端91ab无冲突rebase至a3a67c30，三份实现/测试/说明blob一致，SKILL保留别人Lark上下文；main与远端相等。正式共享CLI重新查原问题，semantic30.26秒、resume4.05秒、keyword13.96秒、read3.67秒；keyword完整遍历但live变化退出3，不称固定快照。回执687088/47tokens，resume保持同ID/回执；本轮12条查询编码合计364tokens，金额全部unknown，不包含其他业务或更早实验费用。
- 最终切换观察15:46:52–15:49:21UTC，health/home/private各72/72成功；公网旧MCP订阅15:48:06 EOF、新订阅15:48:07 ACK，源站旧槽也ACK→EOF。较长恢复窗口health405/405、home409/409、private403/404，1次TypeError随后恢复；窗口重叠，不能叠加为独立样本。切流前公网SSE还有连接错误并重连，不能称全程零错误。根因未核实。
- 新worker切流后至15:50:51成功fetch43次、4条新资料，embedding/deepseek/llm/zhipu有新完成回执；socialdata4条received单列。业务推进与heartbeat分别取证。
- 源站证书原11月7日过期，EdgeOne强制HTTPS后ACME404。临时恢复并沿原certbot单域续期至2027-02-09；永久HTTPS路径随18ee663部署。最终公开HTTP重定向和HTTPS两探针均200/逐字一致、探针已移除；严格源站TLS健康成功，未变出口或绕过TLS。
- 首次旧API排空RPC超时，同发布ID恢复成功；具体method/root cause未知。新增method诊断和成功清除历史reason已独立审查，无新finding，不称未知根因已修复。

## 收尾与剩余认识

所有查询、隔离数据库、SSH forward、发布、CI wait及连续观察进程已结束；默认CI观察器已取消并核终态。无待答问题，无未处置变更finding。源码提交及查询、失败、回执、审查证据均保全；旧生产release保留为回退材料，不擅自退役。自有及移交私树按任务入口的保全/恢复核验回执回收，分支和提交保留。

以下独立基线或测量边界继续留档：research.env虽0600但经symlink落system-config，未tracked/ignored且未登记备份，恢复检查unignored_target_refused，归system-config凭据维护；原文图片单价、严格月窗匹配及用户端微信可达性未确认，归后续原文核实，不扩为采集工程；关键词/独立查询超时、一次公网GET及SSE连接错误根因未知，归AIHOT运维同类事件诊断，保留原始失败和恢复；外部故障通知仍沿README的AIHOT维护者TODO。当前查询可用不证明新机可恢复或长期无故障。
