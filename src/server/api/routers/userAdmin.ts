import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { createTRPCRouter, roleManagerProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import {
  ADMIN_ROLE,
  computeCapabilities,
  type Capabilities,
} from "~/server/api/services/roles";
import { writeAudit } from "~/server/api/routers/admin";
import {
  assertMatricUnclaimed,
  clearable,
  writeMatric,
} from "~/server/api/services/profile";
import {
  assertMayManageUserProfileOf,
  assertUserDeleteEnabled,
  computeDeleteRefusals,
  countUserFootprint,
  deleteUserAccountCascade,
  findCanonicalIdCollisions,
  isUserDeleteEnabled,
  loadAdminUserTarget,
} from "~/server/api/services/userAdmin";
import {
  REQUIRED_PROFILE_FIELDS,
  computeProfileGaps,
  isDisplayNameValid,
  type ProfileField,
} from "~/lib/profileCompleteness";
import {
  BIO_MAX,
  BLOCKS,
  DISPLAY_NAME_MAX,
  MATRIC_RE,
  TELEGRAM_RE,
  sanitizeName,
} from "~/lib/schemas/profile";
import { isExtUserID } from "~/lib/identity";

/**
 * ADMIN CRUD OVER USER DETAILS — the /admin/users detail dialog.
 *
 * READ, UPDATE, DELETE. There is deliberately no CREATE: signup and
 * PendingRoleGrant already own onboarding, and a hand-minted User row would be
 * an account with no password, no verified NUS provenance and no session path.
 *
 * EMAIL IS IMMUTABLE HERE. Identity is derived from the email localpart
 * (`canonicalUserID`, src/lib/identity.ts), so changing an email re-keys a
 * human's ENTIRE identity — roles, matric, CCA memberships, bookings — and
 * leaves the old key's rows attached to nobody. That is the exact defect that
 * produced two duplicate accounts this week (see
 * scripts/remediation/fix-claresta-duplicate.mjs and fix-lgd-duplicate.mjs).
 * The protection here is STRUCTURAL, not a check: no input schema below carries
 * an `email` key, the update schema is `.strict()` so a payload containing one
 * 400s loudly rather than being silently stripped, and the target is named by
 * `User` ObjectId with the canonical key DERIVED server-side from the stored
 * row. There is nothing to change an email WITH.
 *
 * ROLES ARE NOT WRITTEN HERE EITHER. admin.setUserRoles / grantCcaHead /
 * revokeCcaHead / transferCcaHead own them, and I-14 reserves the `cca_head`
 * string for `writeCcaHeadString` on the CCA path. `delete` REMOVES the whole
 * `UserRole` document inside the cascade transaction; it never writes a role
 * SET, so it is not a second writer of `UserRole.roles` and cannot drop
 * `resident` from anyone (I-8c). Nothing else in this file touches UserRole
 * except a read.
 *
 * THE TARGET IS ALWAYS A `User` ObjectId, never a client-supplied userID.
 * `User.userID` is NOT the identity: it holds an A-format matric on ~515 rows
 * and, on the split-identity rows, another live human's canonical key. Taking
 * `userID: userIDSchema` the way setUserRoles does would re-open that wrong-row
 * hazard AND, because that schema is /^E\d{7}$/, would make G.S_SAMUEL and
 * CHUAMINGYUAN unreachable (lockout mode L-27). Same call ccaAdmin.ts made.
 *
 * TO ARM THE DELETE (no redeploy needed; env vars are snapshotted per Vercel
 * deployment, a SystemFlag row is not):
 *   db.systemFlag.upsert({ where: { key: "admin.userDelete.enabled" },
 *     create: { key: "admin.userDelete.enabled", value: "on" },
 *     update: { value: "on" } })
 * It takes effect within the 15s per-lambda cache in services/userAdmin.ts.
 * Update has no switch — it is reversible and carries no privilege.
 *
 * Separate file rather than more of admin.ts, which is already past 2700 lines.
 * The gate class (roleManagerProcedure) is the same, so these could have lived
 * there; ccaAdmin.ts made the same split for the same reason.
 */

/* ========================================================================== */
/* Capability assertion                                                       */
/* ========================================================================== */

/**
 * Re-stated from admin.ts rather than imported: the copy there is module-local
 * (not exported) and could not move to roles.ts anyway, because roles.ts is
 * deliberately runtime-pure so client components can import the vocabulary and
 * this needs TRPCError. Identical semantics, identical message shape
 * (`CAPABILITY_REQUIRED:<key>`), so the client's error map covers both files.
 *
 * The procedure middleware answers "may you reach this surface"; this answers
 * "may you do this thing". Both are required — roleManagerProcedure admits
 * every jcrc, and `deleteUsers` is admin-only.
 */
function requireCapability<K extends keyof Capabilities>(
  c: Capabilities,
  key: K,
): void {
  const v = c[key];
  if (v === false || (Array.isArray(v) && v.length === 0)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `CAPABILITY_REQUIRED:${String(key)}`,
    });
  }
}

const caps = (roles: readonly string[] | undefined) =>
  computeCapabilities(roles ?? []);

/* ========================================================================== */
/* Input schemas                                                              */
/* ========================================================================== */

/**
 * The target. A Mongo ObjectId hex string as the users table already hands it
 * back (`AdminUserRow.id`).
 *
 * THE HEX SHAPE IS CHECKED HERE, not left to the loader. `findUnique({ where:
 * { id } })` on Prisma's Mongo connector does NOT return null for a malformed
 * id — it throws P2023 ("Malformed ObjectID"), which tRPC wraps as
 * INTERNAL_SERVER_ERROR, `sanitizeErrors` rewrites to "Something went wrong."
 * and the dialog then renders as "That didn't save. Try again.", pointing the
 * operator at a retry that can never succeed. A stale link or a hand-typed id
 * must read as NOT_FOUND, and the only way to keep that promise is to refuse
 * the shape before it reaches Prisma.
 *
 * A well-formed id that is not a `User._id` (a `UserRole._id`, say) still falls
 * through to `loadAdminUserTarget`'s NOT_FOUND, which is correct — that is a
 * genuine miss, not a malformed request.
 */
const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, "NO_SUCH_USER");

const targetSchema = z.object({ userObjectId: objectIdSchema });

/** Audit `reason` is operator prose; the same cap ManageRolesDialog imposes. */
const REASON_MAX = 500;

