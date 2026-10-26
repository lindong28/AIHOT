import { useCallback, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAdminAction } from './action';
import { Badge, Button, Card, DataTable, Json, ReasonDialog, Time } from './ui';

type Target = { kind: string; id?: string | number; reportKind?: string; key?: string };
type Snapshot = { id: number; attempt: number; requestId: string; logicalKey: string };
type Preview = { rows: Array<{ id: number; eligible: boolean; reason: string | null; target: Target | null; snapshot: Snapshot | null }> };
export interface RecoveryBatches {
  rows: Array<{ batch: string; actor: string | null; created_at: string; total: number; planned: number; queued: number; recovered: number; blocked: number }>;
  page: number; total: number;
}
export interface RecoveryDetail {
  batch: string; web: boolean; actor: string | null; checkedAt: string | null; runnerError: string | null; stopped: boolean; truncated: boolean;
  items: Array<{ receiptId: number; attempt: number; target: Target; state: string; consumed: boolean; canResume: boolean; resumeReason: string | null; evidence: Record<string, unknown> | null; resultHref: string | null }>;
}
const labels: Record<string,string> = { planned: '等待后台派发', queued: '已入队，等待业务结果', recovered: '业务已恢复', blocked: '已停止，需核对' };
const targetLabel = (t: Target | null) => !t ? '未识别' : t.kind === 'report' ? `${t.reportKind} · ${t.key}` : `${({ article: '文章', group: '归组', digest: '综述', monitor: '监控', backfill: '回填', unsupported: '不支持' } as Record<string,string>)[t.kind] ?? t.kind}${t.id ? ` · ${t.id}` : ''}`;

