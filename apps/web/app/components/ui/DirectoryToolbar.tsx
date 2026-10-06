import { Form, Link } from "react-router";
import { useRef } from "react";
import type { NewsScope } from "@aihot/contracts/site";
import { scopeHref } from "../../lib/news-scope";
import { NewsScopeToggle } from "./NewsScopeToggle";

export function DirectoryToolbar({ path, q, tab, label, placeholder }: { path: string; q: string; tab: NewsScope; label: string; placeholder: string }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="my-5 flex items-center gap-3">
    <Form action={path} method="get" role="search" aria-label={label} className="flex min-w-0 flex-1 items-center gap-1 sm:max-w-md">
      <input type="hidden" name="tab" value={tab} />
      <div className="flex min-w-0 flex-1 items-center rounded-control border border-line-strong bg-surface focus-within:border-accent">
        <input ref={input} name="q" type="search" aria-label={label} key={q} defaultValue={q} placeholder={placeholder} className="min-w-0 w-full bg-transparent px-3 py-2 text-[13px] text-ink outline-none [&::-webkit-search-cancel-button]:hidden" />
        <button type="submit" aria-label={label} className="flex h-10 w-9 shrink-0 items-center justify-center rounded-control text-ink-3 hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
        </button>
      </div>
      {q && <Link to={scopeHref(path, tab)} aria-label="清除搜索" title="清除搜索" className="flex h-10 w-6 shrink-0 items-center justify-center text-ink-3 hover:text-accent">×</Link>}
    </Form>
    <NewsScopeToggle value={tab} href={scope => scopeHref(path, scope, input.current?.value.trim().slice(0, 100) ?? q)} />
  </div>;
}
