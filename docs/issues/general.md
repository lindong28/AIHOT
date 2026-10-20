# 未解决问题

## ISSUE-SOURCE-20261020-youtube-rss：Claude YouTube 官方 RSS 间歇失败

- 状态：open；负责人：AIHOT 维护者。现有 worker 按数据库配置每 60 分钟重试；当前依赖 RSS 服务或可用访问路径恢复，不能将一次重试成功当作稳定修复。
- 2026-10-20 生产 `radar-claude-youtube`：11:09（UTC+8）正式采集成功、发现 15 条；12:09 返回 HTTP 500。13:30 后通过生产 `guardedFetch` 再读为 404/500，响应标识为 `YouTube RSS Feeds server`。Google Developers 对照频道的 RSS 同样返回 500；Mac 代理路径两频道均 404。两代理是否共用公网出口未核实，因此不能断言全球故障；直连请求失败也未进一步归因为 DNS 或防火墙。
- 官方频道页 `https://www.youtube.com/channel/UCV03SRZXJEz-hchIAogeJOg/videos` 返回 200，metadata 的 `externalId` 与来源配置一致，`rssUrl` 仍为现有 `https://www.youtube.com/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg`。频道 ID 错误或官方 RSS 已迁移的假设不获支持；移动域名、裸域名、playlist 和查询参数变体均未恢复读取。
- 不改为仅 videos 页：最近入库 15 个视频 ID 中 10 个在 videos 页、5 个在 shorts 页。条目身份已对应，但精确发布时间、描述与后续覆盖尚未证明等价，既有 `json_list` 的网页 JSON 能力不能据此认定为无损替代。
- 另外核过 4 条已分析文章的空标题：均有 `content_discarded_at`、`visibility=withdrawn`、`eligible=false` 和 `relevance=unknown`，与既有 `content/retention.ts` 的过滤清除行为相符；不将其归为此次 RSS 失败或另开采集缺陷。
- 后续由原调度继续采集；维护者以真实 `fetch_runs` 和后台来源 API 确认恢复。持续失败时再验证其他已有出口；若要用频道网页替代，需同时覆盖 videos/shorts 与准确日期，另行验证后决定，不清零失败状态或跳过文章来伪造成功。

## ISSUE-TEST-20261013-valves：全量测试与关闭模型安全阀的开发约束不一致

- 状态：open；负责人：AIHOT 维护者，后续单独调整测试出口隔离；不属于本次私有资料接口修复。
- 2026-10-13：在独立 PostgreSQL 17 空库迁移后，以 COLLECT_ENABLED=false、MODEL_CALLS_ENABLED=false 和外发阀关闭运行 npm test。未改动基线 33af310 共 380 项，354 通过、26 失败；本次实现首次 387 项，361 通过、26 失败，失败测试集合相同。25 项模型 stub 测试被 MODEL_CALLS_ENABLED=false 拦住，另 1 项由本机默认 Python 3.9 缺 SQLite serialize 造成。
- 保持阀关闭、PATH 优先已安装的 Python 3.14 后，本次修复版完整套件 389 项，364 通过、25 失败；失败名称均包含在未改动基线中。随后定向增加搜索转义回归，私有 HTTP/CLI 10 项全部通过。没有开启真实模型或外部请求来获得全绿。
- 2026-10-20 来源修复复验：全量 400 项为 373 通过、26 失败、1 跳过；Python 3.9 的同一失败在 PATH 优先 Python 3.14 后定向通过，微信与 Claude Blog 相关 14 项全部通过，其余 25 项模型安全阀相关失败仍保留。未开启模型安全阀。
- 后续：用项目测试入口明确 pin 所有付费调用到本机 stub，并解决与项目安全阀约束的冲突；验收应同时证明外部出口不可达及模型场景通过。Python 版本／SQLite 能力需在开发环境说明中固定。

## ISSUE-SOURCE-20261006-openmoss：OpenMOSS 来源待接入

- 状态：open；负责人：AIHOT 维护者。用户于 2026-10-06 明确要求暂不添加，留待后续处理。
- 已知事实：`https://openmoss.ai/blog/cn/` 可解析 12 篇文章的标题及链接；本次列表和已查 MOVA 详情未找到发布时间。当前不创建启用来源，不以抓取时间冒充发布时间。
- 后续：核实官方带日期的 RSS、JSON 或详情元数据；若现有 `web_list`／`json_list` 配置不能表达，再评估站点解析适配。无需仅因该站点新增一种来源类型。
- 范围：本次只补新新闻采集，不做历史 backfill。来源清点见[视频来源补充记录](../references/20261006-video-sources.md)。

