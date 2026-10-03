// Optional Gateway transport. Upstream credentials stay with the Gateway.
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { bindingRoutes, type BackfillBinding } from "../backfill/context.ts";
import { GatewayNotDispatchedError } from "./receipts.ts";

const CONNECT_RETRY_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const NETWORK_CODES = new Set([...CONNECT_RETRY_CODES, "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);

function networkCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== "object" || depth > 3) return ["UNKNOWN"];
  if (error instanceof AggregateError) {
    return error.errors.length ? error.errors.flatMap((e) => networkCodes(e, depth + 1)) : ["UNKNOWN"];
  }
  const { code, cause, name } = error as { code?: unknown; cause?: unknown; name?: string };
  if (typeof code === "string" && NETWORK_CODES.has(code)) return [code];
  if (cause) return networkCodes(cause, depth + 1);
  return [name === "TimeoutError" || name === "AbortError" ? "CALLER_DEADLINE" : "UNKNOWN"];
}

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
      // Only proven pre-connect failures may be retried here. Gateway owns all
      // provider retries; a socket reset or HTTP error may already have incurred cost.
      const init: RequestInit = {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", "X-LLM-Project": project, "X-LLM-Request-ID": requestId, "X-LLM-Mode": mode,
          ...(pin?.route ? { "X-LLM-Route": pin.route } : {}),
          ...(pin?.registryRevision ? { "X-LLM-Allowed-Routes": JSON.stringify(routes.map((r) => r.route)), "X-LLM-Registry-Revision": pin.registryRevision } : {}),
        },
        body: JSON.stringify({ ...body, model, timeout: timeoutMs / 1000 }),
        signal: AbortSignal.timeout(2 * timeoutMs + 200_000),
      };
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(`${baseUrl}/v1/${endpoint}`, init);
          break;
        } catch (error) {
          const codes = networkCodes(error);
          if (attempt < 2 && !init.signal!.aborted && codes.every((code) => CONNECT_RETRY_CODES.has(code))) {
            await delay(250 * (attempt + 1));
            if (!init.signal!.aborted) continue;
          }
          throw new Error(`Gateway network failure (${[...new Set(codes)].join(",")}); reconcile request ${requestId} before retrying`);
        }
      }
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
