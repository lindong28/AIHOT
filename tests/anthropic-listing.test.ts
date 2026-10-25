import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHtml } from "@aihot/backend/sources/web-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const catalog = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8"));
const sources = (Array.isArray(catalog) ? catalog : catalog.sources) as SourceRow[];
// Reduced from both public listings observed on 2026-10-25: dates are siblings of title links.
const html = `<main><nav><a href="/research/team/alignment">Alignment</a></nav>
<article class="FeaturedGrid-module__tile"><header><a href="/news/announcements">Announcements</a><time>Oct 18, 2026</time></header><a class="FeaturedGrid-module__tileLink" href="/research/featured"><h3>Featured article</h3><p>Not part of the title</p></a></article>
<div class="HeroCarousel-module__carousel-info-body"><header><time>Oct 20, 2026</time></header><a class="HeroCarousel-module__carousel-info-link" href="/research/carousel"><h2>Carousel article</h2></a></div>
<article data-listing-row><header><a href="/research/team/alignment">Alignment</a><time>Oct 23, 2026</time></header><a class="AssetItem-module__metaTitleLink" href="/research/listed"><h3>Listed article</h3></a></article>
<div class="TableView-module__summary"><time>Oct 22, 2026</time><a class="TableView-module__title-link" href="/research/table"><h4>Table article</h4></a></div>
<article data-listing-row><time>Oct 23, 2026</time><a class="AssetItem-module__metaTitleLink" href="/research/listed"><h3>Listed article</h3></a></article></main>`;

for (const id of ["radar-anthropic-news", "radar-anthropic-research"]) {
  test(`${id} extracts all four current listing structures without navigation or duplicate articles`, () => {
    const source = sources.find((s) => s.id === id)!;
    const rows = fromHtml(html, source.config.url, source);
    assert.deepEqual(rows.map((r) => r.title), ["Featured article", "Carousel article", "Listed article", "Table article"]);
    assert.deepEqual(rows.map((r) => new URL(r.url).pathname), ["/research/featured", "/research/carousel", "/research/listed", "/research/table"]);
    assert.ok(rows.every((r) => r.publishedAt instanceof Date && Number.isFinite(r.publishedAt.getTime())));
    assert.equal(fromHtml('<nav><a href="/research/team/alignment">Alignment</a></nav>', source.config.url, source).length, 0);
  });
}