## ISSUE-OPS-20261003-4f52：worker 停止等待窗口与 Gateway 请求上限不一致

- 状态：open；负责人：AIHOT 维护者，待后续停止流程修复。本轮暂态错误修复未改变停止策略。
- 已核代码：`deploy/production/aihot-worker.service` 的 `TimeoutStopSec=120`，`jobs/queue.ts` 的 `STOP_TIMEOUT_MS=195000`，Gateway transport 最长 caller deadline 为 560 秒。队列注释声称 systemd 等得更久，与 unit 不符。
- 边界：尚未复现由此产生的历史 unknown，不能把这项差异写成既有 fetch failed 的确证根因。本轮发布在读取 pending 回执为零后停止 worker；没有因此重放旧请求。
- 后续验收：以一个受控在途请求核对停止、回执结算与进程退出的顺序，再统一队列、调用与 systemd 的等待窗口；不只修改注释或通过延迟进程退出宣称已保护付费请求。

## ISSUE-MODEL-20261003-7a21：将上游未显式指定的模型参数记录到配置

- 状态：open；负责人：AIHOT 维护者；按用户 2026-10-03 指示留待后续处理。
- 基线：开源 AIHOT `877d6d5`。`temperature`、`max_tokens`、timeout 在各阶段调用或 `chatJson` 默认分支已有明确值，不能列为“上游未指定”而自行改动。完整现值见 [模型配置](../references/model-configuration.md)。
- 未显式项：除 GLM selection 外各角色的 `top_p`；MiMo、DeepSeek 非思考及 Qwen preset 的 `reasoning_effort`；除 GLM selection 外的 `clear_thinking`；未传入的 provider 原生采样参数。记录时须区分未传、显式值及模型不支持，不用猜测的厂商默认值冒充运行值。
- 后续范围：由用户发起，将这些字段及有效来源集中到相关配置文件，再确认具体值。本次保留原有省略行为，不新增效果调优或每次运行的核验成本。

## ISSUE-MODEL-20261003-c8f4：Gateway embedding 的缺省分支与上游不同

- 状态：open；负责人：AIHOT 维护者。
- 代码：`providers/embeddings.ts` 在 Gateway 路径缺省为 `text-embedding-3-small`、dimensions=0；上游无自有 embedding key 时缺省为 `text-embedding-v4`、1024。
- 当前影响：2026-10-03 生产 `app.env` 明确指定 `EMBEDDING_MODEL=text-embedding-v4`、`EMBEDDING_DIMS=1024`，运行值对齐；Gateway 下未配置模型时 `embeddingsAvailable()` 返回 false，不能把代码 fallback 当作已发生的外部调用。
- 后续：调整缺省配置时按上游语义与 Gateway 接入契约核对；当前不更换线上 embedding，也不重建历史向量。

## ISSUE-WECHAT-20261012-body-alert：公众号正文失败的及时告警

- 状态：open；负责人：AIHOT 维护者。
- 观察：正文空壳现在使 Wechat2RSS 的 fetch_runs 与来源健康报失败，既有信源周报可见，但 operations/alerts.ts 只检测全站停止新增，单来源持续缺正文不一定及时推送。
- 处置：本次先恢复正文、保留来源失败与定时重试；后续在既有运营告警中接入持续正文缺口，不另起服务。验证需覆盖单来源失败而其它来源仍正常新增的场景。


## ISSUE-WECHAT-20261012-text-recovery：相同文字且无 HTML 的状态恢复

- 状态：open；负责人：AIHOT 维护者；实现审查 MEDIUM，留待用户决定是否扩展修复。
- 观察：`content/materials.ts` 的相同 content_hash 分支，旧状态 unconfirmed、新输入 ok 且文字相同但没有 bodyHtml 时，可能返回 revised=true 而不更新 body_status。该分支的实际 UPDATE 仍要求传入 HTML。
- 本次处置：已修复并验证公众号抓取的 HTML / 图片恢复路径；其恢复输入有 HTML，此非阻塞分支不在本次增加修复。后续统一文本与 HTML 恢复条件，并验证连续两次相同输入的状态与幂等结果。

