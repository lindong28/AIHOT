// Only this safe projection is persisted; upstream free-text messages are never copied.
const CATEGORIES = ["content_policy_rejected", "rate_limited", "quota_exhausted", "authentication", "invalid_request", "timeout", "upstream_unavailable", "transport_error", "unknown"] as const;
type Category = typeof CATEGORIES[number];
export interface GatewayFailure {
  version: 1;
  httpStatus: number | null;
  providerCode: string | null;
  category: Category;
  retryable: boolean | null;
  contentFilter?: { role: "user" | "assistant"; level: number };
}
const CODES = new Set(["1301", "content_filtered", "insufficient_quota"]);
const GATEWAY_CODES = new Set(["ledger_unavailable", "ledger_busy", "route_cooldown", "no_route", "dispatch_constraint_rejected", "http_error", "timeout", "transport_error"]);

export interface GatewayRecovery {
  version: 1;
  logical_request_id: string;
  action: "retry_same_request" | "retry_new_request" | "stop";
  retry_after_s: number;
}

/** Recovery authority must be bound to the exact request we sent. */
export function gatewayRecovery(value: unknown, requestId: string): GatewayRecovery | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.logical_request_id !== requestId ||
      !["retry_same_request", "retry_new_request", "stop"].includes(String(v.action)) ||
      !Number.isSafeInteger(v.retry_after_s) || Number(v.retry_after_s) < 0 ||
      !Number.isFinite(new Date(Date.now() + Number(v.retry_after_s) * 1000).getTime())) return null;
  return { version: 1, logical_request_id: requestId, action: v.action as GatewayRecovery["action"], retry_after_s: Number(v.retry_after_s) };
}

export function safeGatewayFailure(value: unknown): GatewayFailure | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !CATEGORIES.includes(v.category as Category)) return null;
  const filter = v.contentFilter as Record<string, unknown> | undefined;
  return {
    version: 1,
    httpStatus: Number.isInteger(v.httpStatus) && Number(v.httpStatus) >= 100 && Number(v.httpStatus) <= 599 ? Number(v.httpStatus) : null,
    providerCode: typeof v.providerCode === "string" && CODES.has(v.providerCode) ? v.providerCode : null,
    category: v.category as Category,
    retryable: typeof v.retryable === "boolean" ? v.retryable : null,
    ...(filter && (filter.role === "user" || filter.role === "assistant") && Number.isInteger(filter.level) && Number(filter.level) >= 0 && Number(filter.level) <= 3
      ? { contentFilter: { role: filter.role as "user" | "assistant", level: Number(filter.level) } } : {}),
  };
}

export function gatewayFailure(body: unknown, headers: Headers, status: number): GatewayFailure {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  let metadata: unknown = error?.failure;
  try { if (!metadata && headers.has("x-llm-gateway-error")) metadata = JSON.parse(decodeURIComponent(headers.get("x-llm-gateway-error")!)); } catch { /* Optional metadata cannot replace the original failure. */ }
  const safe = safeGatewayFailure(metadata);
  // Historical Gateway/provider responses have no projection. Only recognize known codes.
  const code = error?.code === 1301 ? "1301" : typeof error?.code === "string" ? error.code : null;
  const rejected = status === 400 && (code === "1301" || code === "content_filtered");
  const quota = code === "insufficient_quota";
  // Fetch can decode a native body that Gateway deliberately left compressed.
  // Its exact known code adds evidence missing from the optional header projection.
  if (safe) return !safe.providerCode && (rejected || quota)
    ? { ...safe, providerCode: code, category: rejected ? "content_policy_rejected" : "quota_exhausted", retryable: false } : safe;
  return { version: 1, httpStatus: status, providerCode: code && CODES.has(code) ? code : null,
    category: rejected ? "content_policy_rejected" : quota ? "quota_exhausted" : status === 429 ? "rate_limited" : status >= 500 ? "upstream_unavailable" : "unknown",
    retryable: rejected || quota ? false : status === 408 || status === 429 || status >= 500 ? true : null };
}

export class GatewayResponseError extends Error {
  readonly details: GatewayFailure;
  readonly recovery: GatewayRecovery | null;
  constructor(status: number, requestId: string, details: GatewayFailure, gatewayCode?: unknown, recovery?: unknown) {
    const code = details.providerCode ?? (typeof gatewayCode === "string" && GATEWAY_CODES.has(gatewayCode) ? gatewayCode : null);
    super(`Gateway HTTP ${status}${code ? ` (${code})` : ""}; reconcile request ${requestId} before retrying`);
    this.details = details;
    this.recovery = gatewayRecovery(recovery, requestId);
  }
}

export function contentPolicyRejected(details: unknown, error: string | null): boolean {
  const safe = safeGatewayFailure(details);
  if (safe) return safe.category === "content_policy_rejected";
  // Exact historical writer format from prepareGatewayRequest(), not provider free text.
  return /^Error: Gateway HTTP 400 \((1301|content_filtered)\); reconcile request [0-9a-f-]{36} before retrying$/.test(error ?? "");
}
