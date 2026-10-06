import { Link, useNavigate, useNavigation } from "react-router";
import type { NewsScope } from "@aihot/contracts/site";

/** Two explicit choices with a sliding highlight; the URL is the persisted selection. */
export function NewsScopeToggle({ value, href }: { value: NewsScope; href: (scope: NewsScope) => string }) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const pending = navigation.state !== 'idle';
  return <div className="my-4">
    <div role="radiogroup" aria-label="新闻范围" aria-busy={pending} className="relative grid w-full max-w-sm grid-cols-2 rounded-full border border-line bg-bg-sunk p-1 text-[13px]">
      <span aria-hidden="true" className="pointer-events-none absolute bottom-1 left-1 top-1 w-[calc(50%-4px)] rounded-full bg-accent transition-transform duration-200 motion-reduce:transition-none" style={{ transform: value === 'all' ? 'translateX(100%)' : 'translateX(0)' }} />
      {(['selected', 'all'] as const).map(scope => <Link key={scope} to={href(scope)} role="radio" aria-checked={value === scope} tabIndex={value === scope ? 0 : -1}
        onKeyDown={event => {
          const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'selected' : event.key === 'ArrowRight' || event.key === 'End' ? 'all' : event.key === ' ' ? scope : null;
          if (next) {
            event.preventDefault();
            event.currentTarget.parentElement?.querySelectorAll('a')[next === 'selected' ? 0 : 1]?.focus();
            navigate(href(next));
          }
        }}
        className={`relative rounded-full px-3 py-2 text-center font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${value === scope ? 'text-white' : 'text-ink-3 hover:text-ink'}`}>
        {scope === 'selected' ? '精选' : '全部 AI 相关新闻'}
      </Link>)}
    </div>
    <span role="status" className="mt-1 block h-4 text-[12px] text-ink-4">{pending ? '正在加载…' : ''}</span>
  </div>;
}
