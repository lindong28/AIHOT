// Optional Gateway transport. Upstream credentials stay with the Gateway.
import { randomUUID } from "node:crypto";
import { GatewayClient, GatewayHTTPError, GatewayCapabilityError, GatewayProtocolError } from "@lindong/llm-gateway-client";
import { bindingRoutes, bindingIdentityRoutes, type BackfillBinding } from "../backfill/context.ts";
import { GatewayNotDispatchedError } from "./receipts.ts";
import { GatewayResponseError, gatewayFailure } from "./gateway-error.ts";

const CONNECT_RETRY_CODES = new Set(["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);
const NETWORK_CODES = new Set([...CONNECT_RETRY_CODES, "ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]);
const TRANSIENT_NETWORK_CODES = new Set([...CONNECT_RETRY_CODES, "ECONNRESET", "ETIMEDOUT", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CALLER_DEADLINE"]);

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

let cachedClient: { key: string; client: GatewayClient } | undefined;

export function jsonMaxAttempts(): number {
  const value = Number(process.env.LLM_JSON_MAX_ATTEMPTS ?? 3);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("LLM_JSON_MAX_ATTEMPTS must be a positive integer");
  return value;
}

function gatewayClient(baseUrl: string, project: string, mode: "stream" | "batch") {
  const retry = {
    maxAttempts: Number(process.env.LLM_GATEWAY_MAX_ATTEMPTS ?? 3),
    attemptTimeoutMs: Number(process.env.LLM_GATEWAY_ATTEMPT_TIMEOUT_MS ?? 30000),
    initialBackoffMs: Number(process.env.LLM_GATEWAY_INITIAL_BACKOFF_MS ?? 3000),
  };
  const jsonRetry = { maxAttempts: jsonMaxAttempts() };
  const requestRecovery = process.env.LLM_GATEWAY_REQUEST_RECOVERY_ENABLED !== "false";
  const key = JSON.stringify({ baseUrl, project, mode, retry, jsonRetry, requestRecovery });
  if (cachedClient?.key === key) return cachedClient.client;
  const client = new GatewayClient({ baseUrl, project, mode, retry, jsonRetry, requestRecovery });
  // Each generation must finish before the ten-minute pending receipt lease.
  if (client.deadlineMs > 9 * 60 * 1000) throw new Error("Gateway retry policy exceeds the 9-minute receipt waiting limit");
  cachedClient = { key, client };
  return client;
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
  // Preserve the historical receipt identity, independently of instance policy.
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) {
    throw new Error("Gateway upstream timeout must be between 1 and 180000 ms");
  }
  const requestId = randomUUID();
  const client = gatewayClient(baseUrl, project, mode);
  const routes = pin ? bindingRoutes(pin) : [];
  if (pin?.routes && !pin.registryRevision) throw new Error("Backfill fallback requires a verified Gateway registry revision");
  // The registry revision constrains this dispatch, not the semantic request:
  // unrelated registry edits must not bypass an unknown or settled receipt.
  const identity = { baseUrl, project, mode, model, timeoutMs, ...(pin ? { routes: bindingIdentityRoutes(pin) } : {}) };
  return {
    requestId,
    client,
    recoveryEnabled: process.env.LLM_GATEWAY_REQUEST_RECOVERY_ENABLED !== "false",
    identity,
    summary: { ...identity, retry: client.retry, jsonRetry: client.jsonRetry,
      ...(process.env.LLM_GATEWAY_REQUEST_RECOVERY_ENABLED !== "false" ? { recoveryVersion: 1 } : {}),
      ...(pin ? { routes } : {}), ...(pin?.registryRevision ? { registryRevision: pin.registryRevision } : {}), logicalRequestId: requestId },
    async send(endpoint: "chat/completions" | "embeddings", body: Record<string, unknown>, persistedRequestId: string = requestId): Promise<Record<string, unknown>> {
      const requestId = persistedRequestId;
      let res: { body: unknown; headers: Headers; status: number };
      try {
        res = await client.request(`/v1/${endpoint}`, { ...body, model }, { requestId, headers: {
          ...(pin?.route ? { "X-LLM-Route": pin.route } : {}),
          ...(pin?.registryRevision ? { "X-LLM-Allowed-Routes": JSON.stringify(routes.map((r) => r.route)), "X-LLM-Registry-Revision": pin.registryRevision } : {}),
        } });
      } catch (error) {
        if (error instanceof GatewayCapabilityError) {
          if (!this.recoveryEnabled) throw new GatewayNotDispatchedError(requestId, "Gateway does not support the configured retry policy; no model request dispatched");
          // Negotiation proves only this HTTP invocation was not sent. An earlier
          // invocation of this UUID may already have produced a paid answer.
          const cause = error.cause;
          const transient = cause instanceof GatewayHTTPError
            ? cause.status === 408 || cause.status === 429 || cause.status >= 500
            : networkCodes(cause).every(code => TRANSIENT_NETWORK_CODES.has(code));
          throw new GatewayResponseError(503, requestId,
            { version: 1, httpStatus: null, providerCode: null, category: transient ? "transport_error" : "invalid_request", retryable: transient },
            undefined, { version: 1, logical_request_id: requestId, action: transient ? "retry_same_request" : "stop", retry_after_s: transient ? 3 : 0 });
        }
        if (error instanceof GatewayProtocolError) throw new Error(`Gateway response identity or protocol mismatch; reconcile request ${requestId} before retrying`);
        if (error instanceof GatewayHTTPError) res = error;
        else {
          const codes = [...new Set(networkCodes(error))];
          if (this.recoveryEnabled && codes.every(code => TRANSIENT_NETWORK_CODES.has(code))) {
            throw new GatewayResponseError(503, requestId, { version: 1, httpStatus: null, providerCode: null, category: "transport_error", retryable: true },
              "transport_error", { version: 1, logical_request_id: requestId, action: "retry_same_request", retry_after_s: 3 });
          }
          throw new Error(`Gateway network failure (${codes.join(",")}); reconcile request ${requestId} before retrying`);
        }
      }
      const json = res.body as Record<string, unknown> | null;
      const error = json?.error as Record<string, unknown> | undefined;
      const parseError = res.status === 502 && error?.code === "parse_error";
      if (res.status >= 400 && !parseError) {
        // Gateway emits these exact rejections only when the logical request has NO
        // attempts. A single attempt's not_crossed says nothing about prior fallbacks.
        const hasCompanion = json?.llm_gateway !== undefined || error?.llm_gateway !== undefined ||
          ["projection-version", "logical-request-id", "attempt-id", "selected-route-id", "provider-id"].some((key) => res.headers.has(`x-llm-gateway-${key}`));
        if (res.status === 422 && (error?.code === "route_cooldown" || error?.code === "no_route") && !hasCompanion &&
            (error.logical_request_id === undefined || error.logical_request_id === requestId)) {
          throw new GatewayNotDispatchedError(requestId, `Gateway ${error.code}: 未派发模型请求，等待任务退避重试；request ${requestId}`);
        }
        // Persist codes, not upstream messages: those can contain credentials or private URLs.
        throw new GatewayResponseError(res.status, requestId, gatewayFailure(json, res.headers, res.status), error?.code, error?.recovery);
      }
      // Compressed provider JSON is passed through: Gateway identity then lives
      // in percent-encoded headers, even though fetch has decompressed the body.
      const compressed = !!res.headers.get("content-encoding");
      const companion = compressed
        ? Object.fromEntries([...res.headers].filter(([key]) => key.startsWith("x-llm-gateway-"))
          .map(([key, value]) => [key.slice("x-llm-gateway-".length).replaceAll("-", "_"), decodeURIComponent(value)]))
        : (json?.llm_gateway ?? error?.llm_gateway) as Record<string, unknown> | undefined;
      if (compressed && companion?.projection_version === "1") companion.projection_version = 1;
      if (compressed && typeof companion?.retry_policy === "string") companion.retry_policy = JSON.parse(companion.retry_policy);
      if (companion?.projection_version !== 1 || companion.logical_request_id !== requestId) {
        throw new Error(`Gateway identity mismatch; reconcile request ${requestId} before retrying`);
      }
      if (pin && !routes.some((r) => companion.provider_id === r.provider && companion.selected_route_id === r.route && companion.actual_model === r.actualModel &&
          (!r.credentialProfile || companion.credential_profile_id === r.credentialProfile))) {
        throw new Error(`Gateway backfill route mismatch; reconcile request ${requestId} before retrying`);
      }
      if (parseError && (!json?.output || typeof json.output !== "object" || !Array.isArray((json.output as Record<string, unknown>).choices))) {
        throw new Error(`Gateway parse_error has no retained output; reconcile request ${requestId} before retrying`);
      }
      return { ...json, llm_gateway: companion };
    },
  };
}
