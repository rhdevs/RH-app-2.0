"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import { upload } from "@vercel/blob/client";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_UNATTACHED,
  evidenceUploadPath,
} from "~/lib/schemas/milestoneEvidence";
import { resizeToWebp } from "~/app/events/_lib/resizeImage";
import { describeEvidenceError } from "../_lib/evidenceErrors";

/**
 * Milestone evidence photos for one CCA: add a photo, see the ones not yet used,
 * remove one. Heads of the CCA only, behind `milestones.enabled`. NOT a guard:
 * every procedure and the upload route check the flag and that the caller heads
 * THIS CCA. Photos are private: the page only ever holds evidence ids, and each
 * thumbnail is the app's own access-checked route, never a store address.
 *
 * The photo is shrunk in the browser, sent straight to the private store with a
 * short-lived token, then recorded with the address the store returned (the
 * server re-checks that address and the file before it saves anything).
 */
export default function EvidencePanel({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const enabled = api.milestoneEvidence.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const list = api.milestoneEvidence.list.useQuery(
    { ccaID },
    { retry: false, enabled: on },
  );
  const record = api.milestoneEvidence.record.useMutation();
  const remove = api.milestoneEvidence.remove.useMutation();

  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    setPercent(0);
    try {
      const resized = await resizeToWebp(file, 1600, 1600);
      if (resized.size > EVIDENCE_MAX_BYTES) throw new Error("TOO_LARGE");
      const ext = resized.type === "image/jpeg" ? "jpg" : "webp";
      const blob = await upload(evidenceUploadPath(ccaID, ext), resized, {
        access: "private",
        contentType: resized.type,
        handleUploadUrl: "/api/milestone-evidence/upload",
        onUploadProgress: ({ percentage }) =>
          setPercent(Math.round(percentage)),
      });
      await record.mutateAsync({ ccaID, url: blob.url });
      await utils.milestoneEvidence.list.invalidate({ ccaID });
    } catch (e) {
      setError(describeEvidenceError(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
      setPercent(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleRemove(id: string) {
    setError(null);
    try {
      await remove.mutateAsync({ id });
      await utils.milestoneEvidence.list.invalidate({ ccaID });
    } catch (e) {
      setError(describeEvidenceError(e instanceof Error ? e.message : ""));
    }
  }

  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Milestone evidence is not switched on yet.
      </p>
    );
  }

  const photos = list.data ?? [];

  return (
    <section aria-labelledby="evidence-heading" className="space-y-4">
      <div>
        <h2 id="evidence-heading" className="text-lg font-semibold">
          Evidence photos
        </h2>
        <p className="text-sm text-gray-500">
          Photos for a milestone. Only the heads of this CCA and its directors
          can see them. A photo that is not used within a week is removed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || photos.length >= EVIDENCE_MAX_UNATTACHED}
          onClick={() => inputRef.current?.click()}
        >
          {busy
            ? `Uploading${percent !== null ? ` ${percent}%` : "…"}`
            : "Add a photo"}
        </Button>
        <span className="text-xs text-gray-500">
          {photos.length} of {EVIDENCE_MAX_UNATTACHED} unused
        </span>
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
      </div>

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

      {list.isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-red-600">
          The photos could not be loaded.
        </p>
      ) : photos.length === 0 ? (
        <p className="text-sm text-gray-500">No photos yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map((p) => (
            <li
              key={p.id}
              className="space-y-1 rounded-md border border-gray-200 bg-white p-2"
            >
              <div className="relative h-32 w-full overflow-hidden rounded bg-gray-50">
                <Image
                  src={`/api/milestone-evidence/${p.id}`}
                  alt="Evidence photo"
                  fill
                  className="object-contain"
                  sizes="200px"
                  unoptimized
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-gray-500">
                  {new Date(p.createdAt).toLocaleDateString()}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => void handleRemove(p.id)}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
