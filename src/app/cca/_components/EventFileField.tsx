"use client";

import { useState, useRef } from "react";
import { FileText } from "lucide-react";
import { upload } from "@vercel/blob/client";

import { Button } from "~/components/ui/button";
import { eventUploadPath, EVENT_PDF_MAX_BYTES } from "~/lib/schemas/event";

/**
 * Proposal PDF slot. Like EventImageField but for a PDF: no resize, uploaded
 * as-is with contentType application/pdf. The event must already exist (draft)
 * so its eventID can key the blob path — the parent disables this until then.
 */
export default function EventFileField({
  eventID,
  value,
  onChange,
  disabled = false,
}: {
  eventID: number;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (file.size > EVENT_PDF_MAX_BYTES) {
      setError("That PDF is too large (max 10 MB).");
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const blob = await upload(eventUploadPath(eventID, "proposal"), file, {
        access: "public",
        contentType: "application/pdf",
        handleUploadUrl: "/api/event/upload",
      });
      onChange(blob.url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      setError(
        msg.includes("NOT_A_HEAD")
          ? "You're no longer a head of this CCA."
          : "That file couldn't be uploaded. Try again.",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-gray-700">Event proposal (PDF)</p>
        <p className="text-xs text-gray-500">
          The document JCRC reviews. Residents never see this.
        </p>
      </div>

      {value ? (
        <div className="flex items-center gap-3">
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
          >
            <FileText className="h-4 w-4" />
            View uploaded proposal
          </a>
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
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "Uploading…" : "Upload proposal PDF"}
        </Button>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
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
