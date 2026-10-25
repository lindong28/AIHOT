import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { modelImage } from "../packages/backend/src/media/model-image.ts";
import { summarizeLlmInput } from "../packages/backend/src/providers/input-summary.ts";

test("firstImagePart uses a model still and leaves cached browser animation intact", async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createHash } = await import("node:crypto");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "aihot-model-image-"));
  process.env.AIHOT_DATA_DIR = dir;
  process.env.DATABASE_URL = "postgres://127.0.0.1:5432/aihot_model_media_test";
  process.env.MODEL_CALLS_ENABLED = "false";
  process.env.COLLECT_ENABLED = "false";
  const { firstImagePart } = await import("../packages/backend/src/editorial/input.ts");
  const { produceImage } = await import("../packages/backend/src/media/images.ts");
  const url = "https://example.invalid/model-fixture.webp";
  const key = createHash("sha256").update(`thumb|${url}`).digest("hex");
  const file = path.join(dir, "imgcache", key.slice(0, 2), key);
  const original = await animation("webp");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await writeFile(`${file}.type`, "image/webp");
    const article: Parameters<typeof firstImagePart>[0] = {
      id: "fixture", revision: 1, title: "fixture", url, author: null, publishedAt: null,
      bodyText: null, excerpt: null, xPost: null, media: [{ kind: "image", url }],
      source: { name: "fixture", kind: "rss", tier: "primary", firstParty: true },
    };
    const part = await firstImagePart(article);
    assert.equal(part?.type, "image_url");
    if (part?.type !== "image_url") throw new Error("image part missing");
    assert.ok(part.image_url.url.startsWith("data:image/jpeg;base64,"));
    const summary = await summarizeLlmInput([part]);
    assert.equal(summary.images[0]!.frames, 1);
    assert.equal(summary.images[0]!.format, "jpeg");
    assert.deepEqual(await readFile(file), original);
    assert.deepEqual((await produceImage(url, "thumb")).body, original);
    assert.deepEqual(await firstImagePart(article, { cacheOnly: true }), part);
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error("network forbidden"); };
    try {
      await assert.rejects(firstImagePart({ ...article, media: [{ kind: "image", url: `${url}?uncached` }] }, { cacheOnly: true }), { code: "ENOENT" });
      assert.equal(await firstImagePart({ ...article, media: [] }, { cacheOnly: true }), null);
      assert.equal(fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    await writeFile(file, "invalid image");
    assert.equal(await firstImagePart(article), null);
    await assert.rejects(firstImagePart(article, { cacheOnly: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
    const { closeDb } = await import("../packages/backend/src/db.ts");
    await closeDb();
  }
});

async function animation(format: "gif" | "webp") {
  const pixels = Buffer.from([...Array(16).fill([255, 0, 0]).flat(), ...Array(16).fill([0, 0, 255]).flat()]);
  const image = sharp(pixels, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } });
  return format === "gif" ? image.gif({ delay: [80, 160] }).toBuffer() : image.webp({ lossless: true, delay: [80, 160] }).toBuffer();
}

for (const format of ["gif", "webp"] as const) {
  test(`model image extracts first frame of ${format} without mutating source`, async () => {
    const input = await animation(format);
    const saved = Buffer.from(input);
    assert.equal((await sharp(input).metadata()).pages, 2);
    const result = await modelImage(input);
    const meta = await sharp(result.body).metadata();
    assert.equal(result.type, "image/jpeg");
    assert.equal(meta.pages ?? 1, 1);
    assert.equal(meta.width, 4);
    assert.equal(meta.height, 4);
    const { data } = await sharp(result.body).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[0]! > 240 && data[2]! < 15);
    assert.deepEqual(input, saved);
  });
}

for (const [width, height] of [[1440, 800], [560, 1200], [16, 12]]) {
  test(`model image bounds static ${width}x${height} without enlarging`, async () => {
    const input = await sharp({ create: { width: width!, height: height!, channels: 4, background: "#176b75" } }).png().toBuffer();
    const result = await modelImage(input);
    const meta = await sharp(result.body).metadata();
    const scale = Math.min(1, 720 / width!, 720 / height!);
    assert.equal(meta.width, Math.round(width! * scale));
    assert.equal(meta.height, Math.round(height! * scale));
    assert.equal(meta.hasAlpha, false);
  });
}

test("model image rejects invalid and excessive-pixel input", async () => {
  await assert.rejects(modelImage(Buffer.from("not an image")));
  await assert.rejects(modelImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"></svg>')), /pixel limit/);
});

test("summary separates text from image payload and preserves original input", async () => {
  const body = await animation("webp");
  const user = [{ type: "text" as const, text: "正文abc" }, { type: "image_url" as const, image_url: { url: `data:image/webp;base64,${body.toString("base64")}` } }];
  const before = JSON.stringify(user);
  const summary = await summarizeLlmInput(user);
  assert.equal(summary.textChars, 5);
  assert.equal(summary.imageCount, 1);
  assert.equal(summary.imagesTruncated, false);
  assert.deepEqual(summary.images, [{ status: "ok", format: "webp", bytes: body.length, width: 4, height: 4, frames: 2 }]);
  assert.equal(JSON.stringify(user), before);
  assert.ok(!JSON.stringify(summary).includes("data:"));
  assert.ok(before.length > summary.textChars);
  assert.equal((await summarizeLlmInput("普通文字")).textChars, 4);
});

test("summary bounds metadata work and reports unreadable or remote images without their contents", async () => {
  const user = Array.from({ length: 18 }, (_, i) => ({ type: "image_url" as const, image_url: { url: i ? "data:image/png;base64,YmFk" : "https://example.invalid/private?secret=value" } }));
  const summary = await summarizeLlmInput(user);
  assert.equal(summary.imageCount, 18);
  assert.equal(summary.images.length, 16);
  assert.equal(summary.imagesTruncated, true);
  assert.equal(summary.images[0]!.status, "remote");
  assert.equal(summary.images[1]!.status, "unreadable");
  assert.ok(!JSON.stringify(summary).includes("secret"));
});
