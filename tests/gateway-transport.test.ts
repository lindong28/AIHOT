import "./setup.ts";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { prepareGatewayRequest } from "@aihot/backend/providers/gateway";

process.env.LLM_GATEWAY_URL = "http://127.0.0.1:39031";
process.env.LLM_GATEWAY_PROJECT = "aihot-test";
afterEach(() => mock.restoreAll());

const failure = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("private upstream URL"), { code }) });
const request = () => prepareGatewayRequest("test-model", 1000)!;

for (const code of ["ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`Gateway retries pre-connect ${code} with identical UUID, body and deadline`, async () => {
    const sent: RequestInit[] = [];
    const prepared = request();
    mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      sent.push(init);
      if (sent.length < 3) throw failure(code);
      return Response.json({ llm_gateway: { projection_version: 1, logical_request_id: prepared.requestId } });
    });
    await prepared.send("chat/completions", { messages: [] });
    assert.equal(sent.length, 3);
    assert.equal(sent[0], sent[1]);
    assert.equal(sent[1], sent[2]);
  });
}

for (const code of ["ECONNRESET", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
  test(`Gateway ${code} remains uncertain and is not replayed`, async () => {
    const fetch = mock.method(globalThis, "fetch", async () => { throw failure(code); });
    await assert.rejects(request().send("chat/completions", {}), (error: Error) => {
      assert.match(error.message, new RegExp(code));
      assert.ok(!error.message.includes("private upstream URL"));
      return true;
    });
    assert.equal(fetch.mock.callCount(), 1);
  });
}

test("Gateway repeated connect failures stop after three tries", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => { throw failure("ECONNREFUSED"); });
  await assert.rejects(request().send("embeddings", {}), /ECONNREFUSED/);
  assert.equal(fetch.mock.callCount(), 3);
});

test("Gateway aggregate errors retry only when every address failed before connection", async () => {
  for (const codes of [["ECONNREFUSED", "ECONNREFUSED"], ["ECONNREFUSED", "ECONNRESET"]]) {
    const fetch = mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed", { cause: new AggregateError(codes.map((code) => Object.assign(new Error(), { code }))) });
    });
    await assert.rejects(request().send("chat/completions", {}));
    assert.equal(fetch.mock.callCount(), codes[1] === "ECONNREFUSED" ? 3 : 1);
    fetch.mock.restore();
  }
});

test("Gateway HTTP 503 is handled once and never retried by AIHOT", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "ledger_unavailable" } }, { status: 503 }));
  await assert.rejects(request().send("chat/completions", {}), /HTTP 503.*ledger_unavailable/);
  assert.equal(fetch.mock.callCount(), 1);
});
