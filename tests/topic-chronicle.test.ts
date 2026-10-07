import assert from "node:assert/strict";
import { test } from "node:test";
import { chronicleDate, selectTopicChronicle, type ChronicleReport, type ChronicleTopic } from "@aihot/backend/publication/topic-chronicle";
import { companyMilestones, parseChronicle } from "@aihot/backend/publication/chronicles";

const now = new Date("2026-10-07T12:00:00+08:00");
const video: ChronicleTopic = { slug: "video", grp: "field", entity_id: null, tags: ["视频"] };
const company: ChronicleTopic = { slug: "openai", grp: "company", entity_id: "openai", tags: [] };
const report = (id: string, patch: Partial<ChronicleReport> = {}): ChronicleReport => ({
  id, title: "字节发布 Seedance 2.5", category: "ai-models", tags: ["视频", "entity:openai"], score: 85,
  sourceId: "official", firstParty: true, publishedAt: "2026-10-02T00:00:00Z", timelineAt: "2026-10-03T00:00:00Z",
  factId: id, storyPublicId: "same-story", subject: "OpenAI", action: "launch", object: "Seedance 2.5",
  occurredAt: "2026-10-01", subjects: ["openai"], itemType: "model_release", ...patch,
});
const events = (rows: ChronicleReport[], topic = video, through?: string) => selectTopicChronicle(topic, rows, now, through).flatMap(m => m.events);

test("different facts in one story retain their own titles and occurrence dates", () => {
  const picked = events([
    report("model", { title: "发布模型", occurredAt: "2026-09-28" }),
    report("api", { title: "开放 API", category: "ai-products", occurredAt: "2026-10-02", score: 90 }),
  ]);
  assert.equal(picked.length, 2);
  assert.deepEqual(picked.map(e => [e.title, e.at]), [["开放 API", "2026-10-01T16:00:00.000Z"], ["发布模型", "2026-09-27T16:00:00.000Z"]]);
  assert.equal(new Set(picked.map(e => e.href)).size, 1);
});

test("one fact merges reports and keeps its earliest public fallback date", () => {
  const a = report("a", { factId: "one", occurredAt: null, publishedAt: "2026-09-28", title: "第一条报道" });
  const b = report("b", { factId: "one", occurredAt: "not-a-date", publishedAt: "2026-10-03", title: "详细发布报道", score: 90 });
  assert.deepEqual(events([b, a]).map(e => [e.title, e.at]), [["详细发布报道", "2026-09-27T16:00:00.000Z"]]);
  assert.deepEqual(events([a, b]), events([b, a]));
});

test("structured fallback preserves owner, complete model family and variants irrespective of case", () => {
  const common = { factId: null, storyPublicId: null };
  const rows = [
    report("deepseek", { ...common, subject: "DeepSeek", object: "DeepSeek V4", title: "DeepSeek 发布 V4" }),
    report("mimo", { ...common, subject: "Xiaomi", object: "MiMo-V4", title: "小米发布 MiMo-V4" }),
    report("flash", { ...common, subject: "Google", object: "Gemini 3 flash", title: "Gemini 3 flash 发布" }),
    report("pro", { ...common, subject: "Google", object: "Gemini 3 pro", title: "Gemini 3 pro 发布" }),
    report("flash-copy", { ...common, subject: "GOOGLE", object: " Gemini  3 FLASH ", title: "另一来源 Gemini 3 Flash 发布", sourceId: "press" }),
  ];
  assert.equal(events(rows).length, 4);
  assert.equal(events(rows.map(r => ({ ...r, object: r.object?.toUpperCase() ?? null }))).length, 4);
});

test("missing identity fields never collapse unrelated historical articles", () => {
  for (const field of ["subject", "action", "object", "occurredAt"] as const) {
    const patch = { factId: null, storyPublicId: null, [field]: null };
    assert.equal(events([report("a", patch), report("b", patch)]).length, 2, field);
  }
  assert.equal(events([report("a", { factId: null }), report("b", { factId: null, occurredAt: "2026-10-02" })]).length, 2);
});

test("topic membership uses tags, and suffixes do not veto an already released model", () => {
  for (const title of ["字节发布 Seedance 2.5", "OpenAI 发布 GPT-9，免费开放使用", "OpenAI 发布 GPT-9，并预告下周推出新工具", "OpenAI 发布 GPT-9 免费开放使用"]) {
    assert.equal(events([report("a", { title })]).length, 1, title);
  }
  assert.equal(events([report("a", { tags: ["语音"] })]).length, 0);
  for (const title of ["预告下周发布 GPT-9", "如何使用 GPT-9", "模型发布合集"]) assert.equal(events([report("a", { title })]).length, 0);
  assert.equal(events([report("a", { itemType: "tutorial_explainer" })]).length, 0);
});

