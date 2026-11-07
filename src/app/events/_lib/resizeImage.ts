/**
 * Downscale an image in the browser to fit maxW×maxH (preserving aspect ratio)
 * and re-encode as WebP (JPEG where the browser cannot encode WebP). Lifted verbatim from CcaImageField's resizeToWebp — the
 * resize is CONVENIENCE, not a control; the authoritative cap is
 * maximumSizeInBytes in /api/event/upload. Kept in its own client-only module so
 * the banner and gallery fields share exactly one implementation.
 */
export async function resizeToWebp(
  file: File,
  maxW: number,
  maxH: number,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  const scale = Math.min(1, maxW / bitmap.width, maxH / bitmap.height);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("CANVAS_UNAVAILABLE");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const webp = await encode(canvas, "image/webp");
  // Safari before 17 cannot encode WebP and silently hands back a PNG instead.
  // A PNG banner is several times the size (often past the upload cap) and was
  // uploaded labelled image/webp, so fall back to JPEG there. Callers upload
  // with the returned blob's own `type`.
  if (webp.type === "image/webp") return webp;
  return encode(canvas, "image/jpeg");
}

async function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, 0.85),
  );
  if (!blob) throw new Error("ENCODE_FAILED");
  return blob;
}
