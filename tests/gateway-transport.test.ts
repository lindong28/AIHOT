import "./setup.ts";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prepareGatewayRequest } from "@aihot/backend/providers/gateway";
import { GatewayNotDispatchedError } from "@aihot/backend/providers/receipts";

process.env.LLM_GATEWAY_URL = "http://127.0.0.1:39031";
process.env.LLM_GATEWAY_PROJECT = "aihot-test";
afterEach(() => mock.restoreAll());

const failure = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("private upstream URL"), { code }) });
let clientNumber = 0;
const request = () => {
  process.env.LLM_GATEWAY_PROJECT = `aihot-test-${++clientNumber}`;
  return prepareGatewayRequest("test-model", 1000)!;
};
const capabilities = () => Response.json({ retry_policy_versions: [1] });

for (const code of ["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
  test(`Gateway ${code} remains uncertain and is not replayed`, async () => {
    let sends = 0;
    mock.method(globalThis, "fetch", async (url: unknown) => {
      if (String(url).endsWith("/api/capabilities")) return capabilities();
      sends++;
      throw failure(code);
    });
    await assert.rejects(request().send("chat/completions", {}), (error: Error) => {
      assert.match(error.message, new RegExp(code));
      assert.ok(!error.message.includes("private upstream URL"));
      return true;
    });
    assert.equal(sends, 1);
  });
}

test("Gateway capability failure is proven not dispatched", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw failure("ECONNREFUSED"); });
  await assert.rejects(request().send("embeddings", {}), GatewayNotDispatchedError);
  assert.equal(fetch.mock.callCount(), 1);
});

test("Gateway aggregate errors are never retried by the application", async () => {
  for (const codes of [["ECONNREFUSED", "ECONNREFUSED"], ["ECONNREFUSED", "ECONNRESET"]]) {
    let sends = 0;
    const fetch = mock.method(globalThis, "fetch", async (url: unknown) => {
      if (String(url).endsWith("/api/capabilities")) return capabilities();
      sends++;
      throw new TypeError("fetch failed", { cause: new AggregateError(codes.map((code) => Object.assign(new Error(), { code }))) });
    });
    await assert.rejects(request().send("chat/completions", {}));
    assert.equal(sends, 1);
    fetch.mock.restore();
  }
});

test("Gateway HTTP 503 is handled once and never retried by AIHOT", async () => {
  let sends = 0;
  mock.method(globalThis, "fetch", async (url: unknown) => {
    if (String(url).endsWith("/api/capabilities")) return capabilities();
    sends++;
    return Response.json({ error: { code: "ledger_unavailable" } }, { status: 503 });
  });
  await assert.rejects(request().send("chat/completions", {}), /HTTP 503.*ledger_unavailable/);
  assert.equal(sends, 1);
});
