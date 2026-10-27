import { createHash } from "node:crypto";

/** Safe correlation for logs and persisted queue errors: never include source credentials or query strings. */
export function imageFailure(url: string, mode: string, error: unknown) {
  const causes: Array<{ name: string; code?: string; message: string }> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && causes.length < 5 && !seen.has(current)) {
    seen.add(current);
    const value = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    // Network and decoder messages can echo the complete URL. Remove it, including userinfo and signed queries.
    const clean = (text: unknown) => String(text ?? "").replace(/https?:\/\/[^\s<>"']+/gi, "[url]").replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/(authorization|cookie|token|password|secret|sig)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]").slice(0, 300);
    causes.push({ name: clean(value.name || "Error"), ...(value.code ? { code: clean(value.code) } : {}), message: clean(value.message ?? current) });
    current = value.cause;
  }
  let host: string | null = null;
  try { host = new URL(url).hostname; } catch { /* A malformed source must not break failure reporting. */ }
  return { resourceId: createHash("sha256").update(url).digest("hex"), host, mode, causes };
}

export class ImageStageError extends Error {
  constructor(stage: string, cause: unknown) { super(`image ${stage} failed`, { cause }); this.name = "ImageStageError"; }
}
