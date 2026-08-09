"use client";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import HeadCandidateInput from "~/app/_components/HeadCandidateInput";

/**
 * Assign and unassign a CCA's heads, for admin/JCRC in the CCAs tab.
 *
 * Uses the shipped admin.grantCcaHead / revokeCcaHead (roleManagerProcedure,
 * manageCcaHeads) — NOT the ccaAdmin management surface, so it is NOT behind the
 * cca.management.enabled kill switch. Lists heads from admin.listCcaHeads, which
 * returns clean canonical userIDs.
 */
export default function CcaHeadsManager({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  // listHeads (not admin.listCcaHeads) so each head shows a NAME, not a bare
  // NUSNET id — while still returning the canonical userID that Remove needs.
  const heads = api.cca.listHeads.useQuery({ ccaID }, { retry: false });

  const refresh = async () => {
    await Promise.all([
      utils.cca.listHeads.invalidate({ ccaID }),
      utils.cca.getRoster.invalidate({ ccaID }),
    ]);
  };

  const grant = api.admin.grantCcaHead.useMutation({ onSuccess: refresh });
  const revoke = api.admin.revokeCcaHead.useMutation({ onSuccess: refresh });

  // `userID` is typed `string | null` because cca.listHeads NULLS it for the
  // read-only (hall office) tier — a canonical E-id is an email one derivation
  // later, so that tier must not receive one. THIS page is manager-gated, so it
  // always takes the untouched branch and never actually sees a null; the
  // narrowing below is how that fact is stated to the compiler rather than
  // asserted away with a `!`. A row without an id could not be Removed anyway,
  // since `userID` is exactly what revokeCcaHead writes.
  const rows = (heads.data?.heads ?? []).filter(
    (h): h is typeof h & { userID: string } => h.userID !== null,
  );
  const error = grant.error?.message ?? revoke.error?.message ?? null;

  return (
    <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Heads
        <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
          {rows.length}
        </span>
      </h2>

      {rows.length > 3 && (
        <p className="text-xs text-amber-700">
          This CCA has {rows.length} heads. Allowed, but worth a double-check.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Nobody heads this CCA, so nobody can see its roster from their own CCA
          page. Add a head below.
        </p>
      ) : (
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
          {rows.map((h) => (
            <li
              key={h.userID}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-gray-900">
                  {h.displayName ?? h.email ?? h.userID}
                </span>
                {/* Always show the NUSNET id underneath — it's the thing being
                    written to CcaHead, and worth confirming even when a name
                    resolved. When nothing resolved, this is the only label. */}
                <span className="block truncate font-mono text-xs text-gray-400">
                  {h.email ? `${h.email} · ${h.userID}` : h.userID}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={revoke.isPending}
                className="shrink-0 text-gray-400 hover:text-red-600"
                onClick={() => revoke.mutate({ ccaID, userID: h.userID })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <HeadCandidateInput
        ccaID={ccaID}
        confirmLabel="Add as head"
        alreadyAdded={rows.map((h) => h.userID)}
        disabled={grant.isPending}
        onConfirm={(head) => grant.mutate({ ccaID, userID: head.userID })}
      />

      {error && (
        <p className="text-sm text-red-600">
          {error === "CANNOT_MODIFY_AN_ADMIN"
            ? "You can't change an admin's roles."
            : "That didn't work. Try again."}
        </p>
      )}
    </section>
  );
}
