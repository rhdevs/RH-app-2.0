"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { upload } from "@vercel/blob/client";

import { Button } from "~/components/ui/button";
import {
  isOwnProposalPosterUrl,
  PROPOSAL_POSTER_MAX_BYTES,
  proposalPosterPath,
} from "~/lib/schemas/proposalFiles";
import { resizeToWebp } from "~/app/events/_lib/resizeImage";
import { describePosterError } from "../_lib/posterErrors";

/**
 * The poster slot of a proposal: pick an image, shrink it in the browser, send
 * it straight to the store with a short-lived token, hand the address to the
 * form. Images only. The address is saved with the rest of the draft; an
 * upload abandoned before saving leaves an orphaned blob, as for Events.
 * `proposalID` is undefined until the draft has been saved once, because the
 * upload path sits under the proposal's own id.
 */
export default function ProposalPosterField({
  proposalID,
  value,
  onChange,
  disabled = false,
}: {
  proposalID: string | undefined;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File, id: string) {
    setError(null);
    setBusy(true);
    setPercent(0);
    try {
      const resized = await resizeToWebp(file, 1600, 1600);
      if (resized.size > PROPOSAL_POSTER_MAX_BYTES) {
        throw new Error("TOO_LARGE");
      }
      const blob = await upload(proposalPosterPath(id), resized, {
        access: "public",
        contentType: resized.type || "image/jpeg",
        handleUploadUrl: "/api/proposal/upload",
        onUploadProgress: ({ percentage }) =>
          setPercent(Math.round(percentage)),
      });
      onChange(blob.url);
    } catch (e) {
      setError(describePosterError(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
      setPercent(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-gray-700">Poster</p>
        <p className="text-xs text-gray-500">
          An image (PNG, JPEG or WebP). It is saved with the draft.
        </p>
      </div>

      {proposalID === undefined ? (
        <p className="text-sm text-gray-500">
          Save the draft first, then add a poster.
        </p>
      ) : (
        <>
          {value && proposalID && isOwnProposalPosterUrl(value, proposalID) && (
            <div className="relative h-40 w-64 overflow-hidden rounded-md border border-gray-200 bg-gray-50">
              <Image
                src={value}
                alt="Poster preview"
                fill
                className="object-contain"
                sizes="256px"
                unoptimized
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy
                ? `Uploading${percent !== null ? ` ${percent}%` : "…"}`
                : value
                  ? "Replace poster"
                  : "Upload poster"}
            </Button>
            {value && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled || busy}
                onClick={() => onChange(null)}
              >
                Remove
              </Button>
            )}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file, proposalID);
            }}
          />
        </>
      )}

      {busy && percent !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-64 overflow-hidden rounded bg-gray-200"
        >
          <div
            className="h-full bg-emerald-600"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
