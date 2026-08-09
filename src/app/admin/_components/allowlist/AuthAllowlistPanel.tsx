"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { AlertTriangle, ShieldAlert, Trash2 } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { EXT_ID } from "~/lib/identity";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { Textarea } from "~/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

import EmptyState from "../EmptyState";
import RoleBadge from "../RoleBadge";
import { friendlyError, type ClientErrorLike } from "../../_lib/userDetail";

/**
 * THE ADMIN SIDE OF D-7 BREAK-GLASS (AuthAllowlist). Read
 * src/server/api/routers/admin.ts's "THE D-7 BREAK-GLASS ALLOWLIST" block
 * before changing anything here — this panel is the ONLY UI over the ONLY
 * surface that MINTS an identity rather than moving a privilege around on top
 * of one. Every other admin screen edits or grants against an id that already
 * exists; a click on "Add" here is what makes one exist in the first place,
 * for an address the app would otherwise never let sign in.
 *
 * `adminProcedure` on all three underlying calls, same tier as
 * `manageFacilityAccess` / `readAuditLog` — an scrc holder (whose own
 * identity was very possibly issued from this exact table) must not see or
 * edit the collection that issued it. The route's own layout.tsx re-asserts
 * this with a live role read; this component trusts nothing about "the tab
 * was hidden" as a security boundary, only as a courtesy.
 */
type Row = RouterOutputs["admin"]["listAuthAllowlist"]["items"][number];

/** Same "under 7 days is relative, else absolute" rule AuditLogTable uses —
 *  consistent reading across the two accountability surfaces this role touches. */
function when(at: Date) {
  const d = new Date(at);
  return Date.now() - d.getTime() < 7 * 24 * 3600 * 1000
    ? formatDistanceToNow(d, { addSuffix: true })
    : format(d, "d MMM yyyy, HH:mm");
}

/**
 * The convention this UI SUGGESTS, never enforces: uppercase the email
 * localpart, replace every character outside [A-Z0-9_] with '_'. The server's
 * `extUserIDSchema` is the only thing that actually decides whether a typed
 * value is admitted — this only saves the operator from typing the transform
 * by hand for the common case.
 */
function suggestPin(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  const slug = local.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return slug ? `EXT:${slug}` : "EXT:";
}

/**
 * Pulls a field-level message out of a tRPC BAD_REQUEST's attached
 * `zodError` (see trpc.ts's `errorFormatter`), which `friendlyError` in
 * userDetail.ts does not look at — that map is keyed on whole messages and
 * codes shared with the user-profile surfaces, and a schema shaped like
 * `{ email, pinnedUserID, note }` is unique to this form. Falls back to
 * `null` so the caller always has `friendlyError`'s generic banner to show
 * instead of nothing.
 */
function zodFieldError(err: unknown, field: string): string | null {
  const data = (
    err as {
      data?: { zodError?: { fieldErrors?: Record<string, string[]> } | null };
    } | null
  )?.data;
  return data?.zodError?.fieldErrors?.[field]?.[0] ?? null;
}

