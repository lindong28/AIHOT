import sharp from "sharp";
import type { ContentPart } from "./llm.ts";

// A diagnostic projection, not validation or a change to the request identity.
const MAX_IMAGE_SUMMARIES = 16;
const FORMATS = new Set(["jpeg", "png", "webp", "gif", "avif", "heif", "tiff", "svg", "pdf", "jp2", "jxl", "magick", "ppm", "fits", "vips", "raw"]);
interface ImageSummary {
  status: "ok" | "remote" | "unreadable" | "unsupported";
  format: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  frames: number | null;
}

function count(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function summarizeImage(url: string): Promise<ImageSummary> {
  const result: ImageSummary = { status: "unsupported", format: null, bytes: null, width: null, height: null, frames: null };
  if (!url.startsWith("data:")) return { ...result, status: "remote" };
  const comma = url.indexOf(",");
  if (comma < 0 || comma > 128 || !/^data:image\/[a-z0-9.+-]+;base64$/i.test(url.slice(0, comma))) return result;
  const body = Buffer.from(url.slice(comma + 1), "base64");
  result.bytes = body.length;
  try {
    // Header metadata only; keep Sharp's input pixel limit and never request every frame.
    const meta = await sharp(body, { page: 0, pages: 1, animated: false }).metadata();
    return { ...result, status: "ok", format: meta.format && FORMATS.has(meta.format) ? meta.format : "other",
      width: count(meta.width), height: count(meta.pageHeight ?? meta.height), frames: count(meta.pages ?? 1) };
  } catch {
    return { ...result, status: "unreadable" };
  }
}

/** Text characters use JS string.length; serialized JSON and base64 are not text. No URLs or content are retained. */
export async function summarizeLlmInput(user: string | ContentPart[]) {
  let textChars = 0;
  let imageCount = 0;
  const images: ImageSummary[] = [];
  if (typeof user === "string") textChars = user.length;
  else for (const part of user) {
    if (part.type === "text") textChars += part.text.length;
    else if (part.type === "image_url") {
      imageCount++;
      if (images.length < MAX_IMAGE_SUMMARIES) images.push(await summarizeImage(part.image_url.url));
    }
  }
  return { textChars, imageCount, images, imagesTruncated: imageCount > images.length };
}
