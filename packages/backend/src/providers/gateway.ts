// Optional Gateway transport. Upstream credentials stay with the Gateway.
import { randomUUID } from "node:crypto";
import { bindingRoutes, type BackfillBinding } from "../backfill/context.ts";
import { GatewayNotDispatchedError } from "./receipts.ts";

export function gatewayConfigured(): boolean {
  return !!process.env.LLM_GATEWAY_URL;
}

export function prepareGatewayRequest(model: string, timeoutMs: number, pin?: BackfillBinding) {
  if (!gatewayConfigured()) return null;
  const url = new URL(process.env.LLM_GATEWAY_URL!);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LLM_GATEWAY_URL must be an HTTP(S) URL without credentials, query or fragment");
  }
  const baseUrl = url.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
  const project = process.env.LLM_GATEWAY_PROJECT?.trim();
  if (!project) throw new Error("LLM_GATEWAY_PROJECT must name a registered project");
  const mode = process.env.LLM_GATEWAY_MODE ?? "stream";
  if (mode !== "stream" && mode !== "batch") throw new Error("LLM_GATEWAY_MODE must be stream or batch");
  // Keep the local waiting policy below receipts' ten-minute stale threshold.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) {
    throw new Error("Gateway upstream timeout must be between 1 and 180000 ms");
  }
  const requestId = randomUUID();
  const routes = pin ? bindingRoutes(pin) : [];
  if (pin?.routes && !pin.registryRevision) throw new Error("Backfill fallback requires a verified Gateway registry revision");
  // The registry revision constrains this dispatch, not the semantic request:
  // unrelated registry edits must not bypass an unknown or settled receipt.
  const identity = { baseUrl, project, mode, model, timeoutMs, ...(pin ? { routes } : {}) };
  return {
    requestId,
    identity,
    summary: { ...identity, ...(pin?.registryRevision ? { registryRevision: pin.registryRevision } : {}), logicalRequestId: requestId },
    async send(endpoint: "chat/completions" | "embeddings", body: Record<string, unknown>): Promise<Record<string, unknown>> {
      // One send only. This deadline reserves for recovery windows, not a completion
      // guarantee: expiry remains unknown. Gateway owns transport retry and fallback.
      const res = await fetch(`${baseUrl}/v1/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-LLM-Project": project, "X-LLM-Request-ID": requestId, "X-LLM-Mode": mode,
          ...(pin?.route ? { "X-LLM-Route": pin.route } : {}),
          ...(pin?.registryRevision ? { "X-LLM-Allowed-Routes": JSON.stringify(routes.map((r) => r.route)), "X-LLM-Registry-Revision": pin.registryRevision } : {}),
        },
        body: JSON.stringify({ ...body, model, timeout: timeoutMs / 1000 }),
        signal: AbortSignal.timeout(2 * timeoutMs + 200_000),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as Record<string, unknown> | null;
        const error = json?.error as Record<string, unknown> | undefined;
        // Gateway emits these exact rejections only when the logical request has NO
        // attempts. A single attempt's not_crossed says nothing about prior fallbacks.
        const hasCompanion = json?.llm_gateway !== undefined || error?.llm_gateway !== undefined ||
          [...res.headers.keys()].some((key) => key.startsWith("x-llm-gateway-"));
        if (res.status === 422 && (error?.code === "route_cooldown" || error?.code === "no_route") && !hasCompanion &&
            (error.logical_request_id === undefined || error.logical_request_id === requestId)) {
          throw new GatewayNotDispatchedError(requestId, `Gateway ${error.code}: 未派发模型请求，等待任务退避重试；request ${requestId}`);
        }
        // Persist codes, not upstream messages: those can contain credentials or private URLs.
        const code = typeof error?.code === "string" && /^[a-zA-Z0-9_]{1,80}$/.test(error.code) ? ` (${error.code})` : "";
        throw new Error(`Gateway HTTP ${res.status}${code}; reconcile request ${requestId} before retrying`);
      }
      const json = await res.json() as Record<string, unknown>;
      // Compressed provider JSON is passed through: Gateway identity then lives
      // in percent-encoded headers, even though fetch has decompressed the body.
      const compressed = !!res.headers.get("content-encoding");
      const companion = compressed
        ? Object.fromEntries([...res.headers].filter(([key]) => key.startsWith("x-llm-gateway-"))
          .map(([key, value]) => [key.slice("x-llm-gateway-".length).replaceAll("-", "_"), decodeURIComponent(value)]))
        : json?.llm_gateway as Record<string, unknown> | undefined;
      if (compressed && companion?.projection_version === "1") companion.projection_version = 1;
      if (companion?.projection_version !== 1 || companion.logical_request_id !== requestId) {
        throw new Error(`Gateway identity mismatch; reconcile request ${requestId} before retrying`);
      }
      if (pin && !routes.some((r) => companion.provider_id === r.provider && companion.selected_route_id === r.route && companion.actual_model === r.actualModel &&
          (!r.credentialProfile || companion.credential_profile_id === r.credentialProfile))) {
        throw new Error(`Gateway backfill route mismatch; reconcile request ${requestId} before retrying`);
      }
      return { ...json, llm_gateway: companion };
    },
  };
}
