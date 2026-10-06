import { Link, useLoaderData } from "react-router";
import { apiGet } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { DirectoryToolbar } from "../components/ui/DirectoryToolbar";
import { newsScope, scopeHref } from "../lib/news-scope";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const tab = newsScope(request.url, 'selected');
  const q = new URL(request.url).searchParams.get('q')?.trim().slice(0, 100) ?? '';
  return { ...await apiGet<{ topics: TopicSummary[] }>(scopeHref('/api/site/topics', tab), { signal: request.signal }), tab, q };
}

export function meta() {
  return pageMeta({ title: "主题", description: "按公司与模型、技术方向、内容形态聚合的 AI 主题页：OpenAI、Anthropic、Agent、多模态、论文与教程等 38 个方向。", path: "/topics", image: "/og/pages/topics.png" });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600" };
}

const GROUPS = [
  { key: "company", name: "公司与模型", blurb: "按厂商与模型系追踪：谁发了什么、又赢了哪一局" },
  { key: "field", name: "技术方向", blurb: "按技术领域深挖：Agent、多模态、具身智能……" },
  { key: "genre", name: "内容形态", blurb: "按内容类型浏览：论文、教程、观点、政策……" },
] as const;

export default function TopicsPage() {
  const { topics, tab, q } = useLoaderData<typeof loader>();
  const label = tab === 'selected' ? '精选' : 'AI 相关新闻';
  const matches = topics.filter(t => `${t.name} ${t.slug} ${t.definition}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
  const groups = GROUPS.filter(g => !q || matches.some(t => t.group === g.key));
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按主题看 AI</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          按公司与模型、技术方向、内容形态浏览 <span className="num">{topics.length}</span> 个主题，持续汇集近期焦点与精选。
        </p>
      </header>
      <DirectoryToolbar path="/topics" q={q} tab={tab} label="搜索主题" placeholder="搜索主题名称或关键词" />
      {q && <p role="status" className="text-[13px] text-ink-3">{matches.length ? `找到 ${matches.length} 个主题` : `没有找到“${q}”。试试主题名称或关键词。`}</p>}
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-5">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {matches
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={scopeHref(`/topics/${t.slug}`, tab)}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关${tab === 'selected' ? '精选文章' : '全部 AI 新闻'}`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条{label} <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
