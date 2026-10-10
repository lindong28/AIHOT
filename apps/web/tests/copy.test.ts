import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCopyFile, renderMarkdown } from "../app/lib/markdown.ts";

test("a short legal document renders its title once and preserves every body paragraph", () => {
  const doc = parseCopyFile("# 使用规则\n\n第一段。\n\n第二段。");
  assert.equal(doc.title, "使用规则");
  assert.equal(renderMarkdown(doc.body).html, "<p>第一段。</p>\n<p>第二段。</p>");
  const sectioned = parseCopyFile("# 隐私说明\n\n## 本地数据\n\n仅在本机。");
  assert.equal(sectioned.body, "## 本地数据\n\n仅在本机。");
});
