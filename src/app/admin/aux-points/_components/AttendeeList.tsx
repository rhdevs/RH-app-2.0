"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";

import { Button } from "~/components/ui/button";
import type { RouterOutputs } from "~/trpc/react";
import { addSummary, auxErrorCopy } from "./auxCopy";
import {
  ErrorLine,
  PasteBox,
  PersonCell,
  StatusLine,
  UnresolvedList,
} from "./Bits";

type AddResult = RouterOutputs["aux"]["addEventAttendees"];
export type Attendee = {
  userID: string;
  name: string | null;
  matric: string | null;
  note?: string;
};

/**
 * One AUX source's list of people, with a paste box to add more and a remove
 * button on each. Shared by AUX events and record-only events.
 */
export function AttendeeList({
  people,
  loading,
  readOnly,
  onAdd,
  onRemove,
}: {
  people: readonly Attendee[] | undefined;
  loading: boolean;
  readOnly: boolean;
  onAdd: (text: string) => Promise<AddResult>;
  onRemove: (userID: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AddResult | null>(null);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await onAdd(text);
      setResult(r);
      setText(
        text
          .split(/\r?\n/)
          .filter((_, i) => r.unknown.some((u) => u.line === i + 1))
          .join("\n"),
      );
    } catch (e) {
      setError(auxErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Attendee) => {
    if (!window.confirm(`Take ${p.name ?? p.userID} off this list?`)) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove(p.userID);
    } catch (e) {
      setError(auxErrorCopy(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-label="Loading" />
      ) : !people ? (
        <ErrorLine message="Couldn’t load the list." />
      ) : people.length === 0 ? (
        <p className="text-sm text-gray-500">No one is on the list yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 bg-white text-sm">
          {people.map((p) => (
            <li
              key={p.userID}
              className="flex items-center justify-between gap-2 px-3 py-1.5"
            >
              <span>
                <PersonCell name={p.name} matric={p.matric} />
                {p.note && (
                  <span className="ml-2 text-xs text-gray-500">{p.note}</span>
                )}
              </span>
              {!readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(p)}
                  aria-label={`Remove ${p.name ?? p.userID}`}
                  className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <>
          <PasteBox
            label="Add people"
            hint="One matric, email or NUSNET id per line, or a CSV with them in the first column. Each person counts once."
            value={text}
            onChange={setText}
            disabled={busy}
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => void add()}
            disabled={busy || !text.trim()}
          >
            Add to the list
          </Button>
        </>
      )}
      <ErrorLine message={error} />
      {result && (
        <>
          <StatusLine
            message={addSummary(result.added.length, result.already.length)}
          />
          <UnresolvedList lines={result.unknown} />
        </>
      )}
    </div>
  );
}
