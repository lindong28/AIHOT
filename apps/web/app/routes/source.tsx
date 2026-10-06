import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/source";
import type { SourcePage } from "@aihot/contracts/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta, titled } from "../lib/seo";
import { SourceAvatar } from "../components/ui/SourceAvatar";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState } from "../components/ui/Page";

function queryString(values: Record<string, string | number | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== '') params.set(key, String(value));
  return params.size ? '?' + params.toString() : '';
}

export function headers() { return { "Cache-Control": "public, max-age=0, s-maxage=60" }; }
export async function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const query = queryString({ tab: url.searchParams.get('tab'), page: url.searchParams.get('page') });
  const path = `/api/site/sources/${encodeURIComponent(params.group)}${params.key ? '/' + encodeURIComponent(params.key) : ''}`;
  return { data: await loadOr404<SourcePage>(path + query, { signal: request.signal }), q: url.searchParams.get('q')?.trim().slice(0, 100) ?? '' };
}
export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled('来源不存在') }, { name: 'robots', content: 'noindex' }];
  const { group, source, tab, page } = loaderData.data;
  return pageMeta({ title: `${source?.name ?? group.name} · ${tab === 'selected' ? '精选' : '全部新闻'}`, description: group.description,
    path: (source?.href ?? group.href) + queryString({ tab: tab === 'selected' ? tab : null, page: page > 1 ? page : null }), noindex: tab === 'selected' || page > 1 });
}

export default function SourceNewsPage() {
  const { data, q } = useLoaderData<typeof loader>();
  const { group, source, items, page, pageCount, total, tab } = data;
  const path = source?.href ?? group.href;
  const href = (p: number, t = tab) => path + queryString({ tab: t === 'selected' ? t : null, page: p > 1 ? p : null, q });
  const accounts = group.accounts.filter(a => `${a.name} ${a.identifier ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return <div className="pb-6 pt-5 lg:pt-1">
    <nav aria-label="面包屑" className="mb-4 flex flex-wrap gap-2 text-[13px] text-ink-4">
      <Link to="/sources" className="hover:text-accent">来源</Link><span>›</span>
      {source ? <><Link to={group.href} className="hover:text-accent">{group.name}</Link><span>›</span><span aria-current="page">{source.name}</span></> : <span aria-current="page">{group.name}</span>}
    </nav>
    <header className="mb-5 flex items-center gap-3">
      {source && <SourceAvatar name={source.name} iconUrl={source.iconUrl} size={44} />}
      <div className="min-w-0"><h1 className="break-words text-[24px] font-bold text-ink">{source?.name ?? group.name}</h1>
        <p className="mt-1 text-[13px] text-ink-3">{source ? [source.identifier, group.name, !source.active ? '历史来源 · 当前未持续收录' : null].filter(Boolean).join(' · ') : group.description}</p>
      </div>
    </header>
    {group.accounts.length > 0 && <details className="mb-5 rounded-control border border-line bg-surface p-3" key={`${path}:${q}`} open={q ? true : undefined}>
      <summary className="cursor-pointer text-[13px] text-ink-2">{source ? '切换来源' : `按账号或来源筛选（${group.accounts.length}）`}</summary>
      <Form method="get" action={path} className="mt-3 flex gap-2" role="search">
        {tab === 'selected' && <input type="hidden" name="tab" value="selected" />}
        <label className="sr-only" htmlFor="account-search">搜索本分类来源</label>
        <input id="account-search" type="search" name="q" defaultValue={q} placeholder="搜索名称、账号或域名" className="min-w-0 flex-1 rounded-control border border-line-strong bg-bg px-3 py-2 text-[13px]" />
        <button className="rounded-control bg-ink px-4 text-[13px] text-bg">搜索</button>
      </Form>
      <div className="mt-3 max-h-64 overflow-y-auto">
        <Link to={group.href + queryString({ tab: tab === 'selected' ? tab : null })} className="block rounded-control px-2 py-2 text-[13px] text-accent">全部{group.name}新闻</Link>
        {accounts.map(a => <Link key={a.href} to={a.href + queryString({ tab: tab === 'selected' ? tab : null })} className="flex items-center justify-between gap-3 rounded-control px-2 py-2 text-[13px] text-ink-2 hover:bg-bg-sunk" aria-current={a.href === source?.href ? 'page' : undefined}>
          <span className="min-w-0 truncate">{a.name}{!a.active ? ' · 历史来源' : ''}</span><span className="shrink-0 text-[12px] text-ink-4">{a.total} 条</span>
        </Link>)}
        {accounts.length === 0 && <p className="p-2 text-[13px] text-ink-4">没有匹配的来源。</p>}
      </div>
    </details>}
    <div className="mb-3 flex items-center justify-between border-b border-line">
      <nav aria-label="新闻范围" className="flex gap-5">{(['all', 'selected'] as const).map(t => <Link key={t} to={href(1, t)} aria-current={t === tab ? 'page' : undefined} className={`border-b-2 py-3 text-[14px] ${t === tab ? 'border-accent font-semibold text-accent' : 'border-transparent text-ink-3'}`}>{t === 'all' ? '全部' : '精选'}</Link>)}</nav>
      <span className="text-[12px] text-ink-4">{total.toLocaleString('zh-CN')} 条{tab === 'selected' ? '精选' : '公开新闻'} · 最新在前</span>
    </div>
    {items.length ? <DayList items={items} /> : <EmptyState title={tab === 'selected' ? '暂无精选新闻' : '暂无公开新闻'} />}
    <Pagination page={page} pageCount={pageCount} href={href} />
  </div>;
}
