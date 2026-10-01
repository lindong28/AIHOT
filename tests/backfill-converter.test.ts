import "./setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { entryIdentity } from "@aihot/backend/backfill/manifest";

test("one-time converter strips legacy derivations and requires version-bound completeness evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backfill-converter-"));
  try {
    const raw = { source_id: "old", url: "https://example.com/original", title: "Original", published_at: "2026-06-01T00:00:00Z", content_text: "Complete short announcement.", content_html: "<p>Complete short announcement.</p>", score: 100, tags: ["old"], summary: "OLD DERIVATION" };
    await writeFile(join(dir,"raw.jsonl"), [raw, {...raw, url:"https://x.com/author/status/12345"}, {...raw, url:"https://example.com/missing",content_text:""}].map(r=>JSON.stringify(r)).join("\n"));
    await writeFile(join(dir,"map.json"), JSON.stringify({old:"native"}));
    await writeFile(join(dir,"reviews.json"), "{}");
    const run = (output:string) => promisify(execFile)(process.execPath,["scripts/prepare-radar-backfill.ts",join(dir,"map.json"),join(dir,"reviews.json"),join(dir,output),join(dir,"raw.jsonl")], {timeout:15000});
    await run("first.jsonl");
    const first = (await readFile(join(dir,"first.jsonl"),"utf8")).trim().split("\n").map(s=>JSON.parse(s));
    assert.equal(first.length,2);
    assert.ok(first.every(e=>e.quality.state==="unverified"));
    assert.ok(!JSON.stringify(first).includes("OLD DERIVATION"));
    assert.ok(first.every(e=>!("score" in e.material)&&!("tags" in e.material)));
    const reviews = Object.fromEntries(first.map(e=>[entryIdentity(e),{contentHash:e.quality.contentHash,state:"complete",evidence:"Original compared to publisher copy"}]));
    await writeFile(join(dir,"reviews.json"),JSON.stringify(reviews));
    await run("reviewed.jsonl");
    const reviewed = (await readFile(join(dir,"reviewed.jsonl"),"utf8")).trim().split("\n").map(s=>JSON.parse(s));
    assert.equal(reviewed[0].quality.state,"complete");
    assert.equal(reviewed[1].quality.state,"unverified","X without reconstructed context is not approved by a bare body review");
    await writeFile(join(dir,"raw.jsonl"),JSON.stringify({...raw,content_text:"Different version"}));
    await run("changed.jsonl");
    assert.equal(JSON.parse((await readFile(join(dir,"changed.jsonl"),"utf8")).trim()).quality.state,"unverified");
    const summary=JSON.parse(await readFile(join(dir,"reviewed.jsonl.summary.json"),"utf8"));
    assert.equal(summary.rejected.missing_body,1);
    assert.deepEqual(summary.intervals,[{start:"2026-06-01",end:"2026-06-01",days:1}]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
