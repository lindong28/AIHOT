// Reduced shapes observed in LMSYS/Runway Flight scripts and Claude release-note headings.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const posts = [
  { title: 'Nested [array] and "quoted" title', slug: "one", date: "2026-09-28", categories: [{ tags: ["AI", "research"] }] },
  { title: "Second article", slug: "two", date: "2026-09-29", categories: [] },
];
const flight = (value: unknown) => `<script>self.__next_f.push(${JSON.stringify([1, `8:${JSON.stringify(value)}\n`])})</script>`;
const pages: Record<string, string> = {
  "/filtered": flight({ posts: [
    { title: "Published threat", slug: "threat", fields: { category: "threat-intelligence", isDraft: false } },
    { title: "Draft threat", slug: "draft", fields: { category: "threat-intelligence", isDraft: true } },
    { title: "Blog", slug: "blog", fields: { category: "blog", isDraft: false } },
    { title: "Number", slug: "number", fields: { category: 1 } },
    { title: "String", slug: "string", fields: { category: "1" } },
    { title: "Boolean", slug: "boolean", fields: { category: false } },
    { title: "Null", slug: "null", fields: { category: null } },
    { title: "Missing", slug: "missing", fields: {} },
  ] }),
  "/flight": flight(["$", "$L6", null, { posts, other: [1, 2] }]),
  "/plain": `<script type="application/json">${JSON.stringify({ props: { posts } })}</script>`,
  "/missing": flight({ other: posts }),
  "/broken": '<script>self.__next_f.push([1,"8:{\\"posts\\":[{\\"title\\":\\"broken\\"}"])</script>',
  "/empty": flight({ posts: [] }),
  "/releases": '<article><h3 id="september-28">September 28, 2026<span><button>\uE09A</button></span></h3><p>A new release.</p><h3 id="september-27">September 27, 2026<a class="hash-link">#</a></h3><p>Another release.</p></article>',
};
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(pages[req.url ?? ""] ?? "");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
config.allowPrivateNetworkFetch = true;
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
const defaults = { name: "Test source", tier: "T1", participation_mode: "editorial" as const, first_party: true, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0 };
const source = (path: string): SourceRow => ({ ...defaults, id: "test-import", kind: "json_list", config: {
  url: `${base}${path}`, mode: "html_json_key", jsonKey: "posts", titlePaths: ["title"],
  publishedAtPath: "date", urlTemplate: "https://example.org/{slug}",
} });

test("Flight and plain JSON preserve all nested-array entries, titles and dates", async () => {
  for (const path of ["/flight", "/plain"]) {
    const items = await fetchJsonList(source(path));
    assert.deepEqual(items.map((x) => [x.title, x.url, x.publishedAt?.toISOString()]), posts.map((p) => [p.title, `https://example.org/${p.slug}`, `${p.date}T00:00:00.000Z`]));
  }
  assert.deepEqual(await fetchJsonList(source("/empty")), []);
  for (const path of ["/missing", "/broken"]) await assert.rejects(fetchJsonList(source(path)), /embedded key posts not found/);
});

test("release-note date headings exclude copy buttons and anchor decoration", async () => {
  const items = await fetchWebList({ ...defaults, id: "test-releases", kind: "web_list", config: { url: `${base}/releases`, parseMode: "docusaurus_changelog", preserveUrlFragment: true } });
  assert.deepEqual(items.map((x) => [x.title, x.publishedAt?.toISOString(), x.bodyText]), [
    ["September 28, 2026", new Date("September 28, 2026").toISOString(), "A new release."],
    ["September 27, 2026", new Date("September 27, 2026").toISOString(), "Another release."],
  ]);
  assert.notEqual(items[0]!.identityKey, items[1]!.identityKey);
});

test("JSON value filter is strict, distinguishes missing from null, and combines with draft filter", async () => {
  for (const [equals, expected] of [["threat-intelligence", ["Published threat", "Draft threat"]], [1, ["Number"]], ["1", ["String"]], [false, ["Boolean"]], [null, ["Null"]], ["absent", []]] as const) {
    const s = source("/filtered");
    s.config.requireValue = { path: "fields.category", equals };
    assertSupportedConfig(s.kind, s.config);
    assert.deepEqual((await fetchJsonList(s)).map((x) => x.title), expected);
  }
  const s = source("/filtered");
  s.config.requireValue = { path: "fields.category", equals: "threat-intelligence" };
  s.config.requireBoolean = { path: "fields.isDraft", equals: false };
  assert.deepEqual((await fetchJsonList(s)).map((x) => x.title), ["Published threat"]);
  delete s.config.requireValue;
  assert.deepEqual((await fetchJsonList(s)).map((x) => x.title), ["Published threat", "Blog"]);
});

test("JSON value filter rejects malformed configuration", () => {
  for (const requireValue of [null, [], "category", {}, { path: "" , equals: "blog" }, { path: "fields.category" }, { path: "fields.category", equals: [] }, { path: "fields.category", equals: {} }, { path: "fields.category", equals: "blog", typo: true }]) {
    assert.throws(() => assertSupportedConfig("json_list", { requireValue }), /requireValue/);
  }
});
