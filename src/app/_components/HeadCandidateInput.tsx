"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { HeadCandidateResult } from "~/lib/schemas/cca";

export type ResolvedHead = {
  userID: string;
  displayName: string | null;
  email: string | null;
};

/**
 * Type an email / NUSNET id / matric, look it up, and preview the person before
 * committing them as a head. Shared by the admin add-head control and the head
 * handover dialog — both need the same "resolve, eyeball, confirm" step, and
 * matric especially must never be applied without a human seeing who it hit.
 *
 * The parent decides what `onConfirm` does: grant immediately (admin) or push a
 * chip onto the new-head list (handover). `confirmLabel` names that action.
 */
export default function HeadCandidateInput({
  ccaID,
  onConfirm,
  confirmLabel,
  alreadyAdded = [],
  disabled = false,
}: {
  ccaID: number;
  onConfirm: (head: ResolvedHead) => void;
  confirmLabel: string;
  /** userIDs already chosen/current, so a duplicate is caught before the grant. */
  alreadyAdded?: string[];
  disabled?: boolean;
}) {
  const utils = api.useUtils();
  const [identifier, setIdentifier] = useState("");
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<HeadCandidateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    const id = identifier.trim();
    if (!id) return;
    setLooking(true);
    setError(null);
    setResult(null);
    try {
      const r = await utils.cca.resolveHeadCandidate.fetch({
        ccaID,
        identifier: id,
      });
      setResult(r);
    } catch {
      setError("That lookup didn't work. Try again.");
    } finally {
      setLooking(false);
    }
  };

  const reset = () => {
    setIdentifier("");
    setResult(null);
    setError(null);
  };

  const found = result?.status === "FOUND" ? result : null;
  const duplicate = found ? alreadyAdded.includes(found.userID) : false;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <label
            htmlFor={`head-lookup-${ccaID}`}
            className="block text-sm font-medium text-gray-700"
          >
            Add a head
          </label>
          <Input
            id={`head-lookup-${ccaID}`}
            value={identifier}
            disabled={disabled || looking}
            placeholder="NUSNET id, email, or matric"
            onChange={(e) => {
              setIdentifier(e.target.value);
              setResult(null);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void lookup();
              }
            }}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || looking || !identifier.trim()}
          onClick={() => void lookup()}
        >
          {looking ? "Looking up…" : "Look up"}
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {result && result.status !== "FOUND" && (
        <p className="text-sm text-amber-700">
          {result.status === "NOT_FOUND" &&
            "No account matches that. Check the id, email, or matric."}
          {result.status === "AMBIGUOUS" &&
            "That matric matches more than one account, so it can't be used. Try their NUSNET id or email."}
          {/* NAMES THE ID IT LOOKED FOR, because this branch now covers two
              different mistakes. The server used to reach it only for a
              well-formed E-number, so "hasn't signed in yet" was the only thing
              it could mean; now that any NUSNET id resolves — which is the point
              of the fix, non-E ids are three quarters of nobody and a quarter of
              everybody — a typo lands here too. Showing the id is what lets the
              two be told apart without a second status, and a second status is
              the wrong tool: the server genuinely cannot distinguish them. */}
          {result.status === "NOT_SIGNED_IN" && (
            <>
              Nobody has signed in as{" "}
              <span className="font-mono">{result.userID}</span>. Check the
              spelling — if it is right, they need to sign in once before they
              can be made a head.
            </>
          )}
        </p>
      )}

      {found && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-900">
              {found.displayName ?? found.email ?? found.userID}
            </p>
            <p className="truncate text-xs text-gray-500">
              {found.email ?? found.userID}
            </p>
          </div>
          {duplicate ? (
            <span className="text-xs text-gray-400">Already added</span>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => {
                onConfirm({
                  userID: found.userID,
                  displayName: found.displayName,
                  email: found.email,
                });
                reset();
              }}
            >
              {confirmLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
