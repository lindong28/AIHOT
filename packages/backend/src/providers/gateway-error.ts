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
  gatewayCode?: "restart_required";
  parameter?: string;
}
const IMAGE_CODES = new Set(["invalid_image", "invalid_image_format", "invalid_base64_image", "invalid_image_url", "image_too_large", "image_too_small", "image_parse_error", "invalid_image_mode", "image_file_too_large", "unsupported_image_media_type", "empty_image_file", "failed_to_download_image", "image_file_not_found"]);
const POLICY_CODES = new Set(["1301", "content_filtered", "image_content_policy_violation"]);
const CODES = new Set([...POLICY_CODES, "insufficient_quota", "1210", "1211", "1212", "1213", "1214", "1215", "1221", "1222", "1261", ...IMAGE_CODES]);
const PARAMETERS = new Set(["model", "messages", "input", "image", "image_url", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stream", "response_format", "tools", "tool_choice"]);

/** A generic HTTP 400 or parameter name is insufficient authority to remove an image. */
export function imageRequestRejected(value: unknown): boolean {
  const d = safeGatewayFailure(value);
  return !!d && d.category === "invalid_request" && d.httpStatus === 400 && !!d.providerCode && IMAGE_CODES.has(d.providerCode);
}
const GATEWAY_CODES = new Set(["ledger_unavailable", "ledger_busy", "route_cooldown", "no_route", "dispatch_constraint_rejected", "http_error", "timeout", "transport_error", "restart_required"]);

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
    category: typeof v.providerCode === "string" && POLICY_CODES.has(v.providerCode) ? "content_policy_rejected" : v.category as Category,
    ...(typeof v.parameter === "string" && PARAMETERS.has(v.parameter) ? { parameter: v.parameter } : {}),
    retryable: typeof v.retryable === "boolean" ? v.retryable : null,
    ...(v.gatewayCode === 'restart_required' ? { gatewayCode: 'restart_required' as const } : {}),
    ...(filter && (filter.role === "user" || filter.role === "assistant") && Number.isInteger(filter.level) && Number(filter.level) >= 0 && Number(filter.level) <= 3
      ? { contentFilter: { role: filter.role as "user" | "assistant", level: Number(filter.level) } } : {}),
  };
}

export function gatewayFailure(body: unknown, headers: Headers, status: number): GatewayFailure {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  let metadata: unknown = error?.failure;
  try { if (!metadata && headers.has("x-llm-gateway-error")) metadata = JSON.parse(decodeURIComponent(headers.get("x-llm-gateway-error")!)); } catch { /* Optional metadata cannot replace the original failure. */ }
  const projected = safeGatewayFailure(metadata);
  const restart = error?.code === 'restart_required' ? { gatewayCode: 'restart_required' as const } : {};
  const safe = projected ? { ...projected, ...restart } : null;
  // Historical Gateway/provider responses have no projection. Only recognize known codes.
  const code = typeof error?.code === "number" && Number.isInteger(error.code) ? String(error.code) : typeof error?.code === "string" ? error.code : null;
  const rejected = status === 400 && !!code && POLICY_CODES.has(code);
  const invalid = status === 400 && !!code && CODES.has(code) && !rejected && code !== "insufficient_quota";
  const parameter = typeof error?.param === "string" && PARAMETERS.has(error.param) ? { parameter: error.param } : {};
  const quota = code === "insufficient_quota";
  // Fetch can decode a native body that Gateway deliberately left compressed.
  // Its exact known code adds evidence missing from the optional header projection.
  if (safe) return !safe.providerCode && (rejected || quota || invalid)
    ? { ...safe, ...parameter, providerCode: code, category: rejected ? "content_policy_rejected" : quota ? "quota_exhausted" : "invalid_request", retryable: false } : safe;
  return { version: 1, httpStatus: status, providerCode: code && CODES.has(code) ? code : null,
    category: rejected ? "content_policy_rejected" : quota ? "quota_exhausted" : invalid ? "invalid_request" : status === 429 ? "rate_limited" : status >= 500 ? "upstream_unavailable" : "unknown",
    retryable: rejected || quota || invalid ? false : status === 408 || status === 429 || status >= 500 ? true : null, ...restart, ...parameter };
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
