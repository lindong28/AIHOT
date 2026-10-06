import { Form, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/sources";
import type { PublicSource, SourceDirectory } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { SourceAvatar } from "../components/ui/SourceAvatar";
import { NewsScopeToggle } from "../components/ui/NewsScopeToggle";
import { newsScope, scopeHref } from "../lib/news-scope";

export function headers() { return { "Cache-Control": "public, max-age=0, s-maxage=60" }; }
export async function loader({ request }: Route.LoaderArgs) {
  const tab = newsScope(request.url, 'all');
  const directory = await loadOr404<SourceDirectory>(scopeHref('/api/site/sources', tab), { signal: request.signal });
  return { directory, tab, q: new URL(request.url).searchParams.get("q")?.trim().slice(0, 100) ?? "" };
}
export function meta() { return pageMeta({ title: "来源", description: "浏览当前接入的公众号、X 账号、网站与开发者平台，按来源阅读新闻。", path: "/sources" }); }

export function matchesSource(source: PublicSource, q: string) {
  return `${source.name} ${source.identifier ?? ''}`.toLocaleLowerCase().includes(q.toLocaleLowerCase());
}

export default function SourcesPage() {
  const { directory, q, tab } = useLoaderData<typeof loader>();
  const label = tab === 'selected' ? '精选' : 'AI 相关新闻';
  const href = (path: string) => scopeHref(path, tab);
  const groups = directory.groups.map(g => ({ ...g, accounts: g.accounts.filter(a => a.active && (!q || matchesSource(a, q) || g.name.toLowerCase().includes(q.toLowerCase()))) }))
    .filter(g => !q || g.accounts.length > 0 || g.name.toLowerCase().includes(q.toLowerCase()));
  return <div className="pb-8 pt-5 lg:pt-1">
    <h1 className="text-[24px] font-bold text-ink">按来源看 {SITE.subject}</h1>
    <p className="mt-2 text-[14px] text-ink-3">发现目前接入的来源，按平台或账号阅读新闻。</p>
    <NewsScopeToggle value={tab} href={scope => scopeHref('/sources', scope, q)} />
    <Form method="get" className="my-5 flex max-w-xl gap-2" role="search">
      <input type="hidden" name="tab" value={tab} />
      <label className="sr-only" htmlFor="source-search">搜索来源</label>
      <input id="source-search" name="q" type="search" key={q} defaultValue={q} placeholder="搜索名称、账号或域名" className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-3 py-2 text-[14px] text-ink" />
      <button className="rounded-control bg-ink px-4 text-[14px] text-bg">搜索</button>
      {q && <Link to={href('/sources')} className="self-center text-[13px] text-accent">清除</Link>}
    </Form>
    {!q && <nav aria-label="来源分类" className="mb-6 flex flex-wrap gap-2">{groups.map(g => <a key={g.key} href={`#${g.key}`} className="chip">{g.name}</a>)}</nav>}
    {groups.length === 0 && <p className="py-8 text-ink-3">没有找到“{q}”。试试账号名称或域名。</p>}
    <div className="space-y-8">{groups.map(group => <section key={group.key} id={group.key} className="scroll-mt-6">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h2 className="text-[19px] font-bold text-ink"><Link to={href(group.href)} className="hover:text-accent">{group.name}</Link></h2>
        <Link to={href(group.href)} className="shrink-0 text-[13px] text-accent">{tab === 'selected' ? '查看精选' : '查看全部新闻'} →</Link>
      </div>
      <p className="mb-3 text-[12.5px] text-ink-4">{group.description} · {group.total.toLocaleString('zh-CN')} 条{label}</p>
      {group.key === 'hacker-news' ? <Link to={href(group.href)} className="card block p-4 text-[14px] text-ink-2 hover:border-accent">浏览 Hacker News 收录的新闻与讨论 →</Link>
        : <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{group.accounts.map(source => <Link key={source.href} to={href(source.href)} className="card card-hover flex min-w-0 items-center gap-3 p-4">
          <SourceAvatar name={source.name} iconUrl={source.iconUrl} size={36} />
          <div className="min-w-0"><div className="truncate text-[14px] font-semibold text-ink">{source.name}</div>
            {source.identifier && <div className="truncate text-[12px] text-ink-4">{source.identifier}</div>}
            <div className="mt-1 text-[12px] text-ink-3">{source.total ? `${source.total.toLocaleString('zh-CN')} 条${label}` : `暂无${label}`}</div>
          </div>
        </Link>)}</div>}
    </section>)}</div>
  </div>;
}