/**
 * STRICTER THAN `updateProfileInput` ON PURPOSE — and stricter in exactly one
 * direction.
 *
 * On the self-service path `""` on telegramHandle means "clear it", and
 * displayName may be empty because NextAuth's Google adapter created rows
 * without one. Neither is allowed here. The strict profile-completion gate is
 * ALWAYS ON (no kill switch — `computeProfileGaps` is evaluated in the session
 * callback and there is no flag that turns it off), so an admin who saves a
 * blank telegramHandle, displayName, block or matric walls that resident behind
 * the completion dialog with no way to see who did it or to appeal. A resident
 * who blanks their own field can immediately un-blank it; the person on the
 * other end of THIS form cannot.
 *
 * The rule, stated once: AN ADMIN EDIT MAY CLOSE A PROFILE GAP; IT MAY NEVER
 * OPEN ONE. Only `bio` is clearable, because bio is not a gate field.
 *
 * WHICH IS WHY EVERY GATE FIELD IS `.optional()`, AND THAT IS NOT A WEAKENING.
 * An omitted field means "leave the stored value exactly as it is"; a PRESENT
 * one must satisfy its validator outright. So the only value a gate field can
 * be moved TO is a valid one, which is the rule above — while an operator who
 * knows a gated resident's block but not their Telegram handle can still record
 * the block. Requiring all four to be valid on every save would have made this
 * form unusable for exactly the cohort it exists to repair (the ones with an
 * OPEN gap), because the first thing it demands is the value nobody has. The
 * client omits a field only when the operator left it byte-identical to a
 * stored value that already fails the gate — see adminProfileFormSchema.
 *
 * `.strict()` is load-bearing, not tidiness: it is what makes a payload
 * carrying `email`, `userID`, `roles` or `role` a LOUD 400 instead of a
 * silently-stripped key. zod's default strip would make a future widening of
 * this schema the only thing standing between a client and a role write; a
 * throwing schema makes the attempt visible in the logs today.
 *
 * Every validator is IMPORTED from ~/lib/schemas/profile rather than restated,
 * so the admin path cannot drift from the resident path — that is why those
 * validators live in src/lib and not under src/server.
 */
const updateSchema = z
  .object({
    userObjectId: objectIdSchema,

    // min(1) where updateProfileInput has none. `sanitizeName` still strips
    // controls / zero-width / bidi-override codepoints — displayName is
    // rendered to OTHER users on every booking listing, so an unfiltered value
    // is an impersonation primitive, not a display bug. A name that sanitizes
    // down to nothing is caught by isDisplayNameValid in the mutation.
    displayName: z
      .string()
      .min(1)
      .max(DISPLAY_NAME_MAX)
      .transform(sanitizeName)
      .optional(),

    // The one clearable field: "" routes through `clearable` (D-5). Bio is not
    // a gate field, so emptying it cannot lock anyone out.
    //
    // `.optional()` like the rest, and for the SAME reason they are: omitted
    // means "leave the stored value alone". Sending it unconditionally is how
    // an operator who came to change a block silently reverted a bio the
    // resident had edited in the meantime — see the note on the audit diff.
    bio: z
      .string()
      .trim()
      .max(BIO_MAX, `Bio must be ${BIO_MAX} characters or fewer`)
      .optional(),

    // Stored WITHOUT the leading "@" — one canonical form, the UI renders the
    // "@". NOTE the missing `v === "" ||` escape hatch that updateProfileInput
    // carries: that is the whole difference, and it is the gate-field rule.
    telegramHandle: z
      .string()
      .trim()
      .transform((v) => v.replace(/^@+/, ""))
      .refine((v) => TELEGRAM_RE.test(v), {
        message:
          "Telegram handle must be 5–32 characters: letters, digits or _",
      })
      .optional(),

    // BLOCKS is 2..8, a SUBSET of the DB validator's declared int 1..8 range,
    // so a value that passes here conforms to the collection validator as well.
    // That matters more than usual: the User validator runs with
    // validationAction "warn", so a non-conforming write is ACCEPTED SILENTLY
    // and only logged. Zod is the real gate; the database is not a safety net.
    block: z
      .number()
      .int()
      .refine((n) => (BLOCKS as readonly number[]).includes(n), "Invalid block")
      .optional(),

    // Optional because a non-NUS account has no canonical key to store a matric
    // under, and because the dialog omits it when unchanged. `undefined` means
    // "leave the UserMatric row alone"; there is no value that means "clear it",
    // deliberately — matric is a gate field.
    matric: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => MATRIC_RE.test(v), {
        message:
          "Matric must be in the format A0234567X (A + 7 digits + a letter).",
      })
      .optional(),

    /**
     * POST-MERGE CONFIRMATION, and the ONLY thing on this payload that is not a
     * value to store.
     *
     * `merge-by-canonical.mjs` writes `ProfileCompletion.needsFields` when the
     * two merged rows DISAGREED on a value, so an entry means "a stored value
     * exists and NOBODY KNOWS WHETHER IT IS THIS PERSON'S — ask". Filling the
     * field answers it; so does an operator who checked the stored value against
     * a real source and says it is right. NOTHING ELSE DOES, which is why this
     * key exists rather than the server inferring confirmation from the fact
     * that a save happened — see WALL 2 in the mutation for what that inference
     * cost.
     *
     * Names are validated against `REQUIRED_PROFILE_FIELDS` rather than a
     * restated literal union, so widening the gate vocabulary widens this
     * automatically and the two cannot drift. An unknown name is a LOUD 400 (the
     * `.strict()` posture applied one level down) — a silently-dropped
     * confirmation would leave the resident prompted with the operator believing
     * otherwise, which is the direction that strands people.
     */
    confirmFields: z
      .array(
        z
          .string()
          .refine((f): f is ProfileField =>
            (REQUIRED_PROFILE_FIELDS as readonly string[]).includes(f),
          ),
      )
      .max(REQUIRED_PROFILE_FIELDS.length)
      .optional(),

    reason: z.string().trim().max(REASON_MAX).optional(),
  })
  .strict();

/* ========================================================================== */
/* Audit reason helpers                                                       */
/* ========================================================================== */

/**
 * The audit row is the ONLY surviving record of what an edit changed — there is
 * no before-image anywhere else — so the diff is built from the values read
 * before the write, not from what the client claimed. Truncated because
 * `reason` is prose, not a payload.
 */
const truncate = (s: string): string =>
  s.length <= REASON_MAX ? s : `${s.slice(0, REASON_MAX - 1)}…`;

const shown = (v: string | number | null | undefined): string =>
  v === null || v === undefined || v === "" ? "—" : String(v);

function diffLine(
  label: string,
  before: string | number | null | undefined,
  after: string | number | null | undefined,
): string | null {
  // Normalised through `shown` so null / undefined / "" compare equal: a Google
  // row with an absent telegramHandle and one with "" are the same state, and
  // reporting a change between them would be noise on the audit surface.
  const a = shown(before);
  const b = shown(after);
  return a === b ? null : `${label}: ${a} → ${b}`;
}

/* ========================================================================== */
/* The router                                                                 */
/* ========================================================================== */

