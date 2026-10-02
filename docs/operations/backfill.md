# 历史原文回填

供迁移维护者将审核后的历史原文交给 AIHOT 当前算法处理，并查看逐日进度。实时新闻继续使用原模型配置；历史批次通过同一个个人 llm-gateway 固定到自部署路由。当前提供有界执行命令，不是自动常驻服务；本机模拟验收不代表 GPU 模型已就绪。

## 准备原文，不调用模型

在仓库根目录运行，先按[部署说明](../deploy.md)准备 Node、依赖和数据库，设置目标 `DATABASE_URL` 并执行 `node scripts/migrate.ts`。首次上线此功能须完成 `0039_backfill.sql` 迁移，重启 API、重新构建并重启 Web；普通 worker 也须更新，以识别受管历史条目。安全阀保持关闭。

准备 `source-map.json`（旧来源 ID 到已登记 AIHOT 来源 ID 的对象）和 `reviews.json`（初始为 `{}`），数据与密钥放在不入 Git 的 `.data/`。转换只保留原始字段，不读取 RADAR 的评分、分类、标签和生成摘要：

```bash
node scripts/prepare-radar-backfill.ts .data/source-map.json .data/reviews.json .data/native-review.jsonl .data/raw-audit.jsonl.gz .data/ingestion-differences.jsonl.gz
```

输出原生 JSONL 及同名 `.summary.json`，包含排除原因和审核后连续区间。默认所有材料待审核；未映射来源、无正文和无效材料不进入输出。输出文件必须不存在。原始版本应保留，不能用转换结果替代原始归档。

审核记录按原生身份键索引，例如 `url:https://example.com/news`（以实际转换身份为准）或 `x:帖子ID`；值为 `{"contentHash":"该条 quality.contentHash","state":"complete","evidence":"完整性判断的原文证据"}`，不完整则标 `incomplete`。短且完整的公告可以通过；只有标题、链接、截断摘要或缺失关键引用的材料不能标完整。多版本需对照原始归档，选中准确 hash。X 还需在审核记录中提供 AIHOT 原生 `xPost`（作者、正文、引用与媒体）；重建后重新转换取得 hash，再审核该版本。原生字段定义见 [manifest.ts](../../packages/backend/src/backfill/manifest.ts)。

更新审核文件后换一个输出文件名再运行转换。只有 `complete` 条目参与回填，导入时重新核对正文 hash，要求选定 UTC 区间每天都有合格材料；这表示日期连续，不保证每个来源历史完整。待审核与区间外材料留在排除统计中。已存在的 AIHOT 身份直接计为“已有”，不覆盖原文、不沿用旧 RADAR 衍生结果。

```bash
node scripts/backfill.ts import .data/native-approved.jsonl 2026-04-20 2026-09-28 '历史原文第一批'
node scripts/backfill.ts status
```

日期仅示例，必须取转换后的合格连续区间，且距当前超过 48 小时。导入返回批次 ID，初态暂停、尚未调用模型。总条数与日期在创建时冻结；同一清单重复导入返回原批次。

## 模型部署完成后接入

部署 session 需提供三个模型在**个人** Gateway 上的 logical model ID、唯一 route ID、`self_hosted/…` actual model ID，以及可分配给回填的并发容量。五个角色绑定如下，具体 ID 必须来自部署后的 discovery，不填商业别名或猜测值：

| 角色键 | 模型与参数来源 |
|---|---|
| `prefilter`、`structure` | 同一个 Qwen3.8-Flash 同系列部署，沿用 `qwen3.8-flash` preset |
| `score` | GLM5.3-Flash，沿用 `glm-5.3-flash-selection` preset，双评分 |
| `understand` | GLM5.3-Flash，沿用 `glm-5.3-flash` preset |
| `summarize` | 自托管 DeepSeek V4 Flash 0731，使用 `deepseek-v4-flash-0731` preset |

`models.json` 是以这五个键组成的对象，每个值均为 `{"model":"部署后的逻辑ID","route":"部署后的路由ID","actualModel":"self_hosted/部署后的模型ID"}`。预筛和结构绑定须完全相同。配置无密钥，可以入 Git；本轮未伪造尚未部署的型号或路由文件。开始处理后不允许修改该批模型绑定。

执行环境设置 `LLM_GATEWAY_URL`、`LLM_GATEWAY_PROJECT=aihot`、`LLM_GATEWAY_MODE`（沿用个人 Gateway 接入配置）和 `LLM_GATEWAY_CLI`（已安装的 CLI 可执行文件路径）。当前机器的 CLI 是 `/Users/lindong/.local/share/llm-gateway/venv/bin/llm-gateway`；其他机器须指向其本地安装。CLI discovery 与 URL 必须属于同一个 Gateway。密钥继续由 Gateway 管理。

```bash
node scripts/backfill.ts configure BATCH_ID .data/models.json
node scripts/backfill.ts resume BATCH_ID
MODEL_CALLS_ENABLED=true node scripts/backfill.ts run BATCH_ID CONCURRENCY MAX_ITEMS
```

将三个大写参数替换为真实批次 ID、已确认的 GPU 并发容量、本次最多处理条数。`resume` 只改变状态，需运行执行命令；命令到达条数上限、队列耗尽或暂停后退出，进度留在数据库。单条失败保留错误并继续本次限额；本次结束后仍有失败则进入 `needs_attention`。未部署模型时不要执行最后一行。首批真实联调应核对五个角色的响应、Gateway 账本身份和最终公开页面，再扩量。

回填只允许个人 Gateway 的 `provider_id=self-hosted`，即自行部署的 GPU 模型；第三方托管 API（含订阅套餐）不允许用于回填。这是代码强制限制，不依赖 Gateway 的默认 provider 优先级，也不能只凭 `self_hosted/` 模型名前缀判定。五个角色均执行同一限制。

执行前检查个人项目、模型授权、路由的 `provider_id=self-hosted`、实际模型与已加载版本；每次调用通过 `X-LLM-Route` 固定 route，并核对响应中的 provider、route 和 actual model。自部署路由不可用时失败，不切换到第三方 API；响应身份缺失或不符则保留未知回执，核账前不重发。预算仍经过原生回执，独立服务名 `backfill`；默认限额见后台预算页，未知费用不会记成零。历史回填不调用 embedding、不生成历史日报或当前热点，也不触发额外的全文/引用翻译。

## 查看与续跑

管理员打开 `/admin/backfill`：查看已处理条数、完成天数、发布/过滤/已有数量、排除原因、当前阶段及失败原因。页面每 20 秒刷新。失败不算完成；“已发布”按原始日期进入历史公开内容，不挤占当前热点。读页面不调用模型。

暂停按钮或 `node scripts/backfill.ts pause BATCH_ID` 阻止后续模型调用；在途请求仍会结算，已发布内容不撤回。恢复沿用已结算回执。`waiting_models` 表示没有通过就绪检查，修复部署或绑定后恢复；`needs_attention` 查看条目错误，修复后使用“重试失败项”或 `retry BATCH_ID`。未知回执先在现有运维入口核对 Gateway 账本，再允许恢复；单纯点击重试不会重新发送未知请求。

本轮不启动无人值守调度。长期执行前由 AIHOT 维护者接入现有服务监督与通知；线上域名、现役采集及真实历史库均未因这份命令说明而切换。范围与验收记录见[迁移清单](../migration.md)和[实现决定](../references/20261001-backfill-design.md)。
