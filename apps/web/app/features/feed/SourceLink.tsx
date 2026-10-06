import type { ReactNode } from "react";
import { Link } from "react-router";
import type { SourceRef } from "@aihot/contracts/site";

export function SourceLink({ source, children, className = "" }: { source: Pick<SourceRef, "name" | "href">; children?: ReactNode; className?: string }) {
  return source.href ? <Link to={source.href} className={`relative z-10 hover:text-accent hover:underline ${className}`} title={`查看 ${source.name} 的新闻`} onClick={e => e.stopPropagation()}>{children ?? source.name}</Link>
    : <span className={className}>{children ?? source.name}</span>;
}
