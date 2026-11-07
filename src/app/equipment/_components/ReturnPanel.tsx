"use client";

import { useRef, useState } from "react";
import { upload } from "@vercel/blob/client";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { resizeToWebp } from "~/app/events/_lib/resizeImage";
import { equipmentErrorMessage } from "~/lib/equipment/errors";
import { equipmentPhotoUploadPath } from "~/lib/equipment/photo";
import { EVIDENCE_MAX_BYTES } from "~/lib/schemas/milestoneEvidence";

/**
 * "Mark returned", with an optional photo of the kit. The photo is shrunk in the
 * browser, sent straight to the PRIVATE store with a short-lived token from
 * /api/equipment-return/upload (which checks that this person may act for this
 * loan and that it is collected), then the loan is marked returned with the
 * address the store gave back; the server re-checks that address and the file
 * before it saves anything. The page never keeps the address after that.
 */
export default function ReturnPanel({
  loanID,
  version,
  onDone,
}: {
  loanID: string;
  version: number;
  onDone: () => void;
}) {
  const mark = api.equipment.markReturned.useMutation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      let url: string | null = null;
      if (file) {
        const resized = await resizeToWebp(file, 1600, 1600);
        if (resized.size > EVIDENCE_MAX_BYTES) throw new Error("TOO_LARGE");
        const ext = resized.type === "image/jpeg" ? "jpg" : "webp";
        setPercent(0);
        const blob = await upload(
          equipmentPhotoUploadPath(loanID, ext),
          resized,
          {
            access: "private",
            contentType: resized.type,
            handleUploadUrl: "/api/equipment-return/upload",
            onUploadProgress: ({ percentage }) =>
              setPercent(Math.round(percentage)),
          },
        );
        url = blob.url;
      }
      await mark.mutateAsync({ id: loanID, version, url });
      onDone();
    } catch (e) {
      setError(equipmentErrorMessage(e instanceof Error ? e.message : ""));
    } finally {
      setBusy(false);
      setPercent(null);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-gray-200 p-3 dark:border-border">
      <label className="block text-sm text-gray-700 dark:text-foreground">
        Photo of the returned kit (optional)
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="mt-1 block w-full text-sm"
          disabled={busy}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <p className="text-xs text-gray-500 dark:text-muted-foreground">
        Only the Social director and the event&apos;s leaders can see it.
      </p>
      <Button
        type="button"
        size="sm"
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy
          ? `Saving${percent !== null ? ` ${percent}%` : "…"}`
          : "Mark returned"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