export const userAdminRouter = createTRPCRouter({
  /**
   * The authoritative detail record for one account.
   *
   * Not served from the listUsers projection: that row has no matric, no
   * telegramHandle and no bio, and its `roles` are REDACTED for a jcrc (D-2).
   * The dialog needs the real record, so it asks for it.
   *
   * AUDITED (`user.detail.read`), which is unusual for a read and is exactly
   * because of the sentence above — see the block on the writeAudit call.
   */
  get: roleManagerProcedure
    .input(targetSchema)
    .query(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      // I-5: the ACTOR's roles are re-read from the database on every call, never
      // taken from the session JWT. A JWT minted before a revocation still claims
      // the revoked role until it refreshes.
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      const c = caps(actorRoles);
      requireCapability(c, "manageUserProfiles");

      const target = await loadAdminUserTarget(ctx.db, input.userObjectId);

      /* ---- G3 ON THE READ TOO, and why it is worth the oracle --------------
       * This record is NOT the listUsers row with a couple of extras: it carries
       * matric, telegramHandle, bio and the profile gaps, none of which is in
       * that projection. An unguarded read therefore hands any jcrc an ADMIN's
       * matriculation number and Telegram handle — a bigger disclosure than the
       * admin-enumeration this guard's own denial pattern creates, and one that
       * redaction cannot close (blanking exactly those fields for admin targets
       * is the same oracle one field over). The full argument, including what
       * was given up, is on assertMayManageUserProfileOf.
       *
       * D-2's `admin` redaction below still applies on top: it is what keeps a
       * manager reading a NON-admin's record from learning who holds admin.
       */
      await assertMayManageUserProfileOf(
        ctx.db,
        actorUserID,
        actorRoles,
        target,
        writeAudit,
      );

      const cid = target.canonicalUserID;

      /* ---- THE READ IS AUDITED, and it is the only read in AUDIT_ACTIONS ----
       * `explainAccess` set the precedent and the reasoning is identical, only
       * stronger here: it audits a read "because it is an enumeration primitive
       * over the whole user base", and it returns strictly LESS than this one
       * does (a decision plus a role list). This procedure returns matric,
       * telegramHandle, bio and block, NONE of which is in the `listUsers`
       * projection — and `listUsers` hands every jcrc the `id` of all ~1382
       * accounts, so a loop over those ids is a complete export of the hall's
       * matriculation numbers and contact handles by a student-held role.
       *
       * WITHOUT THIS ROW THAT EXPORT IS INVISIBLE. The target guard above audits
       * DENIALS only — a target holding `admin`, or an unkeyed account — so
       * every successful read of a non-admin returns 200 and writes nothing, and
       * /admin/audit shows no row at all. An admin investigating a leak could
       * not establish which manager did it, nor that a bulk read had happened.
       * The same PII leaving in bulk is audited by design on the other surface
       * that emits it (`event.attendees.export`).
       *
       * WRITTEN BEFORE THE PAYLOAD IS ASSEMBLED, deliberately: a row for a read
       * that then faulted is noise, a disclosure with no row is the failure this
       * exists to prevent, and only one of those two errors is recoverable.
       * `writeAudit` swallows its own failures (it logs structurally), so this
       * cannot turn an audit outage into a broken dialog.
       *
       * A LIMITER IS NOT A SUBSTITUTE and is deliberately not added alongside.
       * `previewBulkImport`'s `rateLimit` bounds a harvest; it does not make one
       * ATTRIBUTABLE, which is the question an audit surface is asked. If the
       * row-per-dialog-open volume ever becomes a problem, cap `listAuditLog`'s
       * default view — do not drop the row.
       *
       * `?? undefined`, NEVER `?? ""` — the sentinel rule (see writeAudit's
       * note in updateProfile). For a non-NUS row the email is the only
       * identification the row can carry, so it is always in `reason`.
       */
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: cid ?? undefined,
        action: "user.detail.read",
        reason: truncate(`user detail: ${target.email}`),
      });

      // All four reads are skipped entirely when there is no canonical id.
      // Neither `findUnique({ where: { userID: null } })` (a type error) nor
      // `{ userID: "" }` (a stranger's row) is an acceptable stand-in — that is
      // the sentinel bug class, an ABSENT identity spent as a real one. An
      // account with no canonical id holds no canonical-keyed rows by
      // construction, so [] / null is both the safe answer and the true one
      // (the C9 reasoning in listUsers).
      const [matricRow, roles, completionRow, collisions, headRows] = cid
        ? await Promise.all([
            ctx.db.userMatric.findUnique({ where: { userID: cid } }),
            getUserRoles(ctx.db, cid),
            ctx.db.profileCompletion.findUnique({ where: { userID: cid } }),
            // The SAME check computeDeleteRefusals runs, on the read, because
            // the fields below are read under TWO different keys and the
            // operator cannot see that from the form: email / displayName /
            // block / telegramHandle / bio come off THIS `_id`, while matric and
            // the completion row come off the canonical id — which a second
            // whitespace-variant User row can share (66 such sets on
            // 2026-07-19). On a colliding row the matric shown belongs to the
            // OTHER account, so the dialog must say so before anyone types over
            // it. See findCanonicalIdCollisions.
            findCanonicalIdCollisions(ctx.db, cid, target.userObjectId),
            /* WHICH CCAs THIS ACCOUNT HEADS. Read from CcaHead DIRECTLY and
             * NEVER from roles.includes(CCA_HEAD_ROLE) — the same rule
             * assertHeadsCca is built on. That string is scope-free by
             * construction, so it answers "heads something", never "heads
             * this", and rendering the scopes from it is not possible.
             *
             * Reading the rows rather than the string also makes the dialog a
             * CH-1 drift detector for free: the invariant is "holds the
             * cca_head string IFF >= 1 CcaHead row", MongoDB cannot enforce it,
             * and the two halves are now visible side by side in one panel.
             */
            ctx.db.ccaHead.findMany({
              where: { userID: cid },
              select: { ccaID: true, grantedAt: true },
              orderBy: { ccaID: "asc" },
            }),
          ])
        : [null, [] as string[], null, [], []];

      const matric = matricRow?.matric ?? null;

      /* Names for the headships above. A SECOND round trip because it depends
       * on the first — but only when there are rows, so the overwhelmingly
       * common case (an ordinary resident) still costs nothing. A CCA row that
       * has since been deleted resolves to null and is rendered as the bare
       * ccaID rather than dropped: a headship pointing at a CCA that no longer
       * exists is exactly the kind of thing this panel should show.
       */
      const headCcas =
        headRows.length === 0
          ? []
          : await ctx.db.cCA.findMany({
              where: { ccaID: { in: headRows.map((h) => h.ccaID) } },
              select: { ccaID: true, ccaName: true, category: true },
            });
      const headNameByID = new Map(headCcas.map((c) => [c.ccaID, c]));

      return {
        userObjectId: target.userObjectId,
        // READ-ONLY on every surface that consumes this. The dialog renders it in
        // a locked panel; there is no procedure here that accepts it back.
        email: target.email,
        canonicalUserID: cid,
        /** The STORED legacy column — display and mismatch detection only. */
        legacyUserID: target.legacyUserID,
        /**
         * AN ALLOWLIST-PINNED STAFF ACCOUNT (the hall office / `scrc` tier).
         *
         * admin.listUsers already returns this and the table uses it; `get` did
         * not, and the dialog was WRONG for exactly these accounts as a result.
         * Their key comes from an AuthAllowlist pin, not from an address, so
         * without this flag the panel labelled `EXT:VINCENT_KOH` as a "NUSNET
         * id" and told the operator their identity "is derived from the part of
         * the address before @u.nus.edu" — neither of which is true of a staff
         * address. Computed the SAME way listUsers computes it, so the two
         * surfaces cannot disagree about which accounts are pinned.
         */
        pinned: cid !== null && isExtUserID(cid),
        /** admin.listUsers' own flag, computed the same way, so the two agree. */
        keyMismatch: Boolean(
          target.legacyUserID && target.legacyUserID !== (cid as string | null),
        ),
        displayName: target.displayName,
        telegramHandle: target.telegramHandle,
        bio: target.bio,
        block: target.block,
        matric,
        hasMatric: Boolean(matric),
        /**
         * ANOTHER live `User` row canonicalises to the same NUSNET id, so the
         * canonical-keyed half of this record (matric, and the post-merge
         * completion row) is SHARED with an account the operator did not open.
         * The dialog refuses the matric input on this and says why; the router
         * refuses the write regardless (a disabled control is cosmetic).
         * Row-local fields stay editable — they are keyed on `_id` and reach
         * only the account that was clicked.
         */
        sharedCanonicalID: collisions.length > 0,
        /**
         * The CCAs this account HEADS, from its CcaHead rows — scope the
         * `cca_head` role string cannot carry.
         *
         * DISPLAY ONLY, like `roles`, and NOT redacted: headship is already
         * public (every CCA page lists its heads via cca.listHeads), so there
         * is nothing here a manager could not read from /ccas. That is why this
         * field does not need the `seeAdminIdentities` treatment the role list
         * gets — no admin-enumeration oracle exists in a list of CCA names.
         *
         * EMPTY does not mean "not a head" on its own: an account with no
         * canonical id is skipped entirely above, the same as its matric and
         * roles. Read it alongside the role badges, which is how the panel
         * renders it.
         */
        headOf: headRows.map((h) => ({
          ccaID: h.ccaID,
          ccaName: headNameByID.get(h.ccaID)?.ccaName ?? null,
          category: headNameByID.get(h.ccaID)?.category ?? null,
          grantedAt: h.grantedAt,
        })),
        /**
         * DISPLAY ONLY (I-5). Nothing here authorises anything on the client.
         *
         * REDACTED exactly as admin.listUsers redacts, and by the same rule, so
         * the two surfaces agree: without `seeAdminIdentities` the `admin`
         * string is stripped. This is what lets the read succeed for every
         * manager without the procedure becoming an admin oracle — see the note
         * above the target guard.
         */
        roles: (c.seeAdminIdentities
          ? roles
          : roles.filter((r) => r !== ADMIN_ROLE)) as string[],
        /**
         * WALL 1 — the strict profile gate. What is currently walling this
         * resident behind /profile. Computed with the SAME function the session
         * callback gates on, so the admin sees exactly the gaps the user is
         * being held on — not a second opinion that could disagree with the
         * gate.
         */
        profileGaps: computeProfileGaps(
          {
            displayName: target.displayName,
            telegramHandle: target.telegramHandle,
            block: target.block,
            matric,
          },
          /* THE TARGET'S ROLES, NOT THE ACTOR'S. computeProfileGaps is
           * role-aware (a hall-office account is exempt from block / telegram /
           * matric — see MINIMAL_PROFILE_ROLES), and the question this field
           * answers is "what is walling THIS user", so the roles that decide it
           * are theirs. Passing `actorRoles` here would report the operator's
           * exemption against someone else's profile.
           *
           * `roles` is the UNREDACTED set read at :418 — the `admin`-stripped
           * copy below is for DISPLAY only, and filtering it before this call
           * would make the answer depend on who is looking.
           *
           * Already in scope and already read, so this costs no extra query. If
           * the roles could not be read (no canonical id) it is `[]`, which is
           * never exempt — the strict set, i.e. over-prompt, never over-admit.
           */
          roles,
        ),
        /**
         * WALL 2 — the post-merge completion flag, and a SEPARATE one.
         * MatricGate checks `needsProfileCompletion` (this row) BEFORE
         * `profileIncomplete` (profileGaps above) and routes to
         * /onboarding/complete-profile, so a resident with an outstanding row is
         * still walled even when every gap above is closed. Reported here
         * because an operator who cannot see this wall will fill the form,
         * watch the amber panel clear, and conclude they fixed something they
         * did not — which is how the 18 residents in
         * scripts/remediation/unstick-profile-completion.mjs got stranded.
         *
         * A row whose `resolvedAt` is set is history, not a live prompt, and
         * reads as [] — the same rule the session callback applies.
         */
        profileNeedsFields:
          completionRow && completionRow.resolvedAt == null
            ? completionRow.needsFields
            : [],
      };
    }),

  /**
   * Edit someone else's profile fields.
   *
   * WHAT THIS CAN AND CANNOT REACH: displayName, block, telegramHandle, bio and
   * the UserMatric row. Not email (immutable — see the file header), not
   * User.userID (the legacy column; rewriting it is the split-identity defect
   * itself), not roles (admin.setUserRoles owns them), not passwordHash.
   */
  updateProfile: roleManagerProcedure
    .input(updateSchema)
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireCapability(caps(actorRoles), "manageUserProfiles");

      const target = await loadAdminUserTarget(ctx.db, input.userObjectId);
      await assertMayManageUserProfileOf(
        ctx.db,
        actorUserID,
        actorRoles,
        target,
        writeAudit,
      );

      // The same rule user.updateUserData applies on EVERY save, for the same
      // reason: otherwise a name can be "fixed" back to a NUSNET id and the
      // gate loops forever. Asserted after `sanitizeName` has run, so a name
      // made entirely of zero-width characters is caught here as too short.
      // Same message as the self-service path — one rule, one wording.
      //
      // Only when a name was SUBMITTED. An omitted displayName leaves whatever
      // is stored — including a still-invalid one — exactly as it was, which is
      // the "never open one, never widen one" half of the rule; rejecting the
      // whole save because of a field nobody touched is what made partial
      // repair impossible.
      if (
        input.displayName !== undefined &&
        !isDisplayNameValid(input.displayName)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Enter your real name — not your NUSNET ID.",
        });
      }

      const cid = target.canonicalUserID;

      /* ---- IS THE CANONICAL KEY EXCLUSIVE TO THIS ROW? ---------------------
       * THIS SAVE WRITES UNDER TWO DIFFERENT KEYS and only one of them is the
       * row the operator clicked:
       *   - displayName / block / telegramHandle / bio -> `User._id`
       *   - the UserMatric row and the ProfileCompletion row -> the CANONICAL id
       * `email_unique_ci` folds case but not WHITESPACE, so
       * "e0425010@u.nus.edu " and "e0425010@u.nus.edu" are two User rows and ONE
       * canonical id — the 2026-07-19 census counted 66 such sets, and
       * `computeDeleteRefusals` already refuses a DELETE on exactly this state
       * (SHARED_CANONICAL_ID) because the key must be EXCLUSIVE, not merely
       * complete. The same proof is required here and was missing.
       *
       * Without it, an operator opening the whitespace variant sees the LIVE
       * account's matric (read under the shared key), corrects it, and
       * overwrites the live account's UserMatric row — while the profile fields
       * they typed land on the shadow row. The two halves of one "save" go to
       * two different humans, the dialog says "Saved.", and the audit row can
       * only name the shared canonical id, so it cannot even say which row was
       * edited. `assertMatricUnclaimed` does not catch it (it excludes
       * `userID: cid`, which IS the shared key) and LEGACY_KEY_MISMATCH does not
       * either (on these rows `User.userID` is null or already equal to cid).
       *
       * ROW-LOCAL FIELDS ARE STILL WRITTEN. They are keyed on `_id` and reach
       * only the account that was opened, and refusing them would leave the
       * junk half of a duplicate pair uneditable for no safety gain. It is the
       * CANONICAL-keyed half that is refused, and only that half.
       */
      const sharedCanonicalID =
        cid !== null &&
        (await findCanonicalIdCollisions(ctx.db, cid, target.userObjectId))
          .length > 0;

      if (sharedCanonicalID && input.matric !== undefined) {
        // Audited as a denial, the shape `delete` uses for its refusal set: this
        // is a safety refusal on a privileged surface, not a field-validation
        // error, and repeated attempts on a duplicate pair are worth seeing.
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: cid ?? undefined,
          action: "denied",
          ok: false,
          denyReason: "SHARED_CANONICAL_ID",
          reason: truncate(`user profile matric: ${target.email}`),
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "SHARED_CANONICAL_ID",
        });
      }

      /* ---- matric FIRST, and why ------------------------------------------
       * UserMatric is a different collection from User, so these two writes are
       * not atomic with each other. Matric goes first ON PURPOSE: the only
       * failure expected in normal operation is the matric CONFLICT (someone
       * else already holds that number), and running it first means that
       * expected failure leaves NOTHING written at all. The reverse order would
       * save the profile and then reject, which reads to the operator as "it
       * didn't save" while half of it did.
       *
       * The residue in the other direction (matric written, User.update then
       * fails) is benign and self-repairing: re-submitting the same form
       * re-applies both, and the matric that landed is the one the gate most
       * often needs. A $transaction across the two would buy atomicity for a
       * pair of independent, idempotent, re-appliable writes — not worth the
       * interactive transaction.
       */
      let matricBefore: string | null = null;
      if (input.matric !== undefined) {
        // UserMatric is CANONICAL-KEYED. There is no key to write under for a
        // non-NUS account, and "" is not a key — it is the absent identity, and
        // spending it here would attach this matric to a ""-keyed row that any
        // other identity-less account would then read back as its own.
        if (cid === null) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "NO_CANONICAL_IDENTITY",
          });
        }

        matricBefore =
          (await ctx.db.userMatric.findUnique({ where: { userID: cid } }))
            ?.matric ?? null;

        // An admin writing on someone's behalf must not be the SOFTER door: the
        // same duplicate check the resident's own path runs, and then THE
        // matric writer from services/profile.ts. Never a local upsert here —
        // a second upsert is a second chance to key a matric on the Mongo _id
        // instead of the canonical userID, which is the mis-keying that
        // produced the duplicate rows the remediation scripts clean up after.
        await assertMatricUnclaimed(ctx.db, cid, input.matric);
        await writeMatric(ctx.db, cid, input.matric);
      }

      /* ---- the User write, and why it is wrapped ---------------------------
       * If the matric landed and THIS throws (the row deleted underneath us by
       * a concurrent userAdmin.delete — Prisma P2025 — or a transient Atlas
       * fault), the mutation rejects with no audit row, leaving a CHANGED
       * matric on a live account and nothing on the audit surface naming who
       * changed it. An unaudited admin mutation is a bug outright, so the
       * partial write is recorded before the error is re-thrown — the same
       * shape the delete's own failure path uses (I-15: written on ctx.db,
       * after the failure, never inside a transaction the throw would roll
       * back).
       *
       * SKIPPED ENTIRELY WHEN NO ROW-LOCAL FIELD WAS SUBMITTED, and that is not
       * an optimisation. Since the dialog sends only what changed, "open the
       * record, tick `matric` as confirmed, Save" — the flow that clears a
       * post-merge `needsFields: ["matric"]` — reaches here with every one of
       * these four undefined and only `confirmFields` populated. Prisma would
       * then build an update document with no operators and Mongo rejects an
       * empty one, so the mutation would fail on exactly the case WALL 2 below
       * exists to serve. The pre-image stands in as the "after" state: nothing
       * was asked for, so nothing changed, and the diff below correctly reports
       * no field changed.
       */
      let updated: {
        id: string;
        displayName: string | null;
        telegramHandle: string | null;
        bio: string | null;
        block: number | null;
      };
      const rowLocalSubmitted =
        input.displayName !== undefined ||
        input.telegramHandle !== undefined ||
        input.bio !== undefined ||
        input.block !== undefined;
      const preImage = {
        id: target.userObjectId,
        displayName: target.displayName,
        telegramHandle: target.telegramHandle,
        bio: target.bio,
        block: target.block,
      };
      try {
        updated = rowLocalSubmitted
          ? await ctx.db.user.update({
              where: { id: input.userObjectId }, // by _id (I-1), never by userID
              data: {
                // `undefined` is Prisma's "leave this field alone" — the exact
                // semantics the optional schema promises, with no branch to get
                // wrong. It is NOT the same as null (which would clear it).
                displayName: input.displayName,
                // "" clears. Routed through the ONE D-5 helper in
                // services/profile.ts so the $unset-vs-null branch stays a
                // one-line flip in one file. `undefined` is checked BEFORE
                // `clearable`, which cannot see the difference: it maps "" to
                // the clear operation, and an omitted bio must leave the stored
                // one alone rather than erase it.
                bio: input.bio === undefined ? undefined : clearable(input.bio),
                // NOT clearable: "" cannot reach here (the schema refuses it),
                // and a blank handle is a gate field the resident cannot
                // restore.
                telegramHandle: input.telegramHandle,
                // Written through Prisma's Int mapping, byte-identical to what
                // user.updateUserData and src/app/api/register/route.ts already
                // produce. This matters: the User collection's $jsonSchema
                // declares block as bsonType "int" with validationAction "warn",
                // so a write of the wrong BSON type is ACCEPTED SILENTLY and
                // only logged — the database will not catch a mistake here.
                // Matching the existing writer exactly is the only way this path
                // cannot produce a document shape the app does not already
                // produce. (Counter-evidence that this is not theoretical:
                // services/ccaMembers.ts had to drop to a raw insert because
                // Prisma's Mongo connector sent an Int as a 64-bit long and
                // UserCCA's int32 validator rejected it with code 121 — there
                // the validator was "error", here it is "warn".)
                // scripts/remediation/verify-user-admin-safety.mjs reports the
                // observed $type distribution of this field, read-only.
                block: input.block,
              },
              // Mirrors the read path's select. #9: passwordHash must never
              // reach the client or the React Query cache. I-2: Prisma 6 throws
              // deserializing a Google-adapter row that lacks it. userID and
              // email are deliberately absent — this result is merged into the
              // cached record client-side and User.userID holds an A-format
              // matric on ~515 rows, so returning it would clobber the derived
              // canonical id (I-1).
              select: {
                id: true,
                displayName: true,
                telegramHandle: true,
                bio: true,
                block: true,
              },
            })
          : preImage;
      } catch (err) {
        if (input.matric !== undefined && matricBefore !== input.matric) {
          await writeAudit(ctx.db, {
            actorUserID,
            actorRoles,
            targetUserID: cid ?? undefined,
            action: "user.profile.update",
            reason: truncate(
              [
                target.email,
                diffLine("matric", matricBefore, input.matric),
                "profile write FAILED after the matric was written",
                input.reason ? `— ${input.reason}` : "",
              ]
                .filter(Boolean)
                .join(" | "),
            ),
          });
        }
        throw err;
      }

      /* ---- NO optimistic-concurrency check, and what stands in for it ------
       * applyRoleChange does a compare-and-set on the pre-image because a
       * concurrent role write can silently undo a revocation — losing a write
       * there means a privilege survives that someone believed they removed.
       * Nothing on this document carries privilege, and a compare-and-set here
       * would fail loudly on the common case of two people fixing the same
       * onboarding record.
       *
       * WHAT MAKES THAT SAFE IS THE OMISSION RULE, NOT last-write-wins. "The
       * second operator's value stands" is only a reasonable outcome for a field
       * the second operator actually typed. The client sends a field ONLY when
       * it differs from what it loaded (UserDetailDialog's dirty check), and
       * `undefined` here means "leave the stored value alone" — so a save that
       * changed one Block cannot carry a stale telegramHandle back over the
       * resident's own newer edit. If a future caller starts sending the whole
       * record again, that reversal comes back and the audit diff is the only
       * place it would ever show up.
       */

      // The diff is built from the pre-image loaded at the top of this
      // procedure, so the row records what actually changed rather than what
      // was submitted. Field-level, because "profile updated" on the audit
      // surface answers none of the questions an audit surface is asked.
      const changes = [
        diffLine("displayName", target.displayName, updated.displayName),
        diffLine("block", target.block, updated.block),
        diffLine(
          "telegramHandle",
          target.telegramHandle,
          updated.telegramHandle,
        ),
        diffLine("bio", target.bio, updated.bio),
        input.matric !== undefined
          ? diffLine("matric", matricBefore, input.matric)
          : null,
        // RECORDED EVEN THOUGH IT CHANGES NO FIELD. A tick can take down WALL 2
        // on a save whose diff is empty, and "no field changed | [matric] →
        // resolved" would leave the audit surface unable to say who vouched for
        // the number or that anyone did. Named here, so the row states the act
        // rather than only its effect.
        input.confirmFields?.length
          ? `confirmed: ${input.confirmFields.join(",")}`
          : null,
      ].filter((l): l is string => l !== null);

      /* ---- WALL 2: clear what this edit just satisfied ---------------------
       * THERE ARE TWO INDEPENDENT WALLS and writing the User row only takes
       * down one of them. MatricGate checks `needsProfileCompletion` (an
       * unresolved ProfileCompletion row) BEFORE the strict gate's
       * `profileIncomplete`, and routes to /onboarding/complete-profile. So
       * without this block an operator could fill every gap, watch the amber
       * panel clear, and leave the resident redirected on every request — with
       * `getProfileCompletion` filtering displayName/block out of its
       * vocabulary and rendering a form with NO inputs and "Nothing to save."
       * on submit. That is the exact trap
       * scripts/remediation/unstick-profile-completion.mjs was written to
       * release 18 residents from; this feature must not re-create it one
       * resident at a time.
       *
       * AN ENTRY IS CLEARED ONLY WHEN THIS SAVE BOTH FILLED THE FIELD AND SPOKE
       * TO IT. Two conditions, and BOTH are load-bearing:
       *
       *   1. `computeProfileGaps` — the SAME function WALL 1 and the session
       *      callback gate on — reports no gap for it in the state AFTER this
       *      write. This is what stops the two walls disagreeing about whether a
       *      field is filled: resolving an entry whose value is still empty
       *      takes down the prompt and leaves WALL 1 holding the resident.
       *   2. THE OPERATOR SUPPLIED IT (`input.X !== undefined`) OR TICKED ITS
       *      CONFIRM BOX (`input.confirmFields`).
       *
       * CONDITION 2 IS THE ONE THAT IS EASY TO ARGUE AWAY, so here is what
       * happens without it. This block ran on the resulting state ALONE for
       * exactly that reason — "an admin save is the confirmation" — and it is
       * wrong about what these entries MEAN. merge-by-canonical writes
       * `needsFields: ["matric"]` when two merged rows DISAGREED on a matric: a
       * UserMatric row already exists, it is one of the two candidates, and the
       * open question is WHICH. Condition 1 alone is satisfied by that row's mere
       * existence. So a JCRC who opened the record to correct a Block — or who
       * opened it, typed nothing and clicked Save, which reaches here with every
       * row-local field undefined — silently stamped `resolvedAt`, the resident
       * was never asked again, and the wrong number became permanent on the field
       * `assertMatricUnclaimed`'s own comment calls an impersonation primitive
       * because the bulk import resolves identities on it. The audit row read
       * `no field changed | profileCompletion: [matric] → resolved`: a wall came
       * down on a save that changed nothing.
       *
       * "Confirm an unchanged matric" still works, and now it is an ACT rather
       * than a side effect — the dialog renders a tick box per flagged field and
       * says so. That also makes the resident's path and this one consistent
       * rather than merely similar: `user.completeProfile` resolves `matric` on a
       * re-submitted identical value because the RESIDENT re-submitted it, which
       * is an answer to the question; an admin's Save is not, unless they say it
       * is.
       *
       * PRESERVE ANY NAME OUTSIDE THE VOCABULARY (a value a future deploy
       * understands must survive one that does not), and stamp `resolvedAt` only
       * once the list truly empties — a partial save must leave the row live and
       * the resident still prompted for the rest. That is user.completeProfile's
       * rule, unchanged.
       *
       * SKIPPED ENTIRELY ON A SHARED CANONICAL ID. The row is keyed on the
       * canonical id, so on a whitespace-variant pair it is the OTHER, live
       * account's post-merge prompt — resolving it from values typed against
       * this row is how the one wall that was pointing at the real problem gets
       * silently cleared. Named on the audit row so the operator's save is not
       * recorded as having done something it refused to do.
       */
      /* THE WHOLE STEP IS WRAPPED, for the same reason the User write above is,
       * and it must NOT re-throw. It runs AFTER that write has landed and BEFORE
       * the audit row, so an unhandled fault here — a P2025 from the row being
       * removed underneath us by unstick-profile-completion.mjs or by a
       * concurrent userAdmin.delete (which deletes ProfileCompletion in its step
       * 5), or a transient Atlas error on any of the three queries — would
       * reject the mutation with the profile change already persisted and
       * NOTHING on the audit surface naming who made it. An unaudited admin
       * mutation is a bug outright.
       *
       * Re-throwing after auditing (what the User write does) is wrong HERE:
       * there the operator's main action failed, so a retry is the right advice;
       * here it succeeded, and telling them "that didn't save" would have them
       * re-apply a save that already landed. So the failure is recorded on the
       * audit row and the mutation reports success for what actually succeeded.
       * The resident simply stays prompted — over-prompt, never lock out, the
       * same degrade direction the session callback takes.
       */
      let completionLine: string | null = null;
      if (cid !== null) {
        try {
          const row = await ctx.db.profileCompletion.findUnique({
            where: { userID: cid },
          });
          // A row whose `resolvedAt` is set is history, not a live prompt — the
          // same rule the session callback and `get` apply.
          const live =
            row && row.resolvedAt == null && row.needsFields.length > 0
              ? row
              : null;

          if (live && sharedCanonicalID) {
            // Read, reported, NOT written. See the note above.
            completionLine = `profileCompletion [${live.needsFields.join(
              ",",
            )}] NOT cleared — another account shares this NUSNET id`;
          } else if (live) {
            // The stored matric AFTER this write. Re-read only when the row is
            // actually waiting on one and this save did not supply it — the
            // common case costs no extra query.
            const matricNow =
              input.matric ??
              (live.needsFields.includes("matric")
                ? ((
                    await ctx.db.userMatric.findUnique({
                      where: { userID: cid },
                    })
                  )?.matric ?? null)
                : null);

            /* THE TARGET'S ROLES — see WALL 1's note. computeProfileGaps is
             * role-aware, and the comment on condition 1 above requires this to
             * be "the SAME function WALL 1 and the session callback gate on".
             * SAME FUNCTION IS NOT ENOUGH IF IT IS FED A DIFFERENT ARGUMENT: an
             * exempt account would report no gaps at WALL 1 and at the gate, but
             * gaps here, so this block would refuse to resolve entries that
             * nothing will ever fill — the resident-stranding trap
             * unstick-profile-completion.mjs was written to release 18 people
             * from, re-created one account at a time.
             *
             * Read here rather than beside `cid` so the query is issued ONLY on
             * the rare path that has a live ProfileCompletion row to judge; the
             * common save costs nothing. `cid` is non-null throughout this block
             * (the `if (cid !== null)` above), so there is no absent identity
             * being spent as a real one. A fault on this read is caught by the
             * wrapper below exactly like the three queries beside it: the
             * completion row is left LIVE and reported on the audit line, so the
             * degrade direction is still over-prompt, never a wall taken down on
             * a guess.
             */
            const targetRoles = await getUserRoles(ctx.db, cid);

            const stillGapped = new Set<string>(
              computeProfileGaps(
                {
                  displayName: updated.displayName,
                  telegramHandle: updated.telegramHandle,
                  block: updated.block,
                  matric: matricNow,
                },
                targetRoles,
              ),
            );
            // Anything the gate vocabulary does not name is KEPT: this deploy
            // cannot judge a field it does not understand.
            const known = new Set<string>(REQUIRED_PROFILE_FIELDS);

            /* WHAT THIS SAVE SPOKE TO — condition 2 above. A field is answered
             * by a value the operator SUPPLIED, or by an explicit tick against
             * the flagged entry. Nothing else counts, and in particular the mere
             * fact that a save happened does not: `needsFields` asks "is the
             * stored value this person's", and only an operator can answer it.
             *
             * Built from `input`, NOT from the diff: an operator who retypes the
             * value that is already stored has still confirmed it, and a diff
             * would report no change and drop the confirmation on the floor.
             */
            const acted = new Set<string>(input.confirmFields ?? []);
            if (input.displayName !== undefined) acted.add("displayName");
            if (input.telegramHandle !== undefined) acted.add("telegramHandle");
            if (input.block !== undefined) acted.add("block");
            if (input.matric !== undefined) acted.add("matric");

            const remaining = live.needsFields.filter(
              (f) => stillGapped.has(f) || !known.has(f) || !acted.has(f),
            );
            if (remaining.length !== live.needsFields.length) {
              await ctx.db.profileCompletion.update({
                where: { userID: cid },
                data: {
                  needsFields: remaining,
                  ...(remaining.length === 0 ? { resolvedAt: new Date() } : {}),
                },
              });
              completionLine = `profileCompletion: [${live.needsFields.join(",")}] → ${
                remaining.length === 0 ? "resolved" : `[${remaining.join(",")}]`
              }`;
            }
          }
        } catch {
          completionLine = "profileCompletion step FAILED — row left unchanged";
        }
      }

      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        // `?? undefined`, NEVER `?? ""`. writeAudit stores undefined as a
        // literal null; "" would be an absent identity recorded as a real one,
        // and every later filter on targetUserID would match it (the sentinel
        // rule). For a non-NUS account the email in `reason` is the only
        // identification the row can carry, which is why it is always included.
        targetUserID: cid ?? undefined,
        action: "user.profile.update",
        // No rolesBefore / rolesAfter: no role changed. Leaving them empty is
        // the true statement; filling them with the current set would make the
        // audit surface read as though this endpoint touched roles.
        reason: truncate(
          [
            target.email,
            changes.length ? changes.join("; ") : "no field changed",
            completionLine,
            input.reason ? `— ${input.reason}` : "",
          ]
            .filter(Boolean)
            .join(" | "),
        ),
      });

      // `matricWritten`, NOT `matric`: it is null when the field was not
      // submitted, which is NOT the same statement as "this account has no
      // matric". A field named `matric` returning null on an unrelated save
      // would be merged into the cached record and blank a matric that is
      // still there. The dialog invalidates `userAdmin.get` for the truth.
      return { ...updated, matricWritten: input.matric ?? null };
    }),

  /**
   * PREFLIGHT for the delete: what it would destroy, and every reason it would
   * refuse — as DATA.
   *
   * WRITES NO AUDIT ROW. A preview is not an attempt; emitting denial rows for
   * a hypothetical is the inverse of I-15 and is the reason `DryRunDenied`
   * exists on the bulk path. `computeDeleteRefusals` is the SAME implementation
   * the mutation runs, shared rather than mirrored — two copies of a refusal
   * list is how the preview starts saying yes to something the mutation
   * refuses.
   *
   * Gated on `deleteUsers` (admin only) rather than `manageUserProfiles`, so a
   * jcrc gets FORBIDDEN instead of a detailed footprint of an account they
   * could never delete.
   */
  getDeletionImpact: roleManagerProcedure
    .input(targetSchema)
    .query(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID); // I-5
      requireCapability(caps(actorRoles), "deleteUsers");

      const target = await loadAdminUserTarget(ctx.db, input.userObjectId);
      await assertMayManageUserProfileOf(
        ctx.db,
        actorUserID,
        actorRoles,
        target,
        writeAudit,
      );

      const [footprint, refusals, enabled] = await Promise.all([
        countUserFootprint(ctx.db, target),
        computeDeleteRefusals(ctx.db, actorUserID, target),
        // The switch state ships WITH the payload, the ccaAdmin.listAll
        // pattern, so the dialog can disable its button without a second round
        // trip and without the default-off flag reading as a broken button. The
        // mutation asserts it again — a disabled control is cosmetic, the
        // procedure is the boundary.
        isUserDeleteEnabled(ctx.db),
      ]);

      return {
        enabled,
        email: target.email,
        canonicalUserID: target.canonicalUserID,
        counts: footprint.counts,
        headOfCcaIDs: footprint.headOfCcaIDs,
        /**
         * Bookings of theirs the cascade KEEPS, because a published event or a
         * live interview slot is standing on them. Rendered under "what
         * survives", never added to `counts.bookings` — the destroyed count
         * must be exactly what will be destroyed.
         */
        retainedBookings: footprint.retainedBookings,
        refusals,
      };
    }),

  /**
   * DELETE an account and everything keyed on its canonical identity.
   *
   * THE ONLY IRREVERSIBLE WRITE IN THE ADMIN SURFACE. Admin-only
   * (`deleteUsers`), and additionally behind the default-off
   * `admin.userDelete.enabled` SystemFlag.
   *
   * THIS IS THE ONLY PATH IN THE APP THAT REMOVES A `UserRole` DOCUMENT, and it
   * is still NOT a second writer of `UserRole.roles` (I-14 / I-8c): it writes no
   * role set at all. The document is removed WHOLE, in the same transaction as
   * the CcaHead rows, so CH-1 ("holds the cca_head string IFF >= 1 CcaHead
   * row") holds vacuously afterwards — no string, no rows.
   *
   * ORDER OF OPERATIONS BELOW IS LOAD-BEARING. Read the letters.
   */
  delete: roleManagerProcedure
    .input(
      z
        .object({
          userObjectId: objectIdSchema,
          /** Typed by the operator; compared to the STORED email server-side. */
          confirmEmail: z.string().trim().min(1),
          reason: z.string().trim().max(REASON_MAX).optional(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      // (a) THE KILL SWITCH, FIRST — before the capability check, before the
      // load, before anything. The page-level check is cosmetic; this is the
      // boundary. It fails CLOSED on an unreachable flag.
      await assertUserDeleteEnabled(ctx.db);

      // (b) I-5 live re-read of the ACTOR's roles, then the capability.
      const actorUserID = ctx.session.user.userID;
      const actorRoles = await getUserRoles(ctx.db, actorUserID);
      requireCapability(caps(actorRoles), "deleteUsers");

      // (c) Resolve the target and apply G3. Audits its own denial.
      const target = await loadAdminUserTarget(ctx.db, input.userObjectId);
      await assertMayManageUserProfileOf(
        ctx.db,
        actorUserID,
        actorRoles,
        target,
        writeAudit,
      );

      const cid = target.canonicalUserID;

      // (d) The typed-email confirmation, CHECKED ON THE SERVER against the
      // stored address. A `confirmed: true` boolean from the client is not
      // evidence — the same reasoning the bulk plan tokens are built on. The
      // client's own comparison is a courtesy; this one is the control.
      // Case-insensitive because the operator reads the address off a table
      // that may render it in any case, and email localparts are treated
      // case-insensitively everywhere else in this codebase.
      if (
        input.confirmEmail.trim().toLowerCase() !==
        target.email.trim().toLowerCase()
      ) {
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: cid ?? undefined,
          action: "denied",
          ok: false,
          denyReason: "CONFIRM_EMAIL_MISMATCH",
          reason: truncate(`user delete: ${target.email}`),
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "CONFIRM_EMAIL_MISMATCH",
        });
      }

      // (e) The refusal set. ONE denial row for the whole set rather than one
      // per reason, so the audit surface shows one refused attempt, not four.
      const refusals = await computeDeleteRefusals(ctx.db, actorUserID, target);
      if (refusals.length > 0) {
        const joined = refusals.join("+");
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: cid ?? undefined,
          action: "denied",
          ok: false,
          denyReason: truncate(joined),
          reason: truncate(`user delete: ${target.email}`),
        });
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: joined });
      }

      // (f) CAPTURE THE BEFORE-IMAGE. After the cascade there is nothing left
      // to read: the audit row is the only surviving record of this account,
      // and `rolesBefore` is the record of what privilege the delete destroyed.
      // Read here rather than inside the cascade because writeAudit runs
      // outside the transaction and cannot see anything the transaction held.
      const [rolesBefore, footprint] = await Promise.all([
        cid ? getUserRoles(ctx.db, cid) : Promise.resolve([] as string[]),
        countUserFootprint(ctx.db, target),
      ]);

      // (g) The cascade. batchId is minted here, so the denial row a failed
      // commit writes and the success row a good one writes are findable under
      // the same batch — the two-sided pattern grantCcaHead / transferCcaHead
      // established.
      const batchId = randomUUID();
      let result: { deleted: Record<string, number>; retainedBookings: number };
      try {
        result = await deleteUserAccountCascade(ctx.db, target, actorUserID);
      } catch (err) {
        // The transaction rolled back, so NOTHING was destroyed. What this row
        // records is that an attempt reached commit and lost a race: the
        // in-transaction re-checks (sole head of a CCA, target granted admin,
        // actor deleting themselves) re-evaluate state that the preflight read
        // seconds earlier in OPERATOR time. Written on ctx.db, AFTER the
        // rollback (I-15) — a row written inside would have been rolled back by
        // the very failure it documents.
        await writeAudit(ctx.db, {
          actorUserID,
          actorRoles,
          targetUserID: cid ?? undefined,
          action: "denied",
          ok: false,
          denyReason:
            err instanceof TRPCError ? truncate(err.message) : "CASCADE_FAILED",
          reason: truncate(`user delete: ${target.email}`),
          batchId,
        });
        throw err;
      }

      // (h) The success row. OUTSIDE the transaction (I-15) and AFTER it: an
      // audit row written inside would be rolled back by the very failure it
      // documents. This row deliberately OUTLIVES its subject — RoleAuditLog is
      // append-only by code contract and the cascade does not touch it.
      await writeAudit(ctx.db, {
        actorUserID,
        actorRoles,
        targetUserID: cid ?? undefined,
        action: "user.delete",
        rolesBefore,
        // Empty because the role document is gone, not because no role was
        // held. `rolesBefore` above is where the destroyed privilege is
        // recorded; the pair reads as "held these, now holds nothing".
        rolesAfter: [],
        batchId,
        reason: truncate(
          [
            target.email,
            cid ? `id ${cid}` : "no canonical id",
            Object.entries(result.deleted)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${k}=${n}`)
              .join(","),
            // Named on the row because it is the one place the cascade did NOT
            // do what "delete everything of theirs" would suggest, and the
            // audit row is the only surviving record of the account.
            result.retainedBookings > 0
              ? `kept ${result.retainedBookings} booking(s) held for a CCA record`
              : "",
            input.reason ? `— ${input.reason}` : "",
          ]
            .filter(Boolean)
            .join(" | "),
        ),
      });

      return {
        deleted: result.deleted,
        // The preflight counts as the operator last saw them, echoed back so
        // the dialog can report what went without re-querying a user that no
        // longer exists.
        footprint: footprint.counts,
        email: target.email,
      };
    }),
});
