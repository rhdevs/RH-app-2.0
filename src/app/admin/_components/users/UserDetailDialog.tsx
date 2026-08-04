"use client";

import { useEffect, useState } from "react";
import { Lock, Trash2 } from "lucide-react";

import { api } from "~/trpc/react";
import type { RouterOutputs } from "~/trpc/react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import {
  BIO_MAX,
  BLOCKS,
  DISPLAY_NAME_MAX,
  sanitizeName,
} from "~/lib/schemas/profile";
// The field VALIDATORS are not needed here any more: since the form sends only
// what changed, `adminProfileFormSchema` (the mirror of the server's) is the one
// place a submitted value is judged. `sanitizeName` stays because the dirty
// check must compare the value as it would be STORED, not as it was typed.
// `PROFILE_FIELD_LABEL` is deliberately NOT imported: it is the resident's own
// second-person copy and every field name on this surface goes through
// OPERATOR_FIELD_LABEL instead. Leaving it out of the import list is what keeps
// the two voices from being mixed again by autocomplete.
import {
  REQUIRED_PROFILE_FIELDS,
  type ProfileField,
} from "~/lib/profileCompleteness";

import { useCapabilities } from "../AdminCapabilityContext";
import RoleBadge, { KeyMismatchIcon, NoAccessBadge } from "../RoleBadge";
import {
  adminProfileFormSchema,
  fieldErrorsFrom,
  friendlyError,
  isRetryable,
} from "../../_lib/userDetail";
import type { AdminUserRow } from "../../_lib/types";
import DeleteUserDialog from "./DeleteUserDialog";

/**
 * READ + EDIT one account's profile details. The host surface for admin CRUD
 * over USER DETAILS, opened from a row of the users table.
 *
 * A DIALOG, not an /admin/users/[id] route segment, deliberately: AdminShell's
 * rule is that every segment whose capability is narrower than reachDashboard
 * must ship its own layout.tsx doing a live role read. A dialog inherits
 * /admin/users' guard, its search and its pagination for free, and
 * ManageRolesDialog is the immediate sibling precedent for "act on one row".
 *
 * WHAT THIS SURFACE CANNOT DO, and why each is absent rather than disabled:
 *   - EMAIL. Read-only, with the reason stated to the operator in the panel
 *     below. Identity is derived from the localpart (canonicalUserID), so an
 *     edit re-keys the human's whole account; the router carries no email key
 *     in any input schema, so there is structurally nothing to change it with.
 *   - ROLES. Read-only badges plus a link to Manage roles. A second role UI is
 *     how a second role WRITER gets requested, and I-14 reserves `cca_head`
 *     for the CCA path.
 *   - CREATE. Signup and PendingRoleGrant own onboarding.
 *
 * Every conditional render reads a named boolean off useCapabilities(). No
 * component under src/app/admin/ may branch on a role string — that is
 * AdminCapabilityContext's stated rule, and the gate is a grep.
 */

type UserDetail = RouterOutputs["userAdmin"]["get"];

/**
 * Gate-field names as an OPERATOR reads them.
 *
 * NOT `PROFILE_FIELD_LABEL`, which is second-person copy for the resident's own
 * completion dialog ("your block", "your matriculation number") and reads as
 * nonsense on a form about somebody else. That map cannot be re-worded to suit
 * this surface either — it is what the gated resident is shown — so the two
 * voices are kept apart. The KEYS are `ProfileField`, so a field added to the
 * gate vocabulary is a type error here rather than a missing label.
 */
const OPERATOR_FIELD_LABEL: Record<ProfileField, string> = {
  displayName: "display name",
  telegramHandle: "Telegram handle",
  block: "block",
  matric: "matriculation number",
};

