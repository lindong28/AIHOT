import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fetchOriginals } from "../scripts/backfill-fetch-originals.ts";
import { sha256, stableJson } from "../packages/backend/src/lib/ids.ts";

async function fixture(extra: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "fetch-originals-")), prep = join(root, "prep"), output = join(root, "cache");
  await mkdir(join(prep, "results"), { recursive: true });
  const entries = ["a", "b", "blocked", "error", "x", "ambiguous", "pending", "fail", ...extra].map(id => ({ key: id + ":hash", article: { xPost: null }, provenance: { sourceKind: id === "x" ? "x" : "feed" } }));
  const input = entries.map(r => JSON.stringify(r)).join("\n") + "\n";
  const manifest = { inputSha256: sha256(input), total: entries.length, models: { test: true } };
  await writeFile(join(prep, "input.jsonl"), input); await writeFile(join(prep, "manifest.json"), JSON.stringify(manifest));
  async function result(id: string, state = "needs_original", label = "UNKNOWN") {
    const row = entries.find(r => r.key === id + ":hash")!;
    await writeFile(join(prep, "results", sha256(row.key) + ".json"), JSON.stringify({ key: row.key, inputHash: sha256(JSON.stringify(row)), manifestHash: sha256(stableJson(manifest)), state, label, receiptId: null }));
  }
  for (const id of ["a", "b", "x", "ambiguous", "fail", ...extra]) await result(id);
  await result("blocked", "filtered", "BLOCK"); await result("error", "error", "UNKNOWN");
  const inventory = join(root, "inventory.jsonl"), queue = join(root, "queue.jsonl");
  const inv = entries.map(r => ({ origin: { id: r.key.split(":")[0], legacyContentHash: "hash" }, sourceKind: r.provenance.sourceKind, targetUrls: [r.key.startsWith("fail:") ? "https://example.org/fail" : (extra.includes(r.key.split(":")[0]!) ? "https://example.org/" + r.key.split(":")[0] : "https://example.org/article")], classification: r.key.startsWith("ambiguous:") ? "target_selection_required" : "fetch_required" }));
  await writeFile(inventory, inv.map(r => JSON.stringify(r)).join("\n"));
  await writeFile(queue, [...new Set(inv.map(r => r.targetUrls[0]!))].map(url => JSON.stringify({ url, requesters: inv.filter(r => r.targetUrls[0] === url).map(r => r.origin) })).join("\n"));
  return { root, prep, output, result, opts: { preparation: prep, inventory, queue, output, maxItems: 10, seconds: 10 } };
}
const html = '<html><head><title>Actual article</title></head><body><article><h1>Actual article</h1>' + '<p>This is an actual paragraph containing original source information about a research experiment and its measurements.</p>'.repeat(10) + '</article></body></html>';

test("deduplicate, retain raw response, preserve unresolved rows, and resume newly arrived preparation results", async () => {
  const f = await fixture(); let calls = 0;
  const fetch = async (url: string, opts: any) => {
    calls++; assert.deepEqual(opts, { timeoutMs: 20_000, maxBytes: 6 * 1024 * 1024, maxRedirects: 5 });
    if (url.endsWith("fail")) throw new TypeError("sensitive error");
    return { status: 200, url: "https://example.org/final", headers: new Headers({ "content-type": "text/html" }), body: Buffer.from(html), text: () => html };
  };
  const first = await fetchOriginals(f.opts, { fetch }); assert.equal(calls, 2); assert.equal(first.claimed, 2);
  const cache = JSON.parse(await readFile(join(f.output, "responses", sha256("https://example.org/article") + ".json"), "utf8"));
  assert.equal(cache.quality, "unconfirmed"); assert.equal(cache.state, "needs_review"); assert.ok(cache.extracted.text.includes("research experiment"));
  assert.equal(gunzipSync(await readFile(join(f.output, cache.rawPath))).toString(), html);
  for (const reason of ["model_block", "preparation_unresolved", "x_requires_native_material", "target_selection_required"]) assert.equal(first.states[reason], 1);
  await f.result("pending"); const next = await fetchOriginals(f.opts, { fetch }); assert.equal(calls, 2); assert.equal(next.claimed, 0); assert.equal(next.reused, 2); assert.equal(next.states.needs_review, 3);
  const error = JSON.parse(await readFile(join(f.output, "responses", sha256("https://example.org/fail") + ".json"), "utf8")); assert.equal(error.errorKind, "TypeError"); assert.ok(!JSON.stringify(error).includes("sensitive"));
});

