"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { X } from "lucide-react";
import { upload } from "@vercel/blob/client";

import { Button } from "~/components/ui/button";
import {
  eventUploadPath,
  EVENT_IMAGE_MAX_BYTES,
  EVENT_MAX_PHOTOS,
} from "~/lib/schemas/event";
import { resizeToWebp } from "~/app/events/_lib/resizeImage";

/**
 * Gallery field: a list of photo URLs the head adds to and removes from. Each
 * pick uploads one photo (event/{eventID}/photo) and appends its URL. Capped at
 * EVENT_MAX_PHOTOS, matching the server schema. No reorder in v1.
 */
export default function EventGalleryField({
  eventID,
  value,
  onChange,
  disabled = false,
}: {
  eventID: number;
  value: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const atCap = value.length >= EVENT_MAX_PHOTOS;

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const resized = await resizeToWebp(file, 1600, 1200);
      if (resized.size > EVENT_IMAGE_MAX_BYTES) throw new Error("TOO_LARGE");
      const blob = await upload(eventUploadPath(eventID, "photo"), resized, {
        access: "public",
        contentType: "image/webp",
        handleUploadUrl: "/api/event/upload",
      });
      onChange([...value, blob.url]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg === "TOO_LARGE"
          ? "That photo is still too large after resizing. Try a smaller one."
          : "That photo couldn't be uploaded. Try again.",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-gray-700">Photos</p>
        <p className="text-xs text-gray-500">
          Up to {EVENT_MAX_PHOTOS}. Residents scroll through these on the event
          page.
        </p>
      </div>

      {value.length > 0 && (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {value.map((url, i) => (
            <div
              key={url}
              className="group relative aspect-video overflow-hidden rounded-md border border-gray-200 bg-gray-50"
            >
              <Image
                src={url}
                alt={`Photo ${i + 1}`}
                fill
                className="object-cover"
                sizes="200px"
                unoptimized
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(value.filter((u) => u !== url))}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Remove photo"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy || atCap}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "Uploading…" : atCap ? "Photo limit reached" : "Add a photo"}
      </Button>

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
