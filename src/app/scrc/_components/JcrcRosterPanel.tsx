"use client";

import { useEffect, useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
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
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import DisabledNotice, { disabledCopy } from "./DisabledNotice";

/**
 * THE hall office's only write: add or remove `jcrc` on one account.
 *
 * It talks to admin.listJcrcRoster / resolveJcrcCandidate / setJcrcRole and to
 * NOTHING ELSE. In particular it never touches admin.listUsers (which pages the
 * whole hall and returns email, displayName and block for every account) or
 * admin.setUserRoles (whose payload is a client-supplied FINAL role set). Those
 * three narrow procedures exist precisely so this surface does not need the wide
 * ones; reaching for a wide one here would quietly undo that.
 */

/**
 * Both shapes are taken from the router's inferred output rather than retyped,
 * so a change to either procedure surfaces here as a type error instead of as a
 * quietly-wrong render.
 */
type JcrcRow = RouterOutputs["admin"]["listJcrcRoster"]["items"][number];
type CandidateResult = RouterOutputs["admin"]["resolveJcrcCandidate"];

/** What the confirmation dialog is about to do. */
type Pending = {
  userID: string;
  /** What to call the person in the dialog. Name, else email, else the id. */
  label: string;
  grant: boolean;
};

/**
 * setJcrcRole's refusals, in the words of someone who does not know what a
 * capability is. Every one of these is a settled answer, not a glitch, so none
 * of them says "try again".
 */
function mutationCopy(message: string): string {
  switch (message) {
    case "SCRC_CANNOT_SELF_TARGET":
      return "You can’t change your own JCRC access. Ask an admin.";
    case "SCRC_TARGET_UNAVAILABLE":
      // ONE MESSAGE FOR EVERY TARGET-DEPENDENT REFUSAL, and the flatness is the
      // security property. The server returns this for "no account", "never
      // signed in", "holds admin", "holds Hall Office" and "the change would do
      // nothing" — indistinguishably, because a message that varies with a
      // property of the target turns this button into an enumeration of that
      // property across the whole hall (see setJcrcRole in routers/admin.ts).
      // It is the same answer resolveJcrcCandidate gives as NOT_AVAILABLE, so
      // the lookup box and this button cannot be played against each other.
      // Do NOT split it apart to be more helpful; the real reason is on the
      // audit row, where an admin can read it.
      return "That account can’t be given or removed from the JCRC. It may already be in the state you asked for, or it may not be an account the hall office can change. An admin can see why in the audit log.";
    case "CANNOT_GRANT_JCRC":
      return "Your account isn’t allowed to hand out JCRC access.";
    case "CONFLICT_ROLES_CHANGED":
      return "Someone else changed this account’s access while this page was open. Reload and take another look before trying again.";
    case "CAPABILITY_REQUIRED:manageJcrcRoster":
      return "Your account no longer has permission to manage the JCRC.";
    default:
      // SCRC_DISABLED is NOT handled here — it is a kill switch, not a refusal,
      // so the caller checks disabledCopy() FIRST and only falls through to this
      // function when the message is a real denial. See `mutationError` below.
      return "That didn’t go through. Try again.";
  }
}

/**
 * The lookup result, in plain words.
 *
 * ONE MESSAGE FOR EVERY NEGATIVE, and the flatness is the security property, not
 * an omission. The server collapses "no such identifier", "resolved but has
 * never signed in" and "resolved to an admin" into a single NOT_AVAILABLE
 * precisely because a distinguishable third answer let an scrc holder enumerate
 * the admin roster (see JcrcCandidateResult in routers/admin.ts). Copy that
 * split them apart again — "…or they have admin access", "ask them to log in
 * once" — would hand back the exact bit the server just spent a redesign
 * withholding, from the client, where it is cheapest to read.
 *
 * So this text must cover all three causes without hinting at which one applies,
 * and it must stay that way. If someone asks for a friendlier "they've never
 * logged in" message, the answer is no.
 */
function candidateCopy(result: CandidateResult): string | null {
  switch (result.status) {
    case "FOUND":
      return null; // rendered as a card, not a sentence
    case "AMBIGUOUS":
      return "That matric matches more than one account, so it can’t be used. Try their NUSNET id or email instead.";
    case "NOT_AVAILABLE":
      return "No account is available to receive JCRC access under that NUSNET id, email or matric. Check the spelling — and note that someone who has never signed in to the app can’t be given access until they log in once.";
  }
}

export default function JcrcRosterPanel() {
  const utils = api.useUtils();
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");

  // The lookup box's state, declared BEFORE the mutation because setJcrcRole's
  // onSuccess clears it.
  const [identifier, setIdentifier] = useState("");
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<CandidateResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  /* ------------------------------ the roster ------------------------------ */

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = api.admin.listJcrcRoster.useInfiniteQuery(
    { limit: 25 },
    {
      // PAGING FOLLOWS nextCursor AND NOTHING ELSE. listJcrcRoster drops
      // admin-holding rows AFTER slicing the page, so a page can come back with
      // fewer items than `limit` — or with none at all — and still have more
      // roster behind it. "Stop when the page is short" would silently truncate
      // the JCRC list.
      getNextPageParam: (last) => last.nextCursor ?? undefined,
      // A FORBIDDEN is a settled answer, not a transient failure, and the kill
      // switch being off is the expected first-run state. Retrying it three
      // times is log noise and a slow, ambiguous UI.
      retry: false,
    },
  );

  const rows: JcrcRow[] = data?.pages.flatMap((p) => p.items) ?? [];

  // The other half of the same rule. If every row on the pages fetched so far
  // was an admin, `rows` is empty while more roster remains — rendering "nobody
  // holds jcrc" there would be a flat lie. Keep pulling until there is either
  // something to show or genuinely nothing left.
  useEffect(() => {
    if (!isLoading && rows.length === 0 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [isLoading, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  /* ------------------------------ the write ------------------------------- */

  const setRole = api.admin.setJcrcRole.useMutation({
    onSuccess: async () => {
      setPending(null);
      setReason("");
      // Also clears the lookup card: the grant it was offering has happened, and
      // a stale `holdsJcrc: false` would keep offering it.
      setResult(null);
      setIdentifier("");
      await utils.admin.listJcrcRoster.invalidate();
    },
  });

  /* ----------------------------- the lookup ------------------------------- */

  /**
   * EXPLICIT SUBMIT ONLY, never a debounced live query.
   *
   * Every successful resolveJcrcCandidate writes a `scrc.candidate.read` audit
   * row, because it is the only enumeration-shaped surface the hall office has.
   * Wiring it to onChange would mean typing one email address produced a dozen
   * audit rows for a dozen partial addresses — which both destroys the value of
   * the record and probes eleven accounts nobody asked about. Hence
   * utils.fetch() on a click, the same idiom HeadCandidateInput uses for
   * cca.resolveHeadCandidate.
   */
  const lookup = async () => {
    const id = identifier.trim();
    if (!id) return;
    setLooking(true);
    setResult(null);
    setLookupError(null);
    try {
      setResult(await utils.admin.resolveJcrcCandidate.fetch({ identifier: id }));
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setLookupError(
        disabledCopy(message)?.title ?? "That lookup didn’t work. Try again.",
      );
    } finally {
      setLooking(false);
    }
  };

  /* ------------------------------- render --------------------------------- */

  // The kill switch, before anything else: with `scrc.enabled` off the roster
  // query is the first thing to refuse, and the whole panel is inert.
  if (error && disabledCopy(error.message)) {
    return <DisabledNotice message={error.message} />;
  }

  const found = result?.status === "FOUND" ? result : null;
  const statusLine = result ? candidateCopy(result) : null;
  const mutationError = setRole.error
    ? (disabledCopy(setRole.error.message)?.title ??
      mutationCopy(setRole.error.message))
    : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl bg-white p-6 shadow-lg">
        <h2 className="text-lg font-semibold text-gray-900">Add to the JCRC</h2>
        <p className="mt-1 text-sm text-gray-500">
          Look someone up by NUSNET id, NUS email or matric, check it is the
          right person, then give them JCRC access.
        </p>

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <label
              htmlFor="jcrc-lookup"
              className="block text-sm font-medium text-gray-700"
            >
              Who
            </label>
            <Input
              id="jcrc-lookup"
              value={identifier}
              maxLength={120}
              disabled={looking || setRole.isPending}
              placeholder="NUSNET id, email, or matric"
              onChange={(e) => {
                setIdentifier(e.target.value);
                // Drop the previous answer the moment the question changes, so a
                // card for the last person can never be confirmed against the
                // id now in the box.
                setResult(null);
                setLookupError(null);
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
            disabled={looking || !identifier.trim() || setRole.isPending}
            onClick={() => void lookup()}
          >
            {looking ? "Looking up…" : "Look up"}
          </Button>
        </div>

        {lookupError && (
          <p className="mt-2 text-sm text-amber-700">{lookupError}</p>
        )}
        {statusLine && (
          <p className="mt-2 text-sm text-amber-700">{statusLine}</p>
        )}

        {found && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-900">
                {found.displayName ?? found.email ?? found.userID}
              </p>
              <p className="truncate text-xs text-gray-500">
                {found.email ?? "No email on file"}
                <span className="ml-2 font-mono">{found.userID}</span>
              </p>
            </div>
            {/* holdsJcrc is why the resolver returns it: offering "Grant" to
                someone who already has it would look like it did nothing. */}
            {found.holdsJcrc ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">
                  Already on the JCRC
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                  disabled={setRole.isPending}
                  onClick={() =>
                    setPending({
                      userID: found.userID,
                      label:
                        found.displayName ?? found.email ?? found.userID,
                      grant: false,
                    })
                  }
                >
                  <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                  Remove
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={setRole.isPending}
                onClick={() =>
                  setPending({
                    userID: found.userID,
                    label: found.displayName ?? found.email ?? found.userID,
                    grant: true,
                  })
                }
              >
                <UserPlus className="mr-1.5 h-3.5 w-3.5" />
                Give JCRC access
              </Button>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              Current JCRC
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Everyone who currently holds JCRC access.
            </p>
          </div>
        </div>

        {error && !disabledCopy(error.message) && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="flex items-center justify-between gap-4 text-sm text-red-800">
              <span>The JCRC list couldn’t be loaded.</span>
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                Retry
              </Button>
            </p>
          </div>
        )}

        <div className="overflow-hidden rounded-xl bg-white shadow-lg">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>User ID (NUSNET)</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                // Skeletons inside REAL rows/cells so the column widths — and
                // therefore the header — do not jump when data lands.
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {Array.from({ length: 4 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!isLoading && rows.length === 0 && !hasNextPage && !error && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <p className="py-10 text-center text-sm text-gray-500">
                      Nobody holds JCRC access right now.
                    </p>
                  </TableCell>
                </TableRow>
              )}

              {rows.map((r, i) => {
                // `canonicalUserID: null` means the stored key did not survive
                // asStoredCanonicalUserID — there is no id to key a role change
                // on, so this row is a record to look at, never a target. There
                // is also nothing else unique about such a row, hence the index
                // in the React key.
                const targetable = r.canonicalUserID !== null;
                const label =
                  r.displayName ?? r.email ?? r.canonicalUserID ?? "Unknown";
                return (
                  <TableRow key={`${r.canonicalUserID ?? "absent"}-${i}`}>
                    <TableCell className="font-medium text-gray-900">
                      {r.displayName ??
                        // hasAccount false = a live grant with no User row
                        // behind it (a claimed pending grant, a hand-seeded
                        // account). Shown as the bare id, NEVER omitted: hiding
                        // it would hide a live grant from the person whose job
                        // is to manage it.
                        (r.hasAccount ? (
                          <span className="text-gray-400">No name on file</span>
                        ) : (
                          <span className="text-gray-500">
                            No account signed in yet
                          </span>
                        ))}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">
                        {r.canonicalUserID ?? (
                          <span className="text-gray-400">—</span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-gray-600">
                      {r.email ?? <span className="text-gray-400">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                        disabled={!targetable || setRole.isPending}
                        title={
                          targetable
                            ? undefined
                            : "This grant has no canonical NUSNET id, so there is no key to change roles on. An admin has to clean it up."
                        }
                        onClick={() => {
                          if (!r.canonicalUserID) return;
                          setPending({
                            userID: r.canonicalUserID,
                            label,
                            grant: false,
                          });
                        }}
                      >
                        <UserMinus className="mr-1.5 h-3.5 w-3.5" />
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              variant="outline"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </section>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !setRole.isPending) {
            setPending(null);
            setReason("");
            setRole.reset();
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.grant
                ? `Give ${pending.label} JCRC access?`
                : `Remove ${pending?.label}’s JCRC access?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.grant
                ? "They’ll be able to review event proposals, browse every CCA roster, and manage CCA heads. Nothing else about their account changes."
                : "They’ll lose the JCRC tools straight away. Nothing else about their account changes — any CCA headship they hold stays."}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-1.5">
            <label
              htmlFor="jcrc-reason"
              className="block text-sm font-medium text-gray-700"
            >
              Reason <span className="text-gray-400">(optional)</span>
            </label>
            {/* Goes into the audit row. Optional because the server treats it as
                optional; asking for it here is what makes the record readable
                six months later. */}
            <textarea
              id="jcrc-reason"
              value={reason}
              maxLength={500}
              rows={2}
              disabled={setRole.isPending}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              placeholder="e.g. AY25/26 JCRC handover"
            />
          </div>

          {mutationError && (
            <p className="text-sm text-red-600">{mutationError}</p>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={setRole.isPending}>
              Cancel
            </AlertDialogCancel>
            {/* Not AlertDialogAction: that closes the dialog on click, which
                would dismiss it before the mutation resolves and hide any
                error. A plain button keeps it open until onSuccess closes it. */}
            <button
              type="button"
              disabled={setRole.isPending || pending === null}
              onClick={() => {
                if (!pending) return;
                setRole.mutate({
                  userID: pending.userID,
                  grant: pending.grant,
                  reason: reason.trim() || undefined,
                });
              }}
              className={`inline-flex h-10 items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 ${
                pending?.grant
                  ? "bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500"
                  : "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
              }`}
            >
              {setRole.isPending
                ? "Saving…"
                : pending?.grant
                  ? "Give JCRC access"
                  : "Remove JCRC access"}
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
