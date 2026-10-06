import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import { planXShards } from "@aihot/backend/sources/x";

const { sources } = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
test("imported sources use implemented configurations and unique identities", () => {
  assert.equal(new Set(sources.map((s: any) => s.id)).size, sources.length);
  for (const source of sources) assertSupportedConfig(source.kind, source.config);
  const feeds = sources.filter((s: any) => s.kind === "rss").map((s: any) => s.config.feedUrl);
  assert.equal(new Set(feeds).size, feeds.length);
  assert.ok(!sources.some((s: any) => /mp2rss/i.test(JSON.stringify(s))));
  for (const domain of ["research.google", "mistral.ai", "sierra.ai"]) {
    const entries = sources.filter((s: any) => new URL(s.config.feedUrl ?? s.config.url ?? "https://example.invalid").hostname === domain);
    assert.equal(entries.length, 1, `${domain}: keep the feed without a duplicate web collector`);
    assert.equal(entries[0].kind, "rss");
  }
});

test("all migrated X accounts fit native shard collection without duplicate handles", () => {
  const accounts = sources.filter((s: any) => s.kind === "x_search");
  assert.equal(accounts.length, 113); // 109 migrated accounts plus four added from the video-source audit.
  const handles = accounts.map((s: any) => s.config.query.toLowerCase());
  assert.equal(new Set(handles).size, accounts.length);
  assert.deepEqual(planXShards(accounts), [], "first imports stay individual until each has a watermark");
  const ids = planXShards(accounts.map((s: any) => ({ ...s, cursor: { lastTweetId: "2000000000000000000" } }))).flatMap((s) => s.sourceIds).sort();
  assert.deepEqual(ids, accounts.map((s: any) => s.id).sort());
});
