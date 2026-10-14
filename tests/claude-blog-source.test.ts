import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fromHtml } from "@aihot/backend/sources/web-list";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const source = JSON.parse(readFileSync(new URL("../industry/sources.json", import.meta.url), "utf8")).sources.find((s: SourceRow) => s.id === "radar-claude-blog") as SourceRow;
const html = readFileSync(new URL("fixtures/claude-articles.html", import.meta.url), "utf8");

test("Claude Blog collects migrated article cards, dates and titles without duplicate or navigation entries", () => {
  assertSupportedConfig(source.kind, source.config);
  const articles = fromHtml(html, source.config.url, source);
  assert.deepEqual(articles.map((a) => [a.url, a.title, a.publishedAt?.getTime()]), [
    ["dashboards-and-motion", "Build live dashboards and animate explainers with Claude", "Oct 8, 2026"],
    ["uber-s-ciso-on-building-an-insider-threat-program-for-ai", "Uber's CISO on building an insider threat program for AI", "Oct 13, 2026"],
    ["how-block-orchestrates-claude-fable-across-thousands-of-pull-requests", "How Block orchestrates Claude Fable across thousands of pull requests", "Oct 8, 2026"],
    ["how-comcast-booz-allen-use-claude-mythos-to-secure-their-codebases", "How Comcast and Booz Allen use Claude Mythos to find exploit chains and secure their codebases", "Oct 6, 2026"],
    ["claude-now-works-in-google-docs-sheets-and-slides", "Claude now works with Google Docs, Sheets, and Slides", "Oct 6, 2026"],
    ["were-expanding-the-claude-startups-program-to-help-founders-build", "We’re expanding the Claude Startups program to help founders build", "Oct 6, 2026"],
  ].map(([slug, title, date]) => [`https://claude.com/resources/articles/${slug}`, title, new Date(date!).getTime()]));
});
