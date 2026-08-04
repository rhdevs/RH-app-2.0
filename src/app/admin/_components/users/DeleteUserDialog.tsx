"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";

import {
  FOOTPRINT_ORDER,
  footprintPhrase,
  friendlyError,
  refusalCopy,
  soleHeadCcaID,
} from "../../_lib/userDetail";

/**
 * The destructive confirmation for `userAdmin.delete`.
 *
 * An AlertDialog — the same primitive ManageRolesDialog uses for its
 * self-demotion interstitial — and never a bare `confirm()`: this needs to show
 * the blast radius, and a native confirm can only show a sentence.
 *
 * THE OPERATOR MUST SEE THE BLAST RADIUS BEFORE TYPING ANYTHING. A confirmation
 * over an unknown quantity is theatre: "are you sure?" over 46 bookings the
 * operator never saw is not consent, it is a reflex. Hence the preflight query,
 * which is READ-ONLY and writes no audit row (a preview is not an attempt).
 *
 * REFUSALS REMOVE THE CONFIRM CONTROL ENTIRELY rather than disabling it. A
 * disabled destructive button reads as "try harder"; an absent one plus a
 * sentence naming the remedy reads as "do this other thing first", which is
 * what every refusal here actually means.
 */
export default function DeleteUserDialog({
  userObjectId,
  label,
  onClose,
  onDeleted,
}: {
  userObjectId: string;
  /** For the title only — displayName if there is one, else the email. */
  label: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const utils = api.useUtils();
  const [typed, setTyped] = useState("");

  // The SAME query key UserDetailDialog primes, so opening this dialog costs no
  // second round trip. `refusals` and `counts` come from the one implementation
  // the mutation itself runs — two copies of a refusal list is how a preview
  // starts saying yes to something the mutation refuses.
  const impact = api.userAdmin.getDeletionImpact.useQuery(
    { userObjectId },
    { retry: false },
  );

  const refusals = impact.data?.refusals ?? [];
  const needsCcaNames = refusals.some((r) => soleHeadCcaID(r) !== null);

  // Fetched ONLY when a SOLE_HEAD_OF_CCA refusal needs a name. listCcas is
  // gated on manageCcaHeads, which every holder of deleteUsers has, but firing
  // it unconditionally would put a whole-collection read behind every delete
  // preview for no copy.
  const ccas = api.admin.listCcas.useQuery(undefined, {
    enabled: needsCcaNames,
    retry: false,
  });
  const ccaName = (ccaID: number): string | null =>
    ccas.data?.find((c) => c.ccaID === ccaID)?.ccaName ?? null;

  const remove = api.userAdmin.delete.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.admin.listUsers.invalidate(),
        utils.admin.getStats.invalidate(),
        // Head counts move when a head's account goes.
        utils.ccaAdmin.listAll.invalidate(),
      ]);
      onDeleted();
    },
    // The dialog stays open on error. A PRECONDITION_FAILED arriving here after
    // a clean preview is the TOCTOU case — see friendlyError.
    //
    // AND THE PREFLIGHT IS RE-RUN, which is the part that makes the error copy
    // true. Without it the panel keeps rendering the refusal-free preview it
    // fetched before the state moved: the confirm control stays mounted, the
    // typed email still matches, and the operator clicks Delete again — writing
    // one more `denied` RoleAuditLog row per attempt for an operation that can
    // never now succeed, with the actual reason (a co-head revoked, the target
    // granted admin) visible nowhere. Re-running it repopulates `refusals`,
    // which unmounts the button and states the remedy. Deliberately on EVERY
    // error, not only PRECONDITION_FAILED: a stale preview is never the thing
    // to keep.
    onError: async () => {
      await utils.userAdmin.getDeletionImpact.invalidate({ userObjectId });
    },
  });

  const email = impact.data?.email ?? "";
  // COSMETIC. The server compares the typed value against the STORED email and
  // refuses with CONFIRM_EMAIL_MISMATCH; a `confirmed: true` from the client is
  // not evidence. This only stops the button being live before the operator has
  // read what they are about to destroy.
  const matches =
    email !== "" && typed.trim().toLowerCase() === email.trim().toLowerCase();

  // Treated as Record<string, number> so a collection added to the cascade
  // later still renders (under its raw key) instead of vanishing from the blast
  // radius — see FOOTPRINT_ORDER's note.
  const counts: Record<string, number> = impact.data?.counts ?? {};
  const known = new Set<string>(FOOTPRINT_ORDER);
  const rows: [string, number][] = [
    ...FOOTPRINT_ORDER.map((k): [string, number] => [k, counts[k] ?? 0]),
    ...Object.entries(counts).filter(([k]) => !known.has(k)),
  ].filter(([, n]) => n > 0);

  const error = friendlyError(remove.error) ?? friendlyError(impact.error);

  return (
    <AlertDialog
      open
      onOpenChange={(o) => {
        if (!o && !remove.isPending) onClose();
      }}
    >
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this account?</AlertDialogTitle>
          <AlertDialogDescription>
            {label ?? email} · this cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {impact.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-9 w-full" />
          </div>
        )}

        {impact.data && (
          <div className="space-y-4 text-sm">
            {/* ---------- 1. WHAT WILL BE DESTROYED -------------------------- */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                What will be destroyed
              </h3>
              {/* THE NO-NUSNET-ID BRANCH IS FIRST, and it is not a nicety.
                  `rows.length === 0` is ALSO true for such an account —
                  countUserFootprint returns all zeros WITHOUT querying when
                  there is no canonical id, because there is no key to query on
                  — so the empty-list copy below was asserting "nothing else is
                  attached to it" after zero lookups. A pre-cutover account can
                  still own rows under the key auth.ts used to derive from any
                  address, which is why the delete now refuses on this state
                  (ABSENT_CANONICAL_ID) instead of being offered over an empty
                  list. The panel must state what was actually checked. */}
              {impact.data.canonicalUserID === null ? (
                <p className="mt-1 text-gray-600">
                  This account has no NUSNET id, so its records can&rsquo;t be
                  located and there is nothing to list here. Anything it owns
                  would be left behind, unattributed — see below.
                </p>
              ) : rows.length === 0 ? (
                <p className="mt-1 text-gray-600">
                  The account itself. Nothing else is attached to it.
                </p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-gray-700">
                  {rows.map(([key, n]) => (
                    <li key={key}>{footprintPhrase(key, n)}</li>
                  ))}
                </ul>
              )}
            </section>

            {/* ---------- 2. WHAT SURVIVES ---------------------------------- */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                What survives
              </h3>
              <p className="mt-1 text-gray-700">
                The audit trail keeps a record of this deletion. Events this
                person filed for a CCA, and interview notes they wrote about
                other applicants, stay with the CCA.
              </p>
              {/* Named explicitly, because it is the one place the cascade does
                  NOT do what "delete everything of theirs" implies — and the
                  reason it does not is that dropping these would leave a
                  published event holding a room that is silently free again.
                  Counted apart from the bookings above, which really do go. */}
              {impact.data.retainedBookings > 0 && (
                <p className="mt-1 text-gray-700">
                  {footprintPhrase("bookings", impact.data.retainedBookings)}{" "}
                  {impact.data.retainedBookings === 1 ? "is" : "are"} the room
                  reservation
                  {impact.data.retainedBookings === 1 ? "" : "s"} behind a
                  published event or a live interview slot. {""}
                  {impact.data.retainedBookings === 1
                    ? "It stays"
                    : "They stay"}{" "}
                  in place, handed to another head of that CCA where there is
                  one — deleting{" "}
                  {impact.data.retainedBookings === 1 ? "it" : "them"} would
                  free the room without telling anyone.
                </p>
              )}
            </section>

            {/* ---------- 3. REFUSALS --------------------------------------- */}
            {refusals.length > 0 && (
              <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                <p className="font-medium">
                  This account can&rsquo;t be deleted.
                </p>
                <ul className="space-y-1.5">
                  {refusals.map((r) => (
                    <li key={r}>{refusalCopy(r, ccaName)}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* ---------- 4. THE CONFIRMATION ------------------------------- */}
            {refusals.length === 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="del-confirm">
                  Type <span className="font-mono">{email}</span> to confirm
                </Label>
                <Input
                  id="del-confirm"
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}

            {!impact.data.enabled && (
              <p className="text-gray-600">Account deletion is turned off.</p>
            )}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{error}</span>
              {/* Matches UserDetailDialog's error panel. Only for the PREFLIGHT:
                  a failed delete must not offer a one-click retry of a
                  destructive mutation, and its refusals have already been
                  re-fetched by onError above. */}
              {impact.isError && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void impact.refetch()}
                >
                  Retry
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          {/* A plain Button, NOT AlertDialogAction: Radix dismisses the dialog
              on Action click, which would close it while the mutation is still
              in flight and throw away the error the operator needs to read. */}
          {impact.data && refusals.length === 0 && (
            <Button
              className="bg-red-700 text-white hover:bg-red-800"
              disabled={!impact.data.enabled || !matches || remove.isPending}
              onClick={() =>
                remove.mutate({
                  userObjectId,
                  // Sent as typed; the server compares it to the stored address.
                  confirmEmail: typed.trim(),
                })
              }
            >
              {remove.isPending ? "Deleting…" : "Delete account"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
