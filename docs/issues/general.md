# 未解决问题

## ISSUE-TEST-20261013-valves：全量测试与关闭模型安全阀的开发约束不一致

- 状态：open；负责人：AIHOT 维护者，后续单独调整测试出口隔离；不属于本次私有资料接口修复。
- 2026-10-13：在独立 PostgreSQL 17 空库迁移后，以 COLLECT_ENABLED=false、MODEL_CALLS_ENABLED=false 和外发阀关闭运行 npm test。未改动基线 33af310 共 380 项，354 通过、26 失败；本次实现首次 387 项，361 通过、26 失败，失败测试集合相同。25 项模型 stub 测试被 MODEL_CALLS_ENABLED=false 拦住，另 1 项由本机默认 Python 3.9 缺 SQLite serialize 造成。
- 保持阀关闭、PATH 优先已安装的 Python 3.14 后，本次修复版完整套件 389 项，364 通过、25 失败；失败名称均包含在未改动基线中。随后定向增加搜索转义回归，私有 HTTP/CLI 10 项全部通过。没有开启真实模型或外部请求来获得全绿。
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
