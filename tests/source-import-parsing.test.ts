// Reduced shapes observed in LMSYS/Runway Flight scripts and Claude release-note headings.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const posts = [
  { title: 'Nested [array] and "quoted" title', slug: "one", date: "2026-09-28", categories: [{ tags: ["AI", "research"] }] },
  { title: "Second article", slug: "two", date: "2026-09-29", categories: [] },
];
const flight = (value: unknown) => `<script>self.__next_f.push(${JSON.stringify([1, `8:${JSON.stringify(value)}\n`])})</script>`;
const pages: Record<string, string> = {
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