## ISSUE-STORAGE-20261017-lifecycle：存储生命周期与写入放大

指令执行与剩余项处置的诊断见 [harness 跟踪项](archive/closed.md#harness-20261018-storage-followthrough存储治理剩余项需要可执行的处置与验收)。

- 状态：open；负责人：AIHOT 维护者。2026-10-17 首轮只读审计后，用户授权实施优化；业务保留语义未改变。事实与消费者见[生产存储审计](../references/20261017-storage-audit.md)，实施与验证见[优化记录](../references/20261017-storage-optimization.md)。
- 已发生：数据库 8.31 GiB，回执/attempt 占 4.23 GiB；日回执约 6,400–6,600、fetch_runs 约 10,600。现役 response 双写，研究/回填多层正文复制；backfill 状态更新触发正文投影刷新。dailyRetention 正常运行，但不覆盖回执、fetch_runs、小时热度、审计等全部增长族。
- 清理可靠性：cache unlink 失败仍计成功；stored_files 先删行再删文件可能遗留；最前正文清理抛错会跳过其余维护。当前缓存无超 30 天文件，未复现删除失败，不能把代码风险说成已发生漏清。
- 备份：worker 环境和凭据目录回退均缺备份配置，无 ops.backup / backup.last；2026-10-18 用户确认没有异机备份/自动快照，并选择暂缓备份实施。源码上传失败可跳过本地 keep3；当前 backups 目录不存在，尚无此类堆积。
- 小文件与部署：QR 旧 hash、停止转发/超过重试窗口的截图缺统一回收，当前目录不存在；发布脚本无自动 release 回收，本次手工清理不形成持续机制。历史回填文件仍需逐批核消费者和唯一性。
- 已实现、验证并部署：新增回执响应单副本及兼容读者；研究投影跳过无效更新；清理失败保留重试记录、继续独立阶段并将失败交给既有运行记录。2026-10-17 23:23:48 +08 经用户批准在腾讯云启用单副本，15 条真实新增响应均可读，历史与新回执各 1 条真实复用未新增派发，详见[部署记录](../references/20261017-storage-optimization.md#生产部署与消费验证)。默认模板仍为双写，其他部署按[运维入口](../operations/storage.md)先升级全部读者。
- 2026-10-18 接续：已核当前过期缓存、文件记录和作业记录均为零；用户选择暂缓新增明细保留期限。已核 audit_log 的修复幂等用途和历史榜单曲线的 24 小时前置窗口，具体处置及重评条件见[存储 spec](../operations/storage.md#2026-10-18-接续核对与具体处置)。
- 后续：按 spec 的重评条件处理缓存预算及明细期限；备份实施暂缓，维护者重启时提供异机目标及恢复窗口，executor 补上传失败回收、远端保留及实际恢复验收；历史去重及低频终态 payload 的 COS 分离需另核实际收益和兼容性。保留账本/幂等/恢复语义；不直接删除 received/unknown、不凭索引扫描为零删索引、不为小体量指标新增 OLAP 服务。外部清理失败通知沿现有告警接入待办，不将后台可查询视为已通知。
- 验收：受控删除失败后仍能重试且不会假报释放；一个数据族失败不跳过其它维护；回执复用、费用与恢复结果不变；研究全文/分页/原文结果不变；归档校验可读先于本地副本移除；以连续尺寸读数核实际增长与空间复用，而非仅看被删行数。方案及业务保留窗口仍待用户另行决定。

## ISSUE-OPS-20261017-worker-drain：停止期限短于应用排空上界

- 状态：open；负责人：AIHOT 维护者。腾讯云 worker 的 `TimeoutStopSec=120`，应用 `STOP_TIMEOUT_MS=195000`，最长单次付费请求可达 180 秒；普通 systemctl stop 有提前强杀窗口。pg-boss 到内部超时会 failWip 后返回，故退出 0 也不证明在途结果已结算。
- 本次生产部署以主 PID SIGTERM、无替代 PID、回执及 active 作业前后核对完成排空，未触发强杀或新增未知回执；未将此部署操作临时修法宣称为 unit 已修复。
- 下一步：维护者统一 unit 与应用排空上界，验证接近期限的在途付费结果和超时路径，沿现有 shutdown 测试补证。下一次在修复前部署继续按上述排空证据判断，不能只检查服务退出码。