export default function AuthAllowlistPanel() {
  const utils = api.useUtils();
  const {
    data,
    isLoading,
    isError,
    error: loadError,
    refetch,
  } = api.admin.listAuthAllowlist.useQuery();
  // Initial-load failure only (09 §2.8) — a later refetch blip must not wipe
  // a panel that is already showing live pins.
  const loadFailed = isError && !data;
  const rows = data?.items ?? [];

  /* ---------------------------------------------------------------------- */
  /* ADD                                                                    */
  /* ---------------------------------------------------------------------- */
  const [email, setEmail] = useState("");
  const [pinnedUserID, setPinnedUserID] = useState("");
  const [note, setNote] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [pinFieldError, setPinFieldError] = useState<string | null>(null);
  const [emailFieldError, setEmailFieldError] = useState<string | null>(null);

  const add = api.admin.addAuthAllowlistEntry.useMutation({
    onSuccess: async () => {
      setEmail("");
      setPinnedUserID("");
      setNote("");
      setAddError(null);
      setPinFieldError(null);
      setEmailFieldError(null);
      // Without this the new pin is invisible for up to 15s — including on
      // the very next load of this same page — and the natural response is
      // to click Add again, which the unique index then refuses as
      // PIN_ALREADY_USED / EMAIL_ALREADY_PINNED: a confusing error caused
      // entirely by the client's own stale cache.
      await utils.admin.listAuthAllowlist.invalidate();
    },
    onError: (e) => {
      setAddError(friendlyError(e));
      setPinFieldError(zodFieldError(e, "pinnedUserID"));
      setEmailFieldError(zodFieldError(e, "email"));
    },
  });

  // MIRROR ONLY, for immediate feedback. Deliberately NEVER used to withhold
  // the mutation: the server's extUserIDSchema is the sole authority, and a
  // client check that disagreed with it would either block a value the
  // server would have accepted (with no way for the operator to override) or
  // — worse — pass a value the server actually refuses through to nothing,
  // since the button would then just be disabled with no explanation. Every
  // click of Add reaches the server; this only colours the hint underneath
  // the field before that round trip lands.
  const pinnedTrimmed = pinnedUserID.trim();
  const pinLooksValid = pinnedTrimmed === "" || EXT_ID.test(pinnedTrimmed);

  const submitAdd = () => {
    setAddError(null);
    setPinFieldError(null);
    setEmailFieldError(null);
    add.mutate({
      email,
      pinnedUserID,
      note: note.trim() || undefined,
    });
  };

  /* ---------------------------------------------------------------------- */
  /* REMOVE                                                                 */
  /* ---------------------------------------------------------------------- */
  const [removing, setRemoving] = useState<Row | null>(null);

  return (
    <div className="space-y-6">
      {loadFailed && (
        <Alert variant="destructive">
          <AlertTitle>Could not load the allowlist</AlertTitle>
          <AlertDescription>
            The table below is empty because the entries could not be
            fetched, not because none exist. Every warning this panel would
            otherwise raise — an unhydrated account, a mismatched key, an
            invalid pin — is invisible until this loads.{" "}
            {loadError?.message ?? "Something went wrong."}
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={() => void refetch()}>
                Try again
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {/* ---------- THE TABLE OF EXISTING PINS ------------------------------ */}
      <div className="overflow-x-auto rounded-xl bg-white shadow-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Pinned ID</TableHead>
              <TableHead>Roles</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadFailed ? (
              <TableRow>
                <TableCell colSpan={7}>
                  <EmptyState
                    title="Could not load the allowlist"
                    hint="This is not a list of zero entries — nothing could be read."
                  />
                </TableCell>
              </TableRow>
            ) : (
              !isLoading &&
              rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState
                      title="No allowlist entries"
                      hint="Every resident signs in on their own @u.nus.edu address. Add an entry only for a principal who genuinely has none — hall office staff, typically."
                    />
                  </TableCell>
                </TableRow>
              )
            )}
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7} className="text-sm text-gray-500">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <AllowlistRow key={r.pinnedUserID} row={r} onRemove={setRemoving} />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ---------- THE ADD FORM --------------------------------------------
          Not gated on `pinLooksValid` — see that constant's own comment. Only
          gated on the fields being non-empty and no mutation in flight, so a
          click ALWAYS reaches the server, which is the only real judge. */}
      <div className="space-y-3 rounded-xl bg-white p-4 shadow-lg">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">
            Pin a new address
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">
            This issues a brand-new identity. There is no undo button for a
            role granted under it — revoke the roles first, from Manage
            roles, before ever removing the entry (see the warning on the
            Remove confirmation).
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="al-email">Email</Label>
            <Input
              id="al-email"
              type="email"
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              placeholder="ngocanh.mai@nus.edu.sg"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {emailFieldError && (
              <p className="text-sm text-red-600">{emailFieldError}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="al-pin">Pinned ID</Label>
            <Input
              id="al-pin"
              autoComplete="off"
              spellCheck={false}
              maxLength={36}
              className="font-mono uppercase"
              placeholder={
                email.trim() ? suggestPin(email) : "EXT:NGOCANH_MAI"
              }
              value={pinnedUserID}
              onChange={(e) => setPinnedUserID(e.target.value.toUpperCase())}
            />
            {/* Convenience only — fills the box with the convention computed
                from whatever is currently in Email. The operator can still
                type anything the server will accept; this never disables the
                field or the Add button. */}
            {email.trim() && (
              <button
                type="button"
                className="text-xs text-emerald-700 hover:underline"
                onClick={() => setPinnedUserID(suggestPin(email))}
              >
                Use {suggestPin(email)}
              </button>
            )}
            {pinnedTrimmed !== "" && !pinLooksValid && (
              <p className="text-sm text-amber-700">
                Doesn&rsquo;t look like{" "}
                <span className="font-mono">EXT:&lt;SLUG&gt;</span> yet —
                uppercase letters, digits and underscore, 3–32 characters
                after the colon. The server has the final say; this is only a
                hint before you submit.
              </p>
            )}
            {pinFieldError && (
              <p className="text-sm text-red-600">{pinFieldError}</p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="al-note">
            Note <span className="text-gray-400">(optional)</span>
          </Label>
          <Textarea
            id="al-note"
            maxLength={200}
            rows={2}
            placeholder="Why this address exists. Rendered to every admin who opens this panel."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {addError && (
          <Alert variant="destructive">
            <AlertDescription>{addError}</AlertDescription>
          </Alert>
        )}

        <div className="flex justify-end">
          <Button
            className="bg-emerald-700 text-white hover:bg-emerald-800"
            disabled={!email.trim() || !pinnedUserID.trim() || add.isPending}
            onClick={submitAdd}
          >
            {add.isPending ? "Adding…" : "Add entry"}
          </Button>
        </div>
      </div>

      {removing && (
        <RemoveEntryDialog
          row={removing}
          onClose={() => setRemoving(null)}
          onRemoved={async () => {
            setRemoving(null);
            await utils.admin.listAuthAllowlist.invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ========================================================================== */
/* One row                                                                    */
/* ========================================================================== */

function AllowlistRow({
  row,
  onRemove,
}: {
  row: Row;
  onRemove: (row: Row) => void;
}) {
  /* THE LOUD RED CASE. `namespaceViolation` means `~/lib/identity.ts`'s
   * `isExtUserID` rejects the STORED `pinnedUserID` — read back at query time
   * by the router, not re-derived here. That can only happen from a hand
   * edit in Atlas or a code path that skipped `extUserIDSchema` entirely,
   * because every write this app makes goes through that schema first (M4).
   *
   * WHAT BREAKS IF IGNORED: nothing, in the dangerous direction — this is the
   * mechanism working, not failing. M2 (`pinnedUserIDFor`, re-validated at
   * EVERY session read) drops a row shaped like this on the floor before it
   * ever reaches `resolvePrincipalID`, so it mints no identity at all. The
   * actual risk is the OPERATOR'S mental model: a row sitting in this table
   * looking like every other row, quietly doing nothing, while whoever it
   * was meant for cannot sign in and nobody knows why. That is the entire
   * reason this gets a full red row instead of a small icon.
   *
   * ALSO WHY REMOVE IS DISABLED BELOW: `removeAuthAllowlistEntry`'s own input
   * schema is `extUserIDSchema` — the SAME regex this row just failed — so
   * the mutation would refuse its own input before the resolver ever runs.
   * This panel cannot delete what it cannot validate; only a developer
   * working directly against Mongo can clear this row.
   */
  if (row.namespaceViolation) {
    return (
      <TableRow className="border-l-4 border-l-red-600 bg-red-50">
        <TableCell className="font-mono text-xs">{row.email}</TableCell>
        <TableCell className="font-mono text-xs text-red-700">
          {row.pinnedUserID}
        </TableCell>
        <TableCell colSpan={5} className="text-sm text-red-800">
          <span className="flex items-start gap-1.5">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>Invalid — mints no identity.</strong> This value does
              not match the <span className="font-mono">EXT:</span>{" "}
              namespace, so it is dropped at every read and nobody can ever
              sign in on it. It cannot have been written by this panel — only
              a direct database edit produces this shape. It also cannot be
              removed from here: the remove mutation validates its input
              against the same pattern this row already fails. Ask a
              developer to delete it directly.
            </span>
          </span>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell className="max-w-[16rem] truncate font-mono text-xs">
        {row.email}
      </TableCell>
      <TableCell className="font-mono text-xs">{row.pinnedUserID}</TableCell>
      <TableCell>
        {row.roles.length === 0 ? (
          <span className="text-xs text-gray-400">No roles yet</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {row.roles.map((r) => (
              <RoleBadge key={r} role={r} />
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="max-w-[16rem] truncate text-xs text-gray-600">
        {row.note ?? "—"}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-gray-500">
        {when(row.addedAt)}
        <br />
        <span className="font-mono">{row.addedBy}</span>
      </TableCell>
      <TableCell>
        <StatusCell row={row} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          size="sm"
          variant="outline"
          className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-800"
          onClick={() => onRemove(row)}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}

function StatusCell({ row }: { row: Row }) {
  /* `hasUser: false`. WHAT BREAKS IF IGNORED: nothing crashes — the entry
   * just does nothing. `resolvePrincipalID` would happily mint the pinned
   * id the moment this address signs in, but there is no `User` row for the
   * PrismaAdapter to attach it to, and no session comes out. An operator who
   * added this row believing it "provisions" the staff member has actually
   * done half the job; the other half — creating the User row with this
   * exact `userID` (F7 in the plan) — has to happen separately. */
  if (!row.hasUser) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-amber-700"
        title="No account exists on this address yet — provision it, or the entry does nothing."
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        No account yet
      </span>
    );
  }

  /* `keyMismatch: true`. WHAT BREAKS IF IGNORED: the account CAN sign in and
   * hold roles — sessions resolve on `pinnedUserID`, not on `User.userID` —
   * but `facilitiesBooking.ts` joins a booking back to its owner on
   * `User.userID`, so every booking this person makes renders with a blank
   * owner name to whoever is looking at the roster or the facility
   * dashboard. The fix is a developer correcting the stored `User.userID` to
   * match this pin; there is no button for it here because a blanket "make
   * these match" write on someone else's identity key does not belong on a
   * one-click surface. */
  if (row.keyMismatch) {
    return (
      <span
        className="flex items-center gap-1.5 text-xs text-amber-700"
        title="The provisioned account's stored ID doesn't hold this pin. Their bookings will render with a blank owner name until a developer corrects it."
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Key mismatch
      </span>
    );
  }

  return (
    <span
      className="text-xs text-emerald-700"
      title="The pin is well-formed, an account is provisioned under it, and the account's stored ID matches. Sessions on this address resolve normally."
    >
      Live{row.displayName ? ` · ${row.displayName}` : ""}
    </span>
  );
}

/* ========================================================================== */
/* Remove confirmation                                                        */
/* ========================================================================== */

/**
 * Same primitive DeleteUserDialog uses for the same reason: this needs to
 * show WHY a removal might be refused, and a native `confirm()` can only show
 * a sentence.
 *
 * No typed-confirmation text, unlike DeleteUserDialog — removing a pin does
 * not touch a booking, a post or a matric record, so the blast radius here is
 * "this address can no longer sign in", which the copy states plainly rather
 * than making the operator retype the email to prove they read it.
 */
function RemoveEntryDialog({
  row,
  onClose,
  onRemoved,
}: {
  row: Row;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [reason, setReason] = useState("");

  const remove = api.admin.removeAuthAllowlistEntry.useMutation({
    onSuccess: onRemoved,
  });

  const error: ClientErrorLike = remove.error ?? null;

  /* PRE-EMPTIVE REFUSAL, computed from data this panel already has loaded —
   * `listAuthAllowlist` hydrates `roles` for exactly this reason, so no
   * second query is needed to know the server will refuse. Mirrors
   * DeleteUserDialog's rule: A REFUSAL REMOVES THE CONFIRM CONTROL, it does
   * not merely disable it, because a disabled destructive button reads as
   * "try harder" and an absent one plus a sentence naming the remedy reads as
   * "do this other thing first" — which is what PIN_STILL_HOLDS_ROLES means.
   * Stale by up to the list's own staleness window; the server re-checks
   * live regardless (that check is REFUSAL 2 in removeAuthAllowlistEntry),
   * so a role granted in the seconds between this render and the click is
   * still caught, just with a less friendly error. */
  const blockedByRoles = row.roles.length > 0;

  return (
    <AlertDialog
      open
      onOpenChange={(o) => {
        if (!o && !remove.isPending) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this allowlist entry?</AlertDialogTitle>
          <AlertDialogDescription>
            {row.email} · <span className="font-mono">{row.pinnedUserID}</span>{" "}
            · this revokes the identity — the address can no longer sign in —
            but does not touch anything already stored under the id.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {blockedByRoles ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <p className="font-medium">This entry can&rsquo;t be removed.</p>
            {/* A <div>, not a <p>: RoleBadge renders a <div> (shadcn's Badge),
                and a block element inside a <p> is invalid HTML that the
                browser silently re-parses, splitting this paragraph in two
                and producing a hydration mismatch. */}
            <div>
              Its ID still holds{" "}
              <span className="inline-flex flex-wrap items-center gap-1 align-middle">
                {row.roles.map((r) => (
                  <RoleBadge key={r} role={r} />
                ))}
              </span>
              . Revoke {row.roles.length === 1 ? "it" : "them"} from Manage
              roles first — otherwise removing the pin leaves the roles
              standing under an identity nothing can reach any more, and a
              future entry re-issued on this or any other address would
              inherit them silently the moment it was granted.
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="al-remove-reason">
              Reason <span className="text-gray-400">(optional)</span>
            </Label>
            <Textarea
              id="al-remove-reason"
              value={reason}
              maxLength={500}
              rows={2}
              placeholder="Recorded on the audit entry."
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{friendlyError(error)}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>
            Cancel
          </AlertDialogCancel>
          {/* A plain Button, not AlertDialogAction — Radix would dismiss the
              dialog on click before the mutation's error (or the pending
              state) could be shown, same reasoning as DeleteUserDialog. */}
          {!blockedByRoles && (
            <Button
              className="bg-red-700 text-white hover:bg-red-800"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate({
                  pinnedUserID: row.pinnedUserID,
                  reason: reason.trim() || undefined,
                })
              }
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
