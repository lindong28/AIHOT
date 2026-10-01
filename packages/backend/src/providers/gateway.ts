// Optional Gateway transport. Upstream credentials stay with the Gateway.
import { randomUUID } from "node:crypto";

export function gatewayConfigured(): boolean {
  return !!process.env.LLM_GATEWAY_URL;
}

export function prepareGatewayRequest(model: string, timeoutMs: number, pin?: { route: string; actualModel: string }) {
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
  const identity = { baseUrl, project, mode, model, timeoutMs, ...(pin ? { route: pin.route, actualModel: pin.actualModel } : {}) };
  return {
    requestId,
    identity,
    summary: { ...identity, logicalRequestId: requestId },
    async send(endpoint: "chat/completions" | "embeddings", body: Record<string, unknown>): Promise<Record<string, unknown>> {
      // One send only. This deadline reserves for recovery windows, not a completion
      // guarantee: expiry remains unknown. Gateway owns transport retry and fallback.
      const res = await fetch(`${baseUrl}/v1/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-LLM-Project": project, "X-LLM-Request-ID": requestId, "X-LLM-Mode": mode, ...(pin ? { "X-LLM-Route": pin.route } : {}) },
        body: JSON.stringify({ ...body, model, timeout: timeoutMs / 1000 }),
        signal: AbortSignal.timeout(2 * timeoutMs + 200_000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Gateway HTTP ${res.status}; reconcile request ${requestId} before retrying`);
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
      if (pin && (companion.selected_route_id !== pin.route || companion.actual_model !== pin.actualModel)) {
        throw new Error(`Gateway backfill route mismatch; reconcile request ${requestId} before retrying`);
      }
      return { ...json, llm_gateway: companion };
    },
  };
}
