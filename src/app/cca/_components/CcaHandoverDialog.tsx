"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";
import { X } from "lucide-react";

import { api } from "~/trpc/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import HeadCandidateInput, {
  type ResolvedHead,
} from "~/app/_components/HeadCandidateInput";
import type { RosterEntry } from "~/server/api/services/ccaRoster";

/**
 * Hand a CCA over: name the new head(s), preview, and OVERWRITE the head set to
 * exactly that selection.
 *
 * A head who doesn't include themselves stops being a head — the whole point of
 * handing over. The dialog makes that consequence loud, since it can't be undone
 * from here (only an admin/JCRC can re-grant).
 */

/** Canonical userID candidates a head roster entry could match. */
function headKeys(entry: RosterEntry): string[] {
  return entry.kind === "resolved" ? entry.membershipKeys : [entry.key];
}

function headLabel(entry: RosterEntry): string {
  return entry.kind === "resolved"
    ? (entry.displayName ?? entry.email ?? entry.membershipKeys[0] ?? "a head")
    : entry.key;
}

export default function CcaHandoverDialog({
  ccaID,
  currentHeads,
  open,
  onOpenChange,
}: {
  ccaID: number;
  currentHeads: RosterEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: session } = useSession();
  const myUserID = session?.user?.userID ?? null;
  const utils = api.useUtils();

  const [selected, setSelected] = useState<ResolvedHead[]>([]);

  const handover = api.cca.handoverHeads.useMutation({
    onSuccess: async (res) => {
      await Promise.all([
        utils.cca.getRoster.invalidate({ ccaID }),
        utils.cca.listMine.invalidate(),
      ]);
      // If the initiator handed themselves out, the layout's next live-role read
      // closes /cca. Send them home rather than leaving a page that's about to
      // 403 under them.
      if (res.selfRemoved) window.location.href = "/";
      else onOpenChange(false);
    },
  });

  const selectedIDs = selected.map((s) => s.userID);
  const iAmKept = myUserID !== null && selectedIDs.includes(myUserID);

  // Which current heads this handover would remove — matched by any of their
  // canonical keys against the new selection.
  const removed = currentHeads.filter(
    (h) => !headKeys(h).some((k) => selectedIDs.includes(k)),
  );

  const addSelf = () => {
    if (myUserID && !selectedIDs.includes(myUserID)) {
      setSelected((prev) => [
        ...prev,
        { userID: myUserID, displayName: "You", email: null },
      ]);
    }
  };

  const reset = () => {
    setSelected([]);
    handover.reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && handover.isPending) return;
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Hand over this CCA</DialogTitle>
          <DialogDescription>
            Choose who should head this CCA from now on. This replaces the
            current heads entirely — anyone not on the new list stops being a
            head.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <HeadCandidateInput
            ccaID={ccaID}
            confirmLabel="Add"
            alreadyAdded={selectedIDs}
            disabled={handover.isPending}
            onConfirm={(head) => setSelected((prev) => [...prev, head])}
          />

          {myUserID && !iAmKept && (
            <button
              type="button"
              className="text-xs font-medium text-emerald-700 underline underline-offset-2"
              onClick={addSelf}
            >
              Keep me as a head too
            </button>
          )}

          {/* New heads */}
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
              New heads ({selected.length})
            </p>
            {selected.length === 0 ? (
              <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-400">
                Nobody added yet. Look someone up above.
              </p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {selected.map((s) => (
                  <li
                    key={s.userID}
                    className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 py-1 pl-3 pr-1.5 text-sm text-emerald-900"
                  >
                    <span className="max-w-[12rem] truncate">
                      {s.displayName ?? s.email ?? s.userID}
                      {s.userID === myUserID && " (you)"}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove from list"
                      disabled={handover.isPending}
                      onClick={() =>
                        setSelected((prev) =>
                          prev.filter((p) => p.userID !== s.userID),
                        )
                      }
                      className="rounded-full p-0.5 text-emerald-500 hover:bg-emerald-100 hover:text-emerald-800"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Removed preview */}
          {selected.length > 0 && removed.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-xs font-medium text-amber-900">
                No longer heads after this
              </p>
              <p className="mt-0.5 text-sm text-amber-800">
                {removed.map(headLabel).join(", ")}
              </p>
            </div>
          )}

          {myUserID && selected.length > 0 && !iAmKept && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              You&rsquo;re not on the new list, so you&rsquo;ll stop being a head
              and lose access to this page. Only an admin or the JCRC can add you
              back.
            </p>
          )}

          {handover.error && (
            <p className="text-sm text-red-600">
              {handover.error.message === "NOT_A_HEAD_OF_THIS_CCA"
                ? "You're no longer a head of this CCA."
                : handover.error.message === "SUCCESSOR_HAS_NOT_SIGNED_IN"
                  ? "One of the people you picked hasn't signed in yet."
                  : "That didn't work. Try again."}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={handover.isPending}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={handover.isPending || selected.length === 0}
            onClick={() =>
              handover.mutate({ ccaID, newHeadUserIDs: selectedIDs })
            }
          >
            {handover.isPending ? "Handing over…" : "Hand over"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
