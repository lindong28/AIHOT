# 内容保留与历史识别

实时 worker 和统一 backfill 在正常处理完成后执行相同的保留规则：公众号文章保留原始内容；其它来源中可以进入“全部 AI 动态”的内容保留，明确过滤或正常完成但文案不合格的内容清除。新闻池 eligibility 与精选 selected 不同，未入选精选不构成清理条件。调用失败、未知扣费、缺失分析及过时分析不是内容过滤，继续保留供恢复。

处理前必须临时落库，才能持久重试、核对付费回执。终态清除覆盖 articles 的标题/摘要/正文/HTML/raw/X 原帖与长文/媒体、修订正文、翻译、分析生成文案与结构、公开投影文案、搜索与文章 embedding；article 身份、source、URL、revision/hash、分析判定、回执关联继续保留。`articles.content_discarded_at` 表示已清除，公开详情不再提供正文，重新发布不会创建空页面。相同已见输入不重新入库处理，新同来源内容修订或新增微信来源证据仍可恢复处理。

微信公众号按 `mp_account`、历史微信来源标识、原文 `mp.weixin.qq.com` 域名及发现记录识别；backfill 还检查全部版本的来源、目标网址和原始 provenance，任一版本有微信证据就保留。回填终态标记 `backfill_items.content_discarded_at`，清空 material 以及 preparation 中原始正文、预筛输入、抓取结果等副本，保留版本 key、provenance/hash 和判定/回执编号。重新执行该终态不会拿空材料发起新调用。

热度来源仍按现有规则参与事件归组。正常完成归组但尚未匹配的内容用 `content_discard_after` 保留到发现后 48 小时；尚未执行或归组失败不会登记期限，再次归组前撤销旧期限。到期后的每日 retention 清除正文，已匹配内容可在归组完成后清除，热度关联保留。每日任务只处理新登记的到期项，不把既有历史记录纳入批量清理。Embedding 与正文补取在业务结果提交时完成回执，未完成回执（包括归组复核键）仍阻止清理。

供应商回执 `receipts/receipt_attempts`、原始离线归档和备份不在本策略的删除范围内。回执 response 可能包含整批推文、抓取正文或模型输出，仍会占空间；这里减少的是业务内容及准备材料副本，不是全库去掉每一个内容字节。PostgreSQL 释放的行空间可供复用，不等于磁盘文件立即变小。代码回退也不会恢复已清除正文。

## 之后清理历史时能用什么

已有字段足以先生成候选清单，不必重新调用模型：

| 对象 | 识别依据 | 排除或单独核对 |
| --- | --- | --- |
| 已创建 article | articles.source_id/url → sources.kind；article_discoveries；当前 revision 的 analyses.relevance；publications.eligible/visibility | 微信证据、当前仍可展示、new/failed、缺失/过时分析、未结算回执 |
| 尚未创建 article 的 backfill | backfill_items.state/reason；preparation.dataJson 解码后的 versions.material/provenance/targetUrls/prefilter 与 results | 任一微信版本、并非全部已结算 BLOCK、pending/running/failed |
| 正常完成但缺文案 | 当前 analyses.relevance=unknown；已完成业务链；回填原因 analysis_unknown | 不得与 receipts.status=unknown 混淆 |

不能只用 `eligible=false` 删除：它也覆盖尚未处理、故障和手工隐藏等情况。不能把 articles 的数量与 backfill filtered 数量直接相加，两者有重叠。历史清理应先冻结候选并按上述字段排除，保存 id/hash/来源及判定，再在事务内重新验证状态；本次发布没有执行历史批删。

TODO（AIHOT 仓库，负责人：AIHOT 维护者）：将内容清除失败纳入既有生产 worker/定时任务外部告警补齐项。清除异常目前由原任务失败与重试机制暴露，未声称无人值守通知已验收。

决策与回滚边界见 [2026-10-04 保留决定](../references/20261004-content-retention.md)。
