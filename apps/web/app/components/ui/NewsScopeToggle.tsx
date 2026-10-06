import { useRef } from "react";
import { useNavigate, useNavigation } from "react-router";
import type { NewsScope } from "@aihot/contracts/site";

/** On means selected only; off includes all public AI news. The URL persists the choice. */
export function NewsScopeToggle({ value, href }: { value: NewsScope; href: (scope: NewsScope) => string }) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const pending = navigation.state !== 'idle';
  const pointerStart = useRef<number | null>(null);
  const dragged = useRef(false);
  const selected = value === 'selected';
  return <span className="inline-flex shrink-0 items-center">
    <button type="button" role="switch" aria-label="仅看精选" aria-checked={selected} aria-busy={pending}
      title={selected ? '仅显示精选新闻；关闭后显示全部 AI 相关新闻' : '显示全部 AI 相关新闻；开启后仅显示精选'}
      onClick={() => { if (dragged.current) { dragged.current = false; return; } navigate(href(selected ? 'all' : 'selected')); }}
      onPointerDown={event => { pointerStart.current = event.clientX; dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerUp={event => {
        if (pointerStart.current === null) return;
        const delta = event.clientX - pointerStart.current;
        pointerStart.current = null;
        if (Math.abs(delta) > 8) { dragged.current = true; navigate(href(delta > 0 ? 'selected' : 'all')); }
      }}
      onPointerCancel={() => { pointerStart.current = null; dragged.current = false; }}
      onKeyDown={event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); navigate(href(event.key === 'ArrowRight' ? 'selected' : 'all'));
        }
      }}
      className="inline-flex min-h-10 touch-pan-y items-center gap-2 rounded-control text-[12px] text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
      <span aria-hidden="true" className={`relative h-5 w-8 rounded-full transition-colors motion-reduce:transition-none ${selected ? 'bg-accent' : 'bg-ink-4'} ${pending ? 'animate-pulse motion-reduce:animate-none' : ''}`}>
        <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 motion-reduce:transition-none ${selected ? 'translate-x-3' : ''}`} />
      </span>
      <span>仅看精选</span>
    </button>
    <span role="status" className="sr-only">{pending ? '正在加载…' : selected ? '当前仅显示精选新闻' : '当前显示全部 AI 相关新闻'}</span>
  </span>;
}
