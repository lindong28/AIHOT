import type { NewsScope } from "@aihot/contracts/site";

export function newsScope(url: string, fallback: NewsScope): NewsScope {
  const tab = new URL(url).searchParams.get('tab');
  return tab === 'selected' || tab === 'all' ? tab : fallback;
}

export function scopeHref(path: string, tab: NewsScope, q = '') {
  const params = new URLSearchParams({ tab });
  if (q) params.set('q', q);
  return path + '?' + params.toString();
}