export function ReceiptRecovery({ selected, clearSelection, batches, detail }: {
  selected: number[]; clearSelection: () => void; batches: RecoveryBatches; detail: RecoveryDetail | null;
}) {
  const { run, pending } = useAdminAction();
  const location = useLocation(), navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [batch, setBatch] = useState('');
  const [consent, setConsent] = useState(false);
  const [resume, setResume] = useState<number[] | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeResume = useCallback(() => setResume(null), []);
  const eligible = preview?.rows.filter(r => r.eligible && r.snapshot).map(r => r.snapshot!) ?? [];
  function href(name: string, value: string) {
    const params = new URLSearchParams(location.search); params.set(name,value);
    return `/admin/runs?${params}#receipt-recovery`;
  }
  return <Card className="mt-5" title="旧回执续跑" right={<span>共 {batches.total} 个批次</span>}>
    <div id="receipt-recovery" className="space-y-3">
      <p className="text-[13px] text-ink-3">在下方回执表勾选后预检。适用的旧拒绝请求每条最多授权一次新生成，可能重复计费；原错误与核账状态保留。提交后由后台执行，关闭页面也会继续。</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!selected.length || !!pending} onClick={async () => {
          const result = await run<Preview>('POST','/api/admin/receipt-recovery/preview',{ receiptIds: selected },{ revalidate: false });
          if (result) { setPreview(result); setConsent(false); setBatch(`web-${crypto.randomUUID()}`); }
        }}>预检所选 {selected.length} 条</Button>
        {!!selected.length && <Button tone="ghost" onClick={clearSelection}>清空选择</Button>}
      </div>
      <DataTable dense rows={batches.rows} rowKey={r => r.batch} empty="尚无恢复批次" columns={[
        { key: 'batch', label: '批次', render: r => <Link className="text-accent break-all" to={href('batch',r.batch)}>{r.batch}</Link> },
        { key: 'actor', label: '执行入口', render: r => r.actor ? '网页授权 · 后台执行' : '历史脚本 · 只读' },
        { key: 'state', label: '进度', render: r => `已恢复 ${r.recovered}/${r.total} · 等待 ${r.planned} · 在途 ${r.queued} · 停止 ${r.blocked}` },
        { key: 'at', label: '创建时间', render: r => <Time at={r.created_at} /> },
      ]} />
      <div className="flex gap-4 text-[13px]">
        {batches.page > 1 && <Link to={href('recoveryPage',String(batches.page-1))}>上一页批次</Link>}
        {batches.page*20 < batches.total && <Link to={href('recoveryPage',String(batches.page+1))}>下一页批次</Link>}
      </div>
      {detail && <div className="border-t border-line pt-3">
        <h3 className="font-semibold break-all">批次 {detail.batch}</h3>
        <p className="my-2 text-[13px]">{detail.web ? `授权人：${detail.actor}；后台约每分钟检查，最近检查：` : '历史脚本批次，仅查看结果。'}{detail.web && <Time at={detail.checkedAt} />}</p>
        {detail.runnerError && <p role="alert" className="text-hot">{detail.runnerError}</p>}
        {detail.stopped && <p role="alert" className="text-hot">出现新的明确拒绝，剩余调用已停止；已在途的结果继续保留。</p>}
        <DataTable dense rows={detail.items} rowKey={r => r.receiptId} columns={[
          { key: 'id', label: '原回执', render: r => `#${r.receiptId} · 第${r.attempt}次` },
          { key: 'target', label: '业务目标', render: r => r.resultHref ? <Link className="text-accent" to={r.resultHref}>{targetLabel(r.target)} · 查看业务</Link> : targetLabel(r.target) },
          { key: 'state', label: '状态与额度', render: r => <><Badge tone={r.state === 'recovered' ? 'ok' : 'muted'}>{labels[r.state] ?? r.state}</Badge><div>{r.consumed ? '一次额度已消费' : detail.web ? '额度未消费' : '历史授权以原记录为准'}</div></> },
          { key: 'action', label: '后续操作', render: r => <>{r.canResume ? <Button disabled={!!pending} onClick={() => setResume([r.receiptId])}>继续原授权</Button> : <span className="text-ink-3">{r.resumeReason}</span>}{r.evidence && <details className="mt-2"><summary>诊断记录</summary><Json value={r.evidence} /></details>}</> },
        ]} />
        {detail.items.filter(r => r.canResume).length > 1 && <Button className="mt-3" onClick={() => setResume(detail.items.filter(r => r.canResume).map(r => r.receiptId))}>继续本批可恢复条目</Button>}
        {detail.truncated && <p>历史批次仅展示前 100 条；完整记录请通过维护脚本查看。</p>}
      </div>}
    </div>
    <ReasonDialog open={!!preview} title="预检旧回执续跑" onClose={closePreview} busy={!!pending} confirmDisabled={!consent || !eligible.length}
      confirmLabel={`授权 ${eligible.length} 条并后台执行`} description="本次只提交下列可执行条目。提交时会再次核对原请求身份；不符合条件的条目不会获得授权。"
      onSubmit={async note => {
        if (!consent || !eligible.length) return false;
        const result = await run<{ batch: string }>('POST','/api/admin/receipt-recovery',{ batch, note, receipts: eligible, acceptDuplicateCharge: consent },{ label: batch, success: '授权已保存，后台将继续执行' });
        if (!result) return false;
        clearSelection(); navigate(href('batch',result.batch)); return true;
      }}>
      <div className="max-h-64 overflow-y-auto space-y-2 text-[13px]">{preview?.rows.map(r => <div key={r.id}><strong>#{r.id} · {r.eligible ? '可执行' : '排除'}</strong><div>{r.reason ?? `${targetLabel(r.target)} · 原第${r.snapshot?.attempt}次`}</div></div>)}</div>
      <label className="flex gap-2 text-[13px]"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我确认每条旧请求最多新增一次生成，接受可能重复计费；这不代表原费用已核销。</label>
    </ReasonDialog>
    <ReasonDialog open={!!resume} title="继续原授权" onClose={closeResume} busy={!!pending} confirmLabel={`继续 ${resume?.length ?? 0} 条`}
      description="仅继续调用前中断且额度未消费的条目，沿用原授权，不补充额度。后台会重新检查身份、停止条件及在途任务。"
      onSubmit={async note => {
        if (!detail || !resume) return false;
        return !!await run('POST',`/api/admin/receipt-recovery/${encodeURIComponent(detail.batch)}/resume`,{ receiptIds: resume, note },{ success: '已交回后台继续原授权' });
      }} />
  </Card>;
}
