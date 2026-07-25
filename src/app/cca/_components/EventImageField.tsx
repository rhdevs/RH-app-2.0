"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { upload } from "@vercel/blob/client";

import { Button } from "~/components/ui/button";
import {
  eventUploadPath,
  EVENT_IMAGE_MAX_BYTES,
} from "~/lib/schemas/event";
import { resizeToWebp } from "~/app/events/_lib/resizeImage";

/**
 * Single-image slot for an event's banner. Same pattern as CcaImageField —
 * pick, downscale in the browser, upload straight to Vercel Blob, hand the URL
 * to the parent. Uploads on SELECT; abandoning the form leaves an orphaned blob
 * (accepted, reconcilable by diffing list() against Event rows).
 */
export default function EventImageField({
  eventID,
  label,
  help,
  value,
  onChange,
  disabled = false,
}: {
  eventID: number;
  label: string;
  help: string;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const resized = await resizeToWebp(file, 1600, 600);
      if (resized.size > EVENT_IMAGE_MAX_BYTES) throw new Error("TOO_LARGE");
      const blob = await upload(eventUploadPath(eventID, "banner"), resized, {
        access: "public",
        contentType: "image/webp",
        handleUploadUrl: "/api/event/upload",
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
          <div className="relative h-24 w-64 overflow-hidden rounded-md border border-gray-200 bg-gray-50">
            <Image
              src={value}
              alt={`${label} preview`}
              fill
              className="object-cover"
              sizes="256px"
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

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
