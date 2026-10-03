# 付费回执的业务恢复

后台“需要核对的付费回执”包含结果未知、近期失败及长时间未返回的请求。业务恢复和供应商核账是两件事：新闻处理成功可以结案，但不能因此推断旧调用没有计费。统一入口为 `scripts/recover-receipts.ts`，恢复关联保存在 PostgreSQL `receipt_recoveries`；原 `receipt_attempts` 和费用字段保留。

## 预览、执行与续跑

在装好依赖并完成迁移的发布目录执行。生产连接使用 Node 的 env-file，不能 shell source 配置，也不要输出密钥。

```bash
cd /home/ubuntu/aihot/current
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts --json
```

默认只读预览，不调用模型。自动恢复候选为全部 unknown 和最近三天的 failed；尚在 pending 的调用不自动放行。执行必须先取得覆盖本批可能重复计费的授权，再选择一个唯一批次名并记录授权说明：

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --apply --batch receipts-20261003 \
  --note '站点所有者授权对既有异常进行一次业务重放；原费用未知保留，接受可能再次计费' \
  --limit 4 --wait-seconds 900
```

第一次执行冻结回执 ID、原 attempt 和业务目标；以后**沿用同一个批次名和命令**续跑，不会吸收后来新出现的失败，也不会再次放行本批重放后产生的新失败。进程中断后可续跑：放行、恢复记录和入队共用事务。多个恢复脚本不能同时运行。

没有候选时不创建空批次；查询不存在的批次会报错。目标缺失或无法恢复时单独标记 blocked，继续处理后续目标，不占用处理中名额。归组和综述保存实际入队或复用的 job ID，只有对应任务完成且业务结果已持久化才可据此结案。

回填 preparation 的候选扫描在每次预览或创建批次内合并一次，随后复用精确匹配结果，避免逐回执扫描历史库存。续跑已有批次直接使用已冻结目标。

`--limit` 是本批同时在处理的业务目标上限，默认 4，范围 1–100；排队中的目标占用额度。它不是新建模型 worker 的并发数。线上分析仍由现有 worker 和预算控制，回填仍由原 runner/timer 执行；恢复会增加正常模型工作量。生产应依据共享 worker/provider 容量设置上限，不把 100 当作推荐值。`--wait-seconds` 限定本次脚本等待时间（最多一天），到期不会取消已经排入的业务任务。

```bash
node --env-file=/home/ubuntu/aihot/shared/app.env scripts/recover-receipts.ts \
  --status --batch receipts-20261003 --json
```

`--status` 核验业务结果并结案，不放行或排新任务。退出码 `0` 表示预览完成或该批全部结案；`2` 表示还有待排队、处理中或未解决项；`1` 表示执行错误。`--json` 提供逐条剩余目标和原 attempt，供 Codex／Claude 定向诊断。不能把“脚本正常退出了”或“已经排队”当作全部恢复。

## 恢复边界

| 目标 | 执行方式 | 结案证据 |
| --- | --- | --- |
| 普通文章分析 | 原 article_id、当前 revision，复用分析队列和旧 run tag | 当前 revision 的分析已经持久化，并进入同一文章的 publication |
| 归组 | 原文章普通归组任务，不强制拆组 | 原文章已有后续 fact membership，或本次归组任务完成且 publication 已持久化；`grouped_at` 单独不算成功 |
| 事件综述 | 原 story_id 的综述任务 | 后续综述版本已持久化 |
| 历史回填 | 通过原批次 advisory lock，只把选中的 failed item 改为 pending | 原 item 达到 published／filtered／existing 终态 |
| Codex 重置监控 | 保留原监控顺序，由正常 tick 处理；已经识别成功时直接结案 | 原 post 已有持久 recognition 和处理完成时间 |

回填锁被占用时，保留 planned，等原 executor 自然结束后再试；不暂停或抢占当前回填。preparation 回执通过冻结版本 key 或保存的回执 ID 找回原 item，旧 error 缓存仅对这次捕获的 attempt 允许一次重试。原 manifest、缓存输入与请求身份检查继续生效。

同一新闻沿用原 article_id，历史导入沿用唯一 identity_key，publication 按 article_id 更新，因此恢复不会重新导入一份新闻。过滤掉的内容属于正常终态，不要求为其生成公开新闻。

已恢复的旧异常从后台待核对表中移除，并在汇总中计为 `recovered`。这层显示只覆盖已结案的原 attempt；同一个 receipt 后来出现新失败仍会展示。它不会把旧调用伪装成模型成功，也不会把 unknown 费用改成零。没有业务结果、目标不存在或身份改变时，不强行结案。

## 核账与人工后续

有完整 Gateway 账本且能证明零 attempt、未派发时，继续使用 `reconcile-gateway-receipts.ts` 的证据路径；它与本页的“接受可能再次计费后重放”不同。missing ledger、HTTP 502、断连或缺 usage 都不构成免费证明。

若本批出现新失败，先按剩余 target 检查实际阶段和 Gateway 请求，不用新批次名反复解除相同问题。脚本不自动解决文章修订冲突、缺失原文或新的 provider 故障。恢复后抽查 article identity、publication 唯一性、公开详情，并比较执行前后回填和实时任务进度；不能只看待核对数下降。

2026-10-03 所有者明确授权上述受控重放及简单自动结案。该授权覆盖当次旧异常，不是以后对未知费用无限重放的默认授权。