test("bounded claiming, cache integrity and frozen preparation identity", async () => {
  const f = await fixture(); let calls = 0;
  const fetch = async (url: string) => { calls++; return { status: 403, url, headers: new Headers(), body: Buffer.from("denied"), text: () => "denied" }; };
  const first = await fetchOriginals({ ...f.opts, maxItems: 1, concurrency: 1 }, { fetch }); assert.equal(calls, 1); assert.equal(first.states.not_claimed, 1);
  const file = join(f.output, "responses", sha256("https://example.org/article") + ".json"), cache = JSON.parse(await readFile(file, "utf8")); cache.sourceUrl = "https://example.org/wrong"; await writeFile(file, JSON.stringify(cache));
  await assert.rejects(fetchOriginals(f.opts, { fetch }), /Cache identity mismatch/);
  await writeFile(join(f.prep, "input.jsonl"), "changed"); await assert.rejects(fetchOriginals(f.opts, { fetch }), /snapshot mismatch/);
});

test("result hash mismatch and excessive concurrency make no requests", async () => {
  const f = await fixture(); let calls = 0;
  const fetch = async (): Promise<never> => { calls++; throw new Error("not called"); };
  await assert.rejects(fetchOriginals({ ...f.opts, concurrency: 9 }, { fetch }), /concurrency/);
  const file = join(f.prep, "results", sha256("a:hash") + ".json"), r = JSON.parse(await readFile(file, "utf8")); r.inputHash = "wrong"; await writeFile(file, JSON.stringify(r));
  await assert.rejects(fetchOriginals(f.opts, { fetch }), /result mismatch/); assert.equal(calls, 0);
});

 test("eight workers cap concurrent requests and interrupted claims stay pending", async () => {
  const f = await fixture(Array.from({length: 12}, (_, i) => `extra${i}`));
  let active = 0, peak = 0;
  const fetch = async (url: string) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 5)); active--;
    return { status: 200, url, headers: new Headers({"content-type":"text/html"}), body: Buffer.from(html), text: () => html };
  };
  const result = await fetchOriginals({...f.opts, maxItems: 14}, {fetch});
  assert.equal(result.claimed, 14); assert.equal(peak, 8); assert.equal(active, 0);
  const second = await fixture(), controller = new AbortController(); controller.abort();
  const stopped = await fetchOriginals({...second.opts, signal: controller.signal}, {fetch});
  assert.equal(stopped.claimed, 0); assert.equal(stopped.states.not_claimed, 3);
});

test("BLOCK with unknown settlement stays todo; only settled filtered results are skipped", async () => {
  for (const state of ["error", "filtered"]) {
    const f = await fixture();
    const file = join(f.prep, "results", sha256("blocked:hash") + ".json");
    const result = JSON.parse(await readFile(file, "utf8"));
    Object.assign(result, { state, label: "BLOCK", receiptId: 42, receiptCompleted: false, errorKind: "receipt_unknown" });
    await writeFile(file, JSON.stringify(result));
    const controller = new AbortController(); controller.abort();
    await fetchOriginals({ ...f.opts, signal: controller.signal }, { fetch: async () => { throw new Error("must not fetch"); } });
    const items = (await readFile(join(f.output, "items.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const blocked = items.find(r => r.key === "blocked:hash");
    assert.equal(blocked.state, "todo"); assert.equal(blocked.reason, "preparation_unresolved");
  }
});

test("old cached prefix cannot spend the next uncached target's claiming window", async () => {
  const f = await fixture(); let calls = 0;
  const fetch = async (url: string) => { calls++; return { status: 403, url, headers: new Headers(), body: Buffer.from("denied"), text: () => "denied" }; };
  await fetchOriginals({...f.opts, maxItems: 1, concurrency: 1}, {fetch});
  assert.equal(calls, 1);
  // The old eager deadline sampled zero before reading cache, then 91s after it.
  // A lazy deadline takes its first sample only at the uncached target.
  let clockReads = 0;
  const next = await fetchOriginals({...f.opts, seconds: 90, concurrency: 1}, {fetch, now: () => clockReads++ === 0 ? 0 : 91_000});
  assert.equal(next.reused, 1); assert.equal(next.claimed, 1); assert.equal(calls, 2);
});

test("claiming window still stops later uncached targets after the first claim", async () => {
  const f = await fixture(); let time = 0;
  const fetch = async (url: string) => { time = 91_000; return { status: 403, url, headers: new Headers(), body: Buffer.from("denied"), text: () => "denied" }; };
  const result = await fetchOriginals({...f.opts, seconds: 90, concurrency: 1}, {fetch, now: () => time});
  assert.equal(result.claimed, 1); assert.equal(result.states.not_claimed, 1);
});
