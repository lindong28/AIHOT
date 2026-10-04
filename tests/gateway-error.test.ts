import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFailure, safeGatewayFailure, contentPolicyRejected } from "../packages/backend/src/providers/gateway-error.ts";

test("optional metadata validation keeps unknown fields out and never infers quota from 429",()=>{
  assert.equal(safeGatewayFailure({version:2,category:"timeout"}),null);
  for (const filter of [{role:"system",level:1},{role:"user",level:4},{role:"assistant",level:"2"},{role:["user"],level:2}]) {
    const value=safeGatewayFailure({version:1,category:"unknown",providerCode:"secret_token",httpStatus:"400",retryable:"true",message:"secret",contentFilter:filter});
    assert.deepEqual(value,{version:1,httpStatus:null,providerCode:null,category:"unknown",retryable:null});
  }
  const fallback=gatewayFailure({error:{code:"secret-token",message:"private URL"}},new Headers({"x-llm-gateway-error":"%malformed"}),429);
  assert.equal(fallback.category,"rate_limited"); assert.equal(fallback.providerCode,null); assert.equal(fallback.retryable,true);
  assert.equal(gatewayFailure({error:{code:1301}},new Headers(),400).category,"content_policy_rejected");
  assert.equal(gatewayFailure({error:{code:["1301"]}},new Headers(),400).category,"unknown");
  const quota=gatewayFailure({error:{code:"insufficient_quota"}},new Headers(),429);
  assert.equal(quota.category,"quota_exhausted"); assert.equal(quota.retryable,false);
  const compressed = gatewayFailure({error:{code:"1301"}},new Headers({"x-llm-gateway-error":encodeURIComponent(JSON.stringify({version:1,httpStatus:400,providerCode:null,category:"invalid_request",retryable:false}))}),400);
  assert.equal(compressed.category,"content_policy_rejected"); assert.equal(compressed.providerCode,"1301");
  const header=new Headers({"x-llm-gateway-error":encodeURIComponent(JSON.stringify({version:1,httpStatus:400,providerCode:null,category:"invalid_request",retryable:false}))});
  for (const code of [["1301"],{toString:"not callable"}]) assert.equal(gatewayFailure({error:{code}},header,400).category,"invalid_request");
  assert.equal(contentPolicyRejected(null,"some provider said 1301"),false);
  assert.equal(contentPolicyRejected(null,"Error: Gateway HTTP 400 (1301); reconcile request 00000000-0000-0000-0000-000000000000 before retrying"),true);
});