test("company ownership prefers structured subjects and never repairs another owner using tags", () => {
  assert.equal(events([report("a")], company).length, 1);
  assert.equal(events([report("a", { subject: "Google" })], company).length, 0);
  assert.equal(events([report("a", { subject: "Unknown Inc" })], company).length, 0);
  assert.equal(events([report("a", { subject: null })], company).length, 1);
  assert.equal(events([report("a", { subject: null, subjects: [], tags: ["entity:openai"] })], company).length, 1);
  assert.equal(events([report("a", { subject: null, subjects: [], tags: ["entity:openai", "entity:google"] })], company).length, 0);
});

test("Chinese action prefixes exclude unreleased plans and commentary even without an occurrence date", () => {
  for (const action of ["预告", "preview release", "预告发布", "评测模型", "讲解功能"]) {
    assert.equal(events([report("plan", { title: "OpenAI 公布 GPT-9 发布计划", action, occurredAt: null })]).length, 0, action);
  }
  assert.equal(events([report("launch", { title: "OpenAI 发布 GPT-9，免费开放使用", action: "发布", occurredAt: null })]).length, 1);
});

test("real calendar dates, future exclusion, Beijing month boundary and twelve calendar months", () => {
  assert.equal(chronicleDate("2026-02-30"), null);
  assert.equal(chronicleDate("2026-02-30T12:00:00Z"), null);
  assert.ok(chronicleDate("2024-02-29"));
  assert.equal(events([report("future", { occurredAt: "2026-10-08" })]).length, 0);
  const months = selectTopicChronicle(video, [
    report("old", { occurredAt: "2025-10-31T15:59:59Z" }),
    report("start", { occurredAt: "2025-10-31T16:00:00Z" }),
    report("boundary", { occurredAt: "2026-09-30T16:00:00Z" }),
    report("invalid", { occurredAt: "2026-02-30", publishedAt: null }),
  ], now);
  assert.deepEqual(months.map(m => m.month), ["2026-10", "2025-11"]);
  assert.equal(months.flatMap(m => m.events).length, 3);
  assert.equal(events([report("cut", { occurredAt: "2026-09-30" }), report("after")], video, "2026-09").length, 1);
});

test("monthly quotas, kind thresholds and genre restrictions are stable under input order", () => {
  const rows = Array.from({ length: 10 }, (_, i) => report(String(i), { score: 76 + i }));
  const picked = events(rows);
  assert.equal(picked.length, 5);
  assert.deepEqual(picked, events([...rows].reverse()));
  assert.equal(events(rows, company).length, 3);
  assert.equal(events(rows, { ...video, grp: "genre", slug: "model-releases" }).length, 8);
  assert.equal(events(rows, { ...video, grp: "genre", slug: "papers" }).length, 0);
  assert.equal(events([report("low", { score: 74 })]).length, 0);
  assert.equal(events([report("low", { score: 70 })], company).length, 1);
});

test("curated files retain date precision and optional single links, rejecting impossible dates", () => {
  const raw = { topic: "openai", through: "2026-09", events: [
    { date: "2020", kind: "company", title: "成立", major: true },
    { date: "2024-02", kind: "model", title: "新模型", url: "https://example.com/model" },
    { date: "2024-02-29", kind: "product", title: "产品", item: "a" },
  ] };
  const parsed = parseChronicle(raw, company);
  assert.deepEqual(companyMilestones(parsed, [], now).map(e => e.date), ["2020", "2024-02", "2024-02-29"]);
  for (const patch of [{ date: "2026-02-30" }, { date: "2026-13" }, { date: "2026-10" }, { kind: "unknown" }, { url: "http://example.com" }, { item: "b", url: "https://example.com" }]) {
    assert.throws(() => parseChronicle({ ...raw, events: [{ ...raw.events[0], ...patch }] }, company));
  }
  assert.throws(() => parseChronicle(raw, video));
  assert.equal(companyMilestones(parseChronicle({ ...raw, through: "2027-01", events: [{ ...raw.events[0], date: "2027" }] }, company), [], now).length, 0);
});