export default function UserDetailDialog({
  target,
  onClose,
  onManageRoles,
}: {
  target: AdminUserRow;
  onClose: () => void;
  /**
   * Hand the row back to the table so IT can swap this dialog for
   * ManageRolesDialog. Roles are not editable here (see the header), and
   * nesting the two dialogs would give the same row two owners of "which
   * dialog is open".
   */
  onManageRoles?: () => void;
}) {
  // The authoritative record, NOT the table row: the list projection carries no
  // matric, telegramHandle or bio, and its `roles` are redacted for a viewer
  // without seeAdminIdentities (D-2). Reading it here is also what applies the
  // G3 target guard — `userAdmin.get` calls assertMayManageUserProfileOf, so a
  // jcrc opening an admin's row gets FORBIDDEN, audited, and this dialog renders
  // the error panel instead of the form.
  const detail = api.userAdmin.get.useQuery(
    { userObjectId: target.id },
    { retry: false },
  );

  // Lifted out of DetailBody because the Dialog that must refuse to close lives
  // here. See the guard below for why it exists at all.
  const [saving, setSaving] = useState(false);

  return (
    <Dialog
      open
      // GUARDED, exactly as DeleteUserDialog guards its own: Escape and an
      // outside click reach this handler while the Close button is disabled, so
      // an unguarded version discards an in-flight save's RESULT — and if that
      // save then fails (a matric CONFLICT, CANNOT_MODIFY_AN_ADMIN after a
      // concurrent promotion), nothing is shown anywhere and the operator
      // reasonably believes the edit landed.
      onOpenChange={(o) => {
        if (!o && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>User details</DialogTitle>
          <DialogDescription>
            {target.displayName ?? target.email ?? target.canonicalUserID}
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {detail.isError && (
          <Alert variant="destructive">
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{friendlyError(detail.error)}</span>
              {/* RETRY ONLY WHERE A RETRY CAN CHANGE THE ANSWER. `userAdmin.get`
                  runs the G3 target guard, which AUDITS its denials, so an
                  unconditional Retry against a FORBIDDEN writes one more
                  `denied` RoleAuditLog row per click for an operation that can
                  never succeed — the audit-noise pattern DeleteUserDialog's
                  onError block calls out. See isRetryable for the code list and
                  why each is a property of the request rather than the moment. */}
              {isRetryable(detail.error) && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void detail.refetch()}
                >
                  Retry
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        {detail.data && (
          // Keyed on the record so the form's initial state is re-seeded if the
          // dialog is ever pointed at a different account without unmounting.
          <DetailBody
            key={detail.data.userObjectId}
            record={detail.data}
            onClose={onClose}
            onManageRoles={onManageRoles}
            onSavingChange={setSaving}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ========================================================================== */
/* The loaded body                                                            */
/* ========================================================================== */

function DetailBody({
  record,
  onClose,
  onManageRoles,
  onSavingChange,
}: {
  record: UserDetail;
  onClose: () => void;
  onManageRoles?: () => void;
  /** Reported upward so the Dialog can refuse to close mid-save. */
  onSavingChange: (saving: boolean) => void;
}) {
  const cap = useCapabilities();
  const utils = api.useUtils();

  /* ---- THE BASELINE, AND WHY IT IS STATE RATHER THAN `record` ---------------
   * `record` IS LIVE DATA. It is `detail.data` from a React Query hook whose
   * only staleness control is `staleTime: 30s` (src/trpc/query-client.ts), so
   * `refetchOnWindowFocus` — on by default — replaces it whenever the operator
   * alt-tabs back to a dialog that has been open for half a minute, and the
   * post-save `invalidate` replaces it again. The DetailBody `key` is the
   * userObjectId, which does not change, so none of that remounts this component
   * and none of it touches the form state below.
   *
   * THE DIRTY CHECK IN `submit` MUST COMPARE AGAINST WHAT THE FORM WAS SEEDED
   * FROM, NOT AGAINST WHATEVER THE QUERY HOLDS NOW. Reading it off `record` put
   * the silent revert back exactly where "send only what changed" removed it,
   * one refetch later: 10:00 the dialog seeds telegramHandle "old"; 10:05 the
   * resident fixes their own handle to "new"; 10:08 the operator alt-tabs back
   * and the focus refetch makes `record.telegramHandle` "new" while the input
   * still shows "old"; 10:10 they change the Block and save — "old" now DIFFERS
   * from the stored value, so it is sent as a change, and the resident's newer
   * handle is overwritten by a value nobody typed. Same for displayName, bio,
   * block and matric.
   *
   * So: FROZEN at mount, and moved forward only by a save that landed (see
   * `update.onSuccess`, which re-seeds it from what the server actually
   * persisted). `record` stays live for everything that DISPLAYS — the gap
   * panels, the shared-id warning, the roles — because those must reflect the
   * refetch; it is only the comparison that is pinned.
   */
  const [baseline, setBaseline] = useState(record);

  // Seeded ONCE from the record. Deliberately not re-synced to it on refetch:
  // after a save the record changes underneath, and overwriting the operator's
  // typed values with a background refetch is how an edit silently reverts.
  const [displayName, setDisplayName] = useState(record.displayName ?? "");
  const [telegramHandle, setTelegramHandle] = useState(
    record.telegramHandle ?? "",
  );
  const [bio, setBio] = useState(record.bio ?? "");
  // "" is the UNSET state and is distinct from an invalid block. The select is
  // never defaulted to a real block for a user who never chose one — the same
  // note src/lib/schemas/profile.ts records about `user?.block ?? 8`, which let
  // Block 8 be saved by accident.
  const [block, setBlock] = useState<number | "">(record.block ?? "");
  const [matric, setMatric] = useState(record.matric ?? "");
  const [reason, setReason] = useState("");

  /**
   * WALL 2's tick boxes — which post-merge entries this operator is prepared to
   * say are correct. See the orange panel below, and WALL 2 in
   * routers/userAdmin.ts for why the server will not infer this from the fact
   * that a save happened.
   */
  const [confirmed, setConfirmed] = useState<ProfileField[]>([]);

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  /**
   * The delete preflight, fetched HERE so the Danger zone button can reflect
   * the kill switch without a click that appears to do nothing. Same query key
   * DeleteUserDialog uses, so opening that dialog costs no second round trip —
   * React Query serves it from this cache.
   *
   * Gated on the capability, not merely hidden: `getDeletionImpact` is
   * admin-only server-side, so firing it as a jcrc would produce a FORBIDDEN
   * and an error state on a panel that is not even rendered for them.
   */
  const impact = api.userAdmin.getDeletionImpact.useQuery(
    { userObjectId: record.userObjectId },
    { enabled: cap.deleteUsers, retry: false },
  );

  const update = api.userAdmin.updateProfile.useMutation({
    onSuccess: async (result, variables) => {
      setFormError(null);
      setFieldErrors({});
      setSaved(true);
      /* THE BASELINE MOVES ONLY HERE, only to values that were PERSISTED, and
       * ONLY FOR THE FIELDS THIS SAVE ACTUALLY SUBMITTED. Without this the first
       * save's own fields stay "changed" forever and every subsequent save
       * re-sends them.
       *
       * THE PER-FIELD CONDITION IS THE WHOLE GUARANTEE, not tidiness, and
       * advancing all four unconditionally re-opened the exact silent revert the
       * baseline exists to close — one save later instead of one refetch later.
       * `result` is the POST-WRITE ROW, not an echo of the payload: the server's
       * `select` returns displayName / telegramHandle / bio / block whatever was
       * submitted, so an unsubmitted field comes back holding the CURRENT stored
       * value, including a newer edit the resident made themselves. The form
       * inputs are seeded once and deliberately never re-synced (see the state
       * below), so writing that value into `baseline` alone makes input and
       * baseline DISAGREE — and the next save reads the disagreement as "the
       * operator changed this" and writes the dialog's stale 10:00 value over
       * the resident's 10:02 one. It is reachable from a completely no-op first
       * save: open the dialog, click Save, tick nothing.
       *
       * So a field that was not sent keeps its ORIGINAL baseline, which still
       * matches the untouched input. The live `record` is what displays the
       * newer stored value (the invalidate below refetches it); the comparison
       * stays pinned to what the form was seeded from.
       *
       * `matricWritten` is null when no matric was submitted, which is NOT the
       * statement "this account has no matric" — so it falls back to the previous
       * baseline rather than blanking it. Same trap the server's return comment
       * names, and the shape the four fields above now follow.
       */
      setBaseline((b) => ({
        ...b,
        ...(variables.displayName !== undefined
          ? { displayName: result.displayName }
          : {}),
        ...(variables.telegramHandle !== undefined
          ? { telegramHandle: result.telegramHandle }
          : {}),
        ...(variables.bio !== undefined ? { bio: result.bio } : {}),
        ...(variables.block !== undefined ? { block: result.block } : {}),
        matric: result.matricWritten ?? b.matric,
      }));
      // The tick boxes are an answer to the prompt as it stood; the invalidate
      // below re-reads what is left of it. Carrying them into the next save
      // would confirm entries the operator has not seen since.
      setConfirmed([]);
      // The dialog STAYS OPEN on success, unlike ManageRolesDialog. The common
      // reason to be here is clearing a profile gap, and the gap panel below is
      // rendered from `record` — so the invalidate turns the amber note green
      // in place. That IS the confirmation; closing would hide it.
      await Promise.all([
        utils.userAdmin.get.invalidate({ userObjectId: record.userObjectId }),
        // displayName and block are columns in the users table.
        utils.admin.listUsers.invalidate(),
      ]);
    },
    // Inline, and the dialog stays open: the operator's entries are the input
    // to their next attempt.
    onError: (e) => {
      setSaved(false);
      setFormError(friendlyError(e));
    },
  });

  // The Dialog above owns "may this close"; the mutation state lives here.
  useEffect(() => {
    onSavingChange(update.isPending);
  }, [update.isPending, onSavingChange]);

  const submit = () => {
    setFormError(null);
    setSaved(false);

    /* ---- ONLY WHAT THE OPERATOR ACTUALLY CHANGED IS SENT -------------------
     * `undefined` means "leave the stored value alone" on both this schema and
     * the server's, and EVERY field is omitted unless the typed value differs
     * from the one this dialog loaded. Two properties fall out of that:
     *
     *   - clearing or WORSENING a field is impossible: a changed value is
     *     validated strictly (no "" on any gate field) and rejected otherwise;
     *   - a gap the operator cannot close does not block the ones they can, so
     *     a JCRC who knows a resident's block but not their Telegram handle can
     *     record the block. AN ADMIN EDIT MAY CLOSE A PROFILE GAP; IT MAY NEVER
     *     OPEN ONE — and leaving an already-open one exactly as it was does not
     *     open anything.
     *
     * IT USED TO SEND UNCHANGED-BUT-VALID VALUES TOO, and that was a silent
     * revert. The form is seeded ONCE when the dialog opens (see the state
     * above) and never re-synced, so a resident who fixes their own Telegram
     * handle at 10:05 had it overwritten with the 10:00 value by an operator
     * who at 10:10 changed only the Block — a field they never typed, never saw
     * flagged as changed, and could only discover afterwards from the audit
     * diff. The same applies between two JCRC members with the row open.
     *
     * EVERY COMPARISON BELOW IS AGAINST `baseline`, NEVER AGAINST `record`, and
     * that distinction is the whole guarantee. `record` moves under an open
     * dialog on any refetch, and comparing the 10:00 typed value against the
     * 10:08 stored one re-creates the identical revert with the dirty check
     * still in place — see the baseline's own note above.
     *
     * Sending them was load-bearing for ONE thing — a save clearing the
     * post-merge ProfileCompletion prompt on a field whose stored value was
     * already fine — and that is now an explicit tick box (`confirmFields`)
     * instead, because "a save happened" is not an answer to "is this stored
     * value this person's". Do not reintroduce the always-send to fix a
     * completion flag; it does not clear one any more, and it would bring the
     * revert back.
     */
    const nameTyped = sanitizeName(displayName);
    const nameStored = sanitizeName(baseline.displayName ?? "");
    const sendName = nameTyped !== nameStored ? displayName : undefined;

    const tgTyped = telegramHandle.trim().replace(/^@+/, "");
    const tgStored = (baseline.telegramHandle ?? "").trim().replace(/^@+/, "");
    const sendTelegram = tgTyped !== tgStored ? telegramHandle : undefined;

    // Compared trimmed, because the server trims before storing: re-sending a
    // value that differs only in whitespace would write a "change" the audit
    // diff then reports as none.
    const sendBio = bio.trim() !== (baseline.bio ?? "").trim() ? bio : undefined;

    // "" can only be reached from a record whose block was already unset: the
    // Select has no option that returns it to unset, so there is no path from a
    // stored block back to "". Guarded anyway, because if one is ever added
    // this must be an error and not a silent omission.
    if (block === "" && baseline.block != null) {
      setFieldErrors({ block: "A block can't be cleared here." });
      return;
    }
    const sendBlock =
      block === "" || block === baseline.block ? undefined : block;

    /* ---- matric: send it ONLY when it actually changed --------------------
     * `undefined` means "leave the UserMatric row alone", and the server has no
     * value meaning "clear it". So a blanked matric is refused HERE with copy
     * that says why, rather than being dropped silently — dropping it would
     * make the form look like it accepted a removal it never performed.
     */
    const nextMatric = matric.trim().toUpperCase();
    const storedMatric = (baseline.matric ?? "").trim().toUpperCase();
    const matricChanged = nextMatric !== storedMatric;
    if (matricChanged && nextMatric === "") {
      setFieldErrors({
        matric:
          "A matric can't be removed here — the profile gate requires it, and clearing it would lock this resident out. Ask a developer if the stored number is wrong.",
      });
      return;
    }

    // Refused HERE as well as on the server, with copy that names the remedy:
    // the matric row is keyed on the NUSNET id, which this account shares with
    // another, so the number shown may be the OTHER account's and writing it
    // would overwrite theirs. The server throws SHARED_CANONICAL_ID regardless —
    // this only keeps the operator from typing a value that cannot land.
    if (matricChanged && record.sharedCanonicalID) {
      setFieldErrors({
        matric:
          "Another account resolves to the same NUSNET id, and the matric record is filed under that shared id — saving here would overwrite the other account's number. Ask a developer to run the account merge first.",
      });
      return;
    }

    const parsed = adminProfileFormSchema.safeParse({
      displayName: sendName,
      telegramHandle: sendTelegram,
      bio: sendBio,
      block: sendBlock,
      matric: matricChanged ? nextMatric : undefined,
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }

    setFieldErrors({});
    // EXACTLY the keys updateSchema declares, and nothing else: it is
    // `.strict()`, so spreading the record in here (email, userID, roles …)
    // would 400 the whole save rather than being quietly stripped.
    update.mutate({
      userObjectId: record.userObjectId,
      displayName: parsed.data.displayName,
      telegramHandle: parsed.data.telegramHandle,
      bio: parsed.data.bio,
      block: parsed.data.block,
      matric: parsed.data.matric,
      /* WALL 2. Re-filtered against the LIVE `record` rather than sent from
       * state alone: a refetch can retire an entry between the tick and the
       * Save, and confirming something the panel no longer shows is a claim
       * about a prompt this operator never read. The server intersects with the
       * stored row again — this only keeps the payload honest.
       *
       * `undefined`, not `[]`, when nothing was ticked: every other key on this
       * schema uses `undefined` for "no instruction", and an empty array on the
       * audit-visible payload reads as an instruction that was given.
       */
      confirmFields: (() => {
        const live = new Set<string>(record.profileNeedsFields);
        const out = confirmed.filter((f) => live.has(f));
        return out.length ? out : undefined;
      })(),
      reason: reason.trim() || undefined,
    });
  };

  const gaps = record.profileGaps;
  /** WALL 2 — the post-merge completion row. A DIFFERENT wall; see below. */
  const needsFields = record.profileNeedsFields;
  /**
   * The WALL-2 entries this dialog can offer a TICK for. Two filters, and the
   * second is not cosmetic:
   *   - named by the gate vocabulary — a name a later deploy understands and
   *     this one does not is preserved untouched by the server, and offering a
   *     box for it would let an operator confirm something this build cannot
   *     even evaluate;
   *   - not ALSO an open gap. There is nothing to confirm about a value that is
   *     not there, the server refuses to resolve such an entry anyway (the gap
   *     test is the other half of its rule), and "the stored matriculation
   *     number is correct" over an empty one reads as a way to dismiss a wall
   *     without supplying anything. Fill it in the field above instead — that
   *     clears both walls in one save.
   */
  const confirmable = needsFields.filter(
    (f): f is ProfileField =>
      (REQUIRED_PROFILE_FIELDS as string[]).includes(f) &&
      !(gaps as string[]).includes(f),
  );
  const deleteEnabled = impact.data?.enabled ?? false;
  // `!deleteEnabled` alone is not "the switch is off": the preflight also
  // resolves to undefined on a network fault or a mid-session capability
  // change, and telling the operator the kill switch is off sends them to flip
  // a SystemFlag that may already be set.
  const deleteOff = impact.isSuccess && !impact.data.enabled;

  return (
    <>
      <div className="space-y-5">
        {/* ---------- 1. IDENTITY (read-only) -------------------------------- */}
        <section className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                <Lock className="h-3.5 w-3.5 shrink-0 text-gray-500" />
                <span className="truncate">{record.email}</span>
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Email cannot be changed. This account&rsquo;s identity — its
                bookings, roles, CCA memberships and matric — is derived from
                the part of the address before @u.nus.edu. Editing it would
                create a second, empty account and orphan everything attached to
                this one. To correct an address, ask a developer to run an
                account merge.
              </p>
            </div>
          </div>

          <dl className="mt-3 grid grid-cols-[auto,1fr] items-center gap-x-3 gap-y-1 text-xs">
            <dt className="text-gray-500">NUSNET id</dt>
            <dd className="font-mono text-xs text-gray-900">
              {record.canonicalUserID ?? (
                <span className="font-sans text-gray-400">
                  none — not an @u.nus.edu address
                </span>
              )}
            </dd>
            {record.legacyUserID && (
              <>
                <dt className="text-gray-500">Stored id</dt>
                <dd className="flex items-center gap-1.5 font-mono text-xs text-gray-900">
                  {record.legacyUserID}
                  {/* Reuses the table's marker rather than inventing a second
                      icon for the same fact. */}
                  {record.keyMismatch && <KeyMismatchIcon />}
                </dd>
              </>
            )}
          </dl>
        </section>

        {/* ---------- 2. ROLES (read-only) ----------------------------------- */}
        <section>
          <h3 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-gray-500">
            Roles
          </h3>
          <div className="flex flex-wrap items-center gap-1.5">
            {record.roles.length === 0 ? (
              <NoAccessBadge />
            ) : (
              record.roles.map((r) => <RoleBadge key={r} role={r} />)
            )}
          </div>
          <p className="mt-1.5 text-xs text-gray-500">
            Roles are managed from Manage roles.
          </p>
          {onManageRoles && record.canonicalUserID && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 px-0 text-emerald-700 hover:bg-transparent hover:text-emerald-800"
              onClick={onManageRoles}
            >
              Open Manage roles
            </Button>
          )}
        </section>

        {/* ---------- 3. PROFILE FORM ---------------------------------------- */}
        <section className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Profile
          </h3>

          {/* THE RECORD IS SPLIT ACROSS TWO ACCOUNTS. Rendered ABOVE both walls
              because it changes what the fields below MEAN: matric and the
              post-merge row are read (and would be written) under a NUSNET id
              this row shares with another live account, so the matric shown may
              be the other person's. The delete dialog already refuses on this
              state (SHARED_CANONICAL_ID) — the edit path refuses only the
              canonical-keyed half, so the copy has to say which half is which
              or the operator will read "can't edit" and stop. */}
          {record.sharedCanonicalID && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              Another account resolves to the same NUSNET id{" "}
              <span className="font-mono text-xs">
                {record.canonicalUserID}
              </span>{" "}
              — usually a stray space or different capitalisation in one of the
              two email addresses. The matriculation number and the post-merge
              prompt are filed under that shared id, so they belong to both rows
              and cannot be edited here. Name, Telegram handle, block and bio
              still apply to this row only. Ask a developer to run the account
              merge (scripts/remediation/merge-by-canonical.mjs) first.
            </div>
          )}

          {/* WALL 1 — the strict profile gate, cleared by saving a value.
              SUPPRESSED ENTIRELY WHEN THERE IS NO NUSNET ID, because both
              halves of its copy are false for such an account. MatricGate
              checks `hasIdentity === false` BEFORE `profileIncomplete` and
              hard-redirects that session to /onboarding/ineligible, so no value
              typed here unblocks anyone; and `matric` is in `gaps` for every
              one of these rows by construction (UserMatric is canonical-keyed,
              so `get` skips the read and returns null), while the matric input
              below is DISABLED for exactly this case — the one gap the panel
              names loudest is the one this form structurally cannot fill. An
              operator following it would type a name, a handle and a block,
              watch part of the list clear, and conclude they had half-fixed a
              resident whose actual problem is the email domain. */}
          {record.canonicalUserID === null ? (
            <div className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700">
              This account is not on an @u.nus.edu address, so it has no NUSNET
              id. The app checks that before it looks at profile details: the
              session is sent to the &ldquo;NUS account required&rdquo; screen
              whatever these fields say, so filling them in here does not
              unblock anyone. Correcting the address needs a developer.
            </div>
          ) : (
            gaps.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {/* OPERATOR_FIELD_LABEL, never PROFILE_FIELD_LABEL — see that
                    map's own note. This panel is about SOMEBODY ELSE, and the
                    resident-facing copy is second person ("your block", "your
                    matriculation number"), which would render as "…until they
                    supply your block" directly above tick boxes on this same
                    screen that correctly say "The stored block is correct." */}
                This resident is currently blocked from the app until these are
                supplied:{" "}
                {gaps.map((f, i) => (
                  <span key={f}>
                    {i > 0 && (i === gaps.length - 1 ? " and " : ", ")}
                    {OPERATOR_FIELD_LABEL[f]}
                  </span>
                ))}
                . Filling it in here clears it for them.
              </div>
            )
          )}

          {/* WALL 2 — the post-merge completion flag. A SEPARATE wall, checked
              FIRST by MatricGate and routed to a DIFFERENT screen
              (/onboarding/complete-profile), so it has to be surfaced
              separately: an operator who sees only the amber panel above will
              fill the form, watch it clear, and leave the resident redirected
              on every request. That is the trap
              scripts/remediation/unstick-profile-completion.mjs exists to
              release people from, and it stranded 18 of them.

              WHAT AN ENTRY MEANS, and why there are TICK BOXES rather than a
              promise that saving clears it. merge-by-canonical writes a field
              into `needsFields` when the two merged rows DISAGREED on its value:
              a value IS stored, it is one of the two candidates, and the open
              question is which one is this person's. So the entry is not "fill
              this in", it is "somebody check this". Typing a new value answers
              it; ticking the box answers it; a Save that never touched the field
              does not, and the copy here used to say it did. The server applies
              exactly that rule (routers/userAdmin.ts, WALL 2) — these boxes are
              the only thing that can send the confirmation. */}
          {needsFields.length > 0 && (
            <div className="rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900">
              <p>
                A merge also left this account on the post-merge confirmation
                screen, waiting on:{" "}
                <span className="font-mono text-xs">
                  {needsFields.join(", ")}
                </span>
                . That is a second, separate block. The merge found two different
                values for each of those and could not tell which was theirs, so
                a value IS stored — it may just be the wrong one.
              </p>
              {record.sharedCanonicalID ? (
                // The row is keyed on the SHARED id, so it is as likely to be
                // the other account's prompt as this one's. Clearing it from
                // here would take down a wall pointing at a real problem — the
                // server refuses regardless, so no tick boxes are offered.
                <p className="mt-1.5">
                  This save cannot clear it: that record is filed under the
                  NUSNET id this account shares with another. Run the merge
                  first.
                </p>
              ) : (
                <>
                  <p className="mt-1.5">
                    {confirmable.length > 0
                      ? "Correct the field above, or — if you have checked the stored value against something reliable and it is right — say so here. Nothing else clears it: a save that leaves a field alone leaves its prompt standing."
                      : "Fill the field in above and this clears with it. A save that leaves a field alone leaves its prompt standing."}
                  </p>
                  {confirmable.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {confirmable.map((f) => (
                        <label
                          key={f}
                          className="flex items-start gap-2 text-sm"
                        >
                          <Checkbox
                            className="mt-0.5 border-orange-400"
                            checked={confirmed.includes(f)}
                            onCheckedChange={(v) =>
                              setConfirmed((prev) =>
                                v ? [...prev, f] : prev.filter((x) => x !== f),
                              )
                            }
                          />
                          <span>
                            The stored {OPERATOR_FIELD_LABEL[f]} is correct.
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </>
              )}
              <p className="mt-1.5">
                Anything left in the list that this form does not cover needs a
                developer.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ud-display-name">Display name</Label>
            <Input
              id="ud-display-name"
              value={displayName}
              maxLength={DISPLAY_NAME_MAX}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            {fieldErrors.displayName && (
              <p className="text-sm text-red-600">{fieldErrors.displayName}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ud-telegram">Telegram handle</Label>
            {/* "@" is a static adornment and any typed "@" is stripped, so
                there is exactly one canonical stored form — the same rule the
                resident's own form and the server transform apply. */}
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 select-none text-sm text-gray-500">
                @
              </span>
              <Input
                id="ud-telegram"
                className="pl-7"
                value={telegramHandle}
                maxLength={32}
                onChange={(e) =>
                  setTelegramHandle(e.target.value.replace(/@/g, ""))
                }
              />
            </div>
            {fieldErrors.telegramHandle && (
              <p className="text-sm text-red-600">
                {fieldErrors.telegramHandle}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ud-block">Block</Label>
            <Select
              // `undefined` renders the placeholder. There is deliberately no
              // option that returns the select to unset: block is a gate field,
              // and an admin edit may close a gap but never open one.
              value={block === "" ? undefined : String(block)}
              onValueChange={(v) => setBlock(Number(v))}
            >
              <SelectTrigger id="ud-block">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                {BLOCKS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    Block {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.block && (
              <p className="text-sm text-red-600">{fieldErrors.block}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ud-matric">Matriculation number</Label>
            {/* Uppercased as typed, so what is shown is what is stored — the
                server applies the same transform. */}
            <Input
              id="ud-matric"
              value={matric}
              maxLength={9}
              autoComplete="off"
              spellCheck={false}
              placeholder="A0234567X"
              className="font-mono uppercase"
              // UserMatric is CANONICAL-KEYED, and there are TWO ways that key
              // can fail to be this row's alone. No key at all (a non-NUS
              // account — the server refuses with NO_CANONICAL_IDENTITY), or a
              // key SHARED with another live User row (the server refuses with
              // SHARED_CANONICAL_ID, because the upsert would land on the other
              // account's matric). Disabled WITH a reason in both cases, not
              // silently absent — the value shown is still the stored one, and
              // on a shared id it may not even be this person's.
              disabled={
                record.canonicalUserID === null || record.sharedCanonicalID
              }
              title={
                record.canonicalUserID === null
                  ? "This account isn't on an @u.nus.edu address, so it has no matric record."
                  : record.sharedCanonicalID
                    ? "Another account shares this NUSNET id, so this matric record belongs to both. Run the account merge first."
                    : undefined
              }
              onChange={(e) => setMatric(e.target.value.toUpperCase())}
            />
            {fieldErrors.matric && (
              <p className="text-sm text-red-600">{fieldErrors.matric}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ud-bio">
              Bio <span className="text-gray-400">(optional)</span>
            </Label>
            <Textarea
              id="ud-bio"
              value={bio}
              maxLength={BIO_MAX}
              rows={3}
              onChange={(e) => setBio(e.target.value)}
            />
            <p className="text-right text-xs text-gray-500">
              {bio.length}/{BIO_MAX}
            </p>
            {fieldErrors.bio && (
              <p className="text-sm text-red-600">{fieldErrors.bio}</p>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Display name, Telegram handle, block and matric are required by the
            profile gate. Saving a blank value would lock this resident behind
            the completion screen, so the form will not let you. Only the bio
            can be cleared.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="ud-reason">
              Reason <span className="text-gray-400">(optional)</span>
            </Label>
            {/* Optional deliberately, same as ManageRolesDialog: forcing a
                reason on every edit makes people type "x". Stored on the audit
                row when supplied — the field-level diff is recorded either way. */}
            <Textarea
              id="ud-reason"
              value={reason}
              maxLength={500}
              rows={2}
              placeholder="Recorded on the audit entry."
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          {saved && !update.isPending && (
            <p className="text-sm text-emerald-700">Saved.</p>
          )}
        </section>

        {/* ---------- 4. DANGER ZONE ----------------------------------------- */}
        {cap.deleteUsers && (
          <section className="rounded-lg border border-red-300 bg-red-50 px-3 py-2.5">
            <h3 className="text-sm font-semibold text-red-800">Danger zone</h3>
            <p className="mt-1 text-xs text-red-700">
              Deleting an account removes their bookings, posts, CCA
              memberships, applications and role record permanently. There is no
              undo.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 border-red-300 bg-white text-red-700 hover:bg-red-100 hover:text-red-800"
              disabled={!deleteEnabled || impact.isLoading}
              title={deleteOff ? "Account deletion is turned off." : undefined}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Delete account
            </Button>
            {deleteOff && (
              <p className="mt-1.5 text-xs text-red-700">
                Account deletion is turned off.
              </p>
            )}
            {impact.isError && (
              <p className="mt-1.5 text-xs text-red-700">
                {friendlyError(impact.error)}
              </p>
            )}
          </section>
        )}
      </div>

      <DialogFooter className="mt-6">
        <Button variant="outline" onClick={onClose} disabled={update.isPending}>
          Close
        </Button>
        <Button
          className="bg-emerald-700 text-white hover:bg-emerald-800"
          disabled={update.isPending}
          onClick={submit}
        >
          {update.isPending ? "Saving…" : "Save details"}
        </Button>
      </DialogFooter>

      {confirmDelete && (
        <DeleteUserDialog
          userObjectId={record.userObjectId}
          label={record.displayName ?? record.email}
          onClose={() => setConfirmDelete(false)}
          // The account is gone: this dialog is describing a row that no longer
          // exists, so it closes too rather than sitting on a stale record.
          onDeleted={() => {
            setConfirmDelete(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
