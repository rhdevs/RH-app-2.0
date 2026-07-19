"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { upload } from "@vercel/blob/client";

import { Button } from "~/components/ui/button";
import {
  ccaUploadPath,
  LOGO_MAX_PX,
  BANNER_MAX_W,
  BANNER_MAX_H,
  UPLOAD_MAX_BYTES,
  type CcaImageKind,
} from "~/lib/schemas/cca";

/**
 * Pick an image, downscale it in the browser, upload it straight to Vercel
 * Blob, and hand the resulting URL to the parent form.
 *
 * THE RESIZE IS CONVENIENCE, NOT A CONTROL. It runs on the client, so it can
 * be bypassed with devtools. What actually caps the upload is
 * `maximumSizeInBytes` in /api/cca/upload, enforced by Vercel when it mints
 * the token. The resize exists so that an honest head uploading a 12 MB phone
 * photo doesn't consume 12 MB of the store — which, across 89 CCAs, is the
 * difference between ~60 MB of storage and ~1 GB.
 *
 * The upload happens on SELECT, not on save. That means abandoning the form
 * after choosing a file leaves an orphaned blob. Accepted: it keeps the form
 * simple, and orphans are reconcilable later by diffing `list()` against
 * CcaProfile.
 */

/** Downscale to fit within maxW×maxH, preserving aspect ratio, re-encoded WebP. */
async function resizeToWebp(
  file: File,
  maxW: number,
  maxH: number,
): Promise<Blob> {
  // `imageOrientation: "from-image"` applies EXIF rotation. Without it, photos
  // taken in portrait on a phone upload sideways — canvas drawImage ignores
  // EXIF on its own.
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

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.85),
  );
  if (!blob) throw new Error("ENCODE_FAILED");
  return blob;
}

export default function CcaImageField({
  ccaID,
  kind,
  label,
  help,
  value,
  onChange,
  disabled = false,
}: {
  ccaID: number;
  kind: CcaImageKind;
  label: string;
  help: string;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isLogo = kind === "logo";
  const maxW = isLogo ? LOGO_MAX_PX : BANNER_MAX_W;
  const maxH = isLogo ? LOGO_MAX_PX : BANNER_MAX_H;

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const resized = await resizeToWebp(file, maxW, maxH);

      // Belt and braces. The server cap is authoritative, but failing here
      // gives a useful message instead of an opaque rejected upload.
      if (resized.size > UPLOAD_MAX_BYTES) {
        throw new Error("TOO_LARGE");
      }

      const blob = await upload(ccaUploadPath(ccaID, kind), resized, {
        access: "public",
        contentType: "image/webp",
        handleUploadUrl: "/api/cca/upload",
      });

      onChange(blob.url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg === "TOO_LARGE"
          ? "That image is still too large after resizing. Try a smaller one."
          : msg.includes("NOT_A_HEAD")
            ? "You're no longer a head of this CCA."
            : "That image couldn't be uploaded. Try again.",
      );
    } finally {
      setBusy(false);
      // Clear the input so re-picking the SAME file fires onChange again.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-500">{help}</p>
      </div>

      {value ? (
        <div className="flex items-start gap-3">
          <div
            className={`relative overflow-hidden rounded-md border border-gray-200 bg-gray-50 ${
              isLogo ? "h-20 w-20" : "h-20 w-64"
            }`}
          >
            <Image
              src={value}
              alt={`${label} preview`}
              fill
              className="object-contain"
              sizes={isLogo ? "80px" : "256px"}
              unoptimized
            />
          </div>
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || busy}
              onClick={() => onChange(null)}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : `Upload ${label.toLowerCase()}`}
        </Button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {busy && <p className="text-xs text-gray-500">Uploading…</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
