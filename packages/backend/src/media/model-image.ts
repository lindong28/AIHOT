import sharp from "sharp";
import { IMAGE_WIDTHS } from "./renditions.ts";

/** A model-only still; never overwrite the browser rendition or decode all animation frames. */
export async function modelImage(body: Buffer): Promise<{ body: Buffer; type: "image/jpeg" }> {
  return {
    body: await sharp(body, { page: 0, pages: 1, animated: false })
      .rotate()
      .resize({ width: IMAGE_WIDTHS.thumb, height: IMAGE_WIDTHS.thumb, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82 })
      .toBuffer(),
    type: "image/jpeg",
  };
}
