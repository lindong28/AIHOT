import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import { SITE } from "@aihot/industry/site";
import type { Route } from "./+types/backfill";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Stat } from "../../features/admin/ui";

type Day = { day: string; total: number; done: number; published: number; filtered: number; existing: number; failed: number; running: number };
type Batch = { id: string; label: string; start_day: string; end_day: string; state: string; error: string | null; heartbeat_at: string | null;
  models: Record<string, { model: string; route?: string; routes?: Array<{ route: string; credentialProfile?: string }> }> | null; days: Day[]; excluded: Array<{ reason: string; n: number }>;
  active: Array<{ article_id: string | null; day: string; stage: string | null; model: string | null; state: string; reason: string | null }> };
export async function loader({ request }: Route.LoaderArgs) { return adminGet<{ checkedAt: string; runs: Batch[] }>(request, "/api/admin/backfill"); }
export const meta: Route.MetaFunction = () => [{ title: `历史回填 · ${SITE.name} 后台` }];
const states: Record<string, string> = { paused: "已暂停", ready: "等待执行器", running: "处理中", waiting_models: "等待模型就绪", needs_attention: "有失败待处理", complete: "已完成" };
const roles: Record<string, string> = { prefilter: "预筛", score: "双评分", structure: "结构抽取", understand: "理解", summarize: "标题摘要" };
const reasons: Record<string, string> = { unverified: "完整性待审核", incomplete: "原文不完整", outside_range: "不在本批日期范围" };

export default function Backfill({ loaderData }: Route.ComponentProps) {
  const refresh = useRevalidator();
  const data = loaderData;
  const { run, pending } = useAdminAction();
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible" && refresh.state === "idle") refresh.revalidate(); }, 20000);
    return () => clearInterval(timer);
  }, [refresh]);
  return <AdminPage title="历史回填" subtitle={<>只处理经审核的完整原文；逐篇发布，实时新闻继续独立处理。每 20 秒刷新 · {bj(data.checkedAt)}</>}>
    <p className="mb-5 text-sm text-ink-3">暂停会等待在途请求结算。续跑复用已完成的模型回执；结果未知的调用须先在“运行”页面核对。这里的操作不启动执行器、不撤回已发布内容。</p>
    {!data.runs.length && <Empty>还没有回填批次。模型部署前可先转换、审核原始材料；候选数量不代表合格数量。</Empty>}
    {data.runs.map((b) => {
      const total = b.days.reduce((s,d) => s+d.total,0), done = b.days.reduce((s,d) => s+d.done,0);
      const failed = b.days.reduce((s,d) => s+d.failed,0), excluded = b.excluded.reduce((s,d) => s+d.n,0);
      const doneDays = b.days.filter((d) => d.done === d.total).length;
      return <Card key={b.id} className="mb-5" title={b.label} right={<Badge tone={b.state === "complete" ? "ok" : b.state === "needs_attention" ? "bad" : "muted"}>{states[b.state] ?? b.state}</Badge>}>
        <p className="mb-3 text-sm">{b.start_day} 至 {b.end_day}（UTC）· 连续 {b.days.length} 天；每天有合格原文，不代表所有来源均完整。</p>
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="已处理 / 合格原文" value={`${num(done)} / ${num(total)}`} hint={`进度 ${total ? (done/total*100).toFixed(1) : "0"}% · 失败不算完成`} />
          <Stat label="已完成天数" value={`${doneDays} / ${b.days.length}`} />
          <Stat label="失败待处理" value={num(failed)} tone={failed ? "bad" : undefined} />
          <Stat label="排除 / 本批候选" value={`${num(excluded)} / ${num(total+excluded)}`} hint={b.excluded.map((e) => `${reasons[e.reason] ?? e.reason} ${e.n}`).join(" · ") || "无排除"} />
        </div>
        <progress aria-label={`${b.label}处理进度`} className="mb-4 w-full accent-current" max={total || 1} value={done} />
        {b.error && <p role="alert" className="mb-3 text-sm text-hot">尚不能继续：{b.error}</p>}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button disabled={!!pending || b.state === "complete" || b.state === "paused"} onClick={() => run("POST", `/api/admin/backfill/${b.id}/pause`, {}, { success: "已请求暂停" })}>暂停</Button>
          <Button disabled={!!pending || b.state === "complete" || b.state === "running"} onClick={() => run("POST", `/api/admin/backfill/${b.id}/resume`, {}, { success: "已准备续跑，等待执行器" })}>准备续跑</Button>
          <Button disabled={!!pending || !failed || b.state === "running"} onClick={() => run("POST", `/api/admin/backfill/${b.id}/retry`, {}, { success: "失败条目已重新排队；未知回执仍需核对" })}>重试失败条目</Button>
          <span className="text-xs text-ink-3">执行器最近更新：{b.heartbeat_at ? bj(b.heartbeat_at) : "尚未运行"}</span>
        </div>
        <details className="mb-4 text-sm"><summary className="cursor-pointer">回填模型与批次信息</summary>
          <p className="my-2 font-mono text-xs">{b.id}</p>
          {b.models ? Object.entries(b.models).map(([role,m]) => <p key={role}>{roles[role] ?? role}：{m.model} · {(m.routes?.map((r) => r.credentialProfile ?? r.route) ?? [m.route]).join(" → ")}</p>) : <p>尚未绑定模型；绑定并完成预检后才能开始处理。</p>}
          <p className="mt-2 text-ink-3">本批包含编辑分析与发布；不生成历史日报、事件热度或独立全文/引用翻译。</p>
        </details>
        <DataTable rows={b.days} rowKey={(d) => d.day} columns={[
          { key:"day",label:"日期（UTC）",render:d=>d.day }, {key:"done",label:"完成 / 合格",render:d=>`${d.done} / ${d.total}`},
          {key:"published",label:"发布",render:d=>num(d.published)}, {key:"filtered",label:"过滤",render:d=>num(d.filtered)},
          {key:"existing",label:"已有，未覆盖",render:d=>num(d.existing)}, {key:"running",label:"处理中",render:d=>num(d.running)},
          {key:"failed",label:"失败",render:d=><span className={d.failed ? "text-hot" : ""}>{d.failed}</span>},
        ]} />
        {!!b.active.length && <details className="mt-4 text-sm"><summary className="cursor-pointer">处理阶段与失败详情（最近 100 条）</summary>
          {b.active.map((a,i)=><p className="my-2 break-words" key={i}>{a.day} · {a.article_id ? <Link to={`/admin/content/${a.article_id}`} className="text-accent">查看文章</Link> : "尚未导入"} · {a.state === "failed" ? "失败" : "处理中"} · {a.stage ?? "准备原文"} {a.model ?? ""}{a.reason ? ` · ${a.reason}` : ""}</p>)}
        </details>}
      </Card>;
    })}
  </AdminPage>;
}
