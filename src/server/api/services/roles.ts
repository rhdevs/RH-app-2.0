import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { EXT_ID, canonicalUserID, isCanonicalResidentID,
  isExtUserID,
} from "~/lib/identity";

/**
 * Role VOCABULARY + the stored-baseline machinery (RBAC v2, 02-backend-authz.md
 * §3.1, §2.5, §7.1). `access.ts` remains POLICY; this file is what policy is
 * expressed in.
 *
 * The plan's file map splits this across roles.ts / baseline.ts /
 * capabilities.ts. They are consolidated here by explicit instruction. The
 * split was never load-bearing: nothing below imports access.ts, so there is no
 * cycle, and the module stays runtime-pure (PrismaClient is a TYPE-ONLY import
 * and is erased), which is what let doc 03's client components import the
 * vocabulary. Keep it that way — do not add a value import of `~/server/db`,
 * `~/env`, `@trpc/server` or `next/server` here. That is why `requireCapability`
 * (02 §7.1), which needs TRPCError, is deliberately NOT in this file.
 */

export {
  asStoredCanonicalUserID,
  canonicalFromNusnetID,
  canonicalUserID,
  isNusStudentEmail,
  normalizeEmail,
} from "~/lib/identity";
export type { CanonicalUserID } from "~/lib/identity";

/**
 * Single source of truth for role identifiers.
 *
 * THIS COMMENT USED TO SAY "adding a role = add it here and to ASSIGNABLE_BY,
 * and nothing else". That was false, and it was false in the silent direction:
 * a role added to ROLES alone is DROPPED at the read boundary by
 * normalizeStoredRoles (it keeps only grantable roles plus the baseline), so it
 * would be stored, invisible and inert, and nothing would say so. The accurate
 * checklist, derived by walking the actual consumers:
 *
 *   1. ROLES (here)                    — or normalizeStoredRoles cannot type it
 *   2. GRANTABLE_ROLES                 — or normalizeStoredRoles DROPS it on
 *                                        every read, and assertCanMutateRoles
 *                                        never sees it in the actor's set
 *   3. ASSIGNABLE_BY + REVOCABLE_FROM_OTHERS_BY — who may grant/revoke it, and
 *                                        what IT may grant/revoke
 *   4. FACILITY_ROLES                  — only if a facility may require it
 *   5. computeCapabilities             — what it can actually DO; a role with no
 *                                        capability is a badge, not a power
 *   6. a procedure builder in server/api/trpc.ts — so a router can gate on it
 *   7. the badge maps in src/app/_components/RoleBadges.tsx and
 *      src/app/admin/_components/RoleBadge.tsx — or the UI renders the raw
 *      string, and the hardcoded `as` unions in the admin components (which are
 *      casts, so they will NOT fail to compile) start lying
 *   8. ROLE_VOCAB in scripts/remediation/lib/rbac.mjs — or rbac-doctor.mjs
 *      reports every legitimate grant as an out-of-vocabulary stray and exits 1
 *
 * PRECEDENCE is deliberately NOT on that list. See its own comment.
 */
export const ROLES = ["admin", "jcrc", "cca_head", "resident", "scrc"] as const;
// The v1 pseudo-role "user" is DELETED from the vocabulary (00-overview.md
// §2.2); `resident` is the floor. Do not re-add it — an unused enum member is a
// read-boundary hazard (07-cca-future.md §1.4).
export type Role = (typeof ROLES)[number];

/**
 * The role NAME STRINGS are declared in `~/lib/roleNames` and re-exported here.
 *
 * They live there because that module is PURE and a `"use client"` component can
 * import it; this module cannot be imported from the browser at all (Prisma and
 * `~/env` at module scope). Re-exported rather than moved so every existing
 * `from "~/server/api/services/roles"` import keeps working and there is still
 * one obvious place to look for them.
 *
 * The long notes below on `scrc` and `resident` describe what those roles MEAN
 * and stay here, with the machinery that enforces it.
 */
// Imported AND re-exported, not `export … from`: this module uses these names
// in its own body (capability tables, grant guards), and a pass-through
// re-export binds nothing locally.
import {
  ADMIN_ROLE,
  JCRC_ROLE,
  CCA_HEAD_ROLE,
  SCRC_ROLE,
  BASELINE_ROLE,
} from "~/lib/roleNames";

export { ADMIN_ROLE, JCRC_ROLE, CCA_HEAD_ROLE, SCRC_ROLE, BASELINE_ROLE };
/**
 * Hall Office / SCRC. A STAFF-SIDE role, not a student-leadership one, and the
 * narrowest privileged role in the vocabulary.
 *
 * GRANTABLE BY ADMIN ONLY — it appears in no ASSIGNABLE_BY entry but admin's,
 * which is what stops it self-propagating. Its one power OVER OTHER USERS is
 * `jcrc`: ASSIGNABLE_BY.scrc / REVOCABLE_FROM_OTHERS_BY.scrc are exactly
 * ["jcrc"], because appointing the JCRC is the hall office's actual job. It
 * gets read-only oversight of CCA rosters and events on top of that, and
 * NOTHING else — in particular NOT manageCcaHeads, which would hand it
 * assertHeadsCca and with it every CCA write and the attendee PII export.
 *
 * KNOWN, ACCEPTED CONSEQUENCE, stated here because it is not obvious from the
 * capability list: because it may grant `jcrc`, an scrc holder can appoint a
 * confederate who then holds the whole manager tier. The chain TERMINATES there
 * (ASSIGNABLE_BY.jcrc is [], so no path reaches `admin`, manageFacilityAccess,
 * deleteUsers, readAuditLog or manageEnforcementFlag). It is contained by the
 * self-target refusal in admin.setJcrcRole, the `scrc.enabled` kill switch, and
 * an audit row per grant carrying the actor's roles.
 */
/**
 * Baseline capability of every verified NUS account. STORED and auto-assigned
 * (I-8), never GRANTABLE: it is written only by ensureBaseline, the register
 * route, the createUser event and the backfill — never through the role UI.
 */

/**
 * Roles that survive every role write, because they cannot be expressed in a
 * removal payload (I-8c). SINGLE SOURCE — roleService imports it, and doc 03's
 * admin UI imports it so the preview's `After` column matches what the server
 * will actually do. The UI list is NOT the mechanism; the chokepoint is.
 */
export const STICKY = [BASELINE_ROLE] as const;

/**
 * PRE-V2 LEGACY CONSTANT ONLY — the value the still-deployed `access.ts:19`
 * falls back to (`row?.role ?? DEFAULT_ROLE`). It is deliberately NOT a member
 * of `ROLES` and is `Role`-incompatible: "user" is not part of the v2
 * vocabulary. Never stored, never granted, never compared against `roles[]`.
 * Removed with the legacy scalar in `06-legacy-cutover.md` §5 step 4.
 */
export const DEFAULT_ROLE = "user" as const;

/**
 * Roles the role machinery may WRITE — the domain of the `removed` set at the
 * write chokepoint (`removed ⊆ before ∩ GRANTABLE_ROLES`).
 *
 * `resident` is DELIBERATELY ABSENT (I-8e), and under the STORED baseline its
 * absence does more work than it used to. Because `resident` is not in this
 * list, it is not FILTERED OUT of a removal set — it is INCAPABLE OF APPEARING
 * IN ONE. roleSchema cannot express it, ASSIGNABLE_BY and
 * REVOCABLE_FROM_OTHERS_BY do not contain it, and no set, bulk, undo or
 * deferred payload can carry it in either direction. That is the mechanism, not
 * a convention and not a UI list.
 *
 * `cca_head` IS here — the CCA endpoints must be able to remove it — but it is
 * absent from ASSIGNABLE_BY / REVOCABLE_FROM_OTHERS_BY, which is what keeps it
 * off the GENERIC path (I-14). Membership here is "writable by some chokepoint",
 * not "reachable from grant/revoke/set/bulk".
 *
 * Corollary, stated where someone might try it: a manual DATABASE revocation of
 * `resident` is not a sanction — I-8b repairs it at the target's next page
 * load. A booking ban is a separate affirmative flag (00-overview.md §3.4),
 * never the absence of the baseline.
 *
 * `scrc` IS here, and its membership is MANDATORY rather than a design choice.
 * normalizeStoredRoles — the read boundary every consumer goes through — keeps
 * a stored string only if it is grantable or is the baseline. Omit `scrc` from
 * this list and the role is written to Mongo, dropped on every read, absent
 * from the session, absent from the actor set assertCanMutateRoles computes
 * ASSIGNABLE_BY from, and therefore completely inert with no error anywhere.
 */
export const GRANTABLE_ROLES = ["admin", "jcrc", "cca_head", "scrc"] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/**
 * Roles a FACILITY may require. Separate enum from GRANTABLE_ROLES because D-1
 * pulled the two domains apart: `resident` is requirable but not grantable, and
 * `admin` is grantable but must NEVER be stored in requiredRoles (it is an
 * implicit bypass; storing it invites someone to delete it and lock admins out).
 *
 * `scrc` is here for the WRITE path, not the read path: canBookWithRoles does a
 * plain string intersection and would honour any stored value, but
 * admin.setFacilityAccess validates against this enum, so without the entry the
 * admin UI physically cannot write ["jcrc","scrc"] onto the SCRC Room and the
 * change would have to be made by hand in Atlas — unaudited.
 */
export const FACILITY_ROLES = [
  "resident",
  "jcrc",
  "cca_head",
  "scrc",
] as const;
export type FacilityRole = (typeof FACILITY_ROLES)[number];

/** Values allowed in `RoleAuditLog.action` (prisma/schema.prisma). */
export const AUDIT_ACTIONS = [
  "grant",
  "revoke",
  "set",
  "facilityAccess.set",
  "denied",
  "pending.create",
  "pending.claim",
  "pending.revoke",
  "booking.denied.shadow",
  "ccaHead.grant",
  "ccaHead.revoke",
  "ccaHead.transfer",
  // CCA management (/admin/manage-ccas). There is deliberately NO "cca.delete":
  // no surface deletes a CCA, and deleteCcaCascade is script-only and guarded.
  // Do not add one without re-reading cascade.ts — a delete that reaches
  // bookings by ccaID is the most destructive write in this codebase.
  "cca.create",
  "cca.rename",
  "ccaMember.add",
  "ccaMember.remove",
  // Written by CCA HEADS, not admins — the only action in this list whose actor
  // may hold no management capability at all. Authorised per-ccaID by
  // assertHeadsCca, so the audit row's targetCcaID is the scope that was proven.
  "ccaProfile.update",
  // CCA membership APPLICATIONS (cca.applications.enabled switch). The submit /
  // withdraw / bookSlot / cancelSlot actions are RESIDENT-authored (actor is the
  // applicant themselves, holding no management capability); the interview-slot,
  // note, accept and reject actions are HEAD-authored and authorised per-ccaID by
  // assertHeadsCca. `ccaApplication.accept` is paired with a `ccaMember.add` row
  // for the UserCCA write it performs, so the roster change stays attributable.
  "ccaApplication.submit",
  "ccaApplication.withdraw",
  "ccaApplication.bookSlot",
  "ccaApplication.cancelSlot",
  "ccaApplication.accept",
  "ccaApplication.reject",
  "ccaInterviewSlot.open",
  "ccaInterviewSlot.edit",
  "ccaInterviewSlot.cancel",
  // Bulk-cancel of every FREE (unbooked) slot at once. Booked slots are never
  // touched by this — they still go through ccaInterviewSlot.cancel one at a
  // time, which reverts the applicant. The audit row carries the cleared count.
  "ccaInterviewSlot.clear",
  "ccaInterviewNote.add",
  // The HALL-WIDE RECRUITMENT FREEZE (the `cca.recruitment` SystemFlag row).
  // Written by admin or jcrc through ccaRecruitment.setState, which is the ONLY
  // writer of that row from the app — scripts/remediation/set-cca-recruitment.mjs
  // is the break-glass second one, and it stamps `script:` into updatedBy so the
  // two stay distinguishable. `rolesAfter` carries the new state
  // ("open" | "closed"), which is the same place admin.setEnforcementMode puts
  // its mode, because RoleAuditLog has no column for a flag value; `reason`
  // carries the operator's optional note.
  //
  // There is deliberately NO targetCcaID: the switch is hall-wide by
  // construction, and stamping one CCA on it would assert a scope that was
  // never chosen. Note also that this action does NOT record the freeze being
  // ENFORCED — a refused application writes nothing at all, by design; the log
  // records who changed the switch, not who bounced off it.
  //
  // 18 characters, under the 32-char cap admin.listAuditLog's
  // `action: z.string().max(32)` filter imposes.
  "ccaRecruitment.set",
  // Events feature. THE RULE, applied without exception: STATE-MACHINE
  // TRANSITIONS ARE AUDITED, FIELD SAVES ARE NOT. `event.create` and
  // `event.update` therefore write nothing — `update` fires on every save, and a
  // row per save would bury the handful that describe what actually HAPPENED to
  // an event under hundreds that describe someone typing, in a table whose
  // stated purpose is "who was handed a privilege, by whom, when" and which
  // admin.listAuditLog pages 25 rows at a time.
  //
  // WHO WRITES WHICH. approve/changes/decline are written by the JCRC
  // (reviewEvents, re-read live in `decide`); submit, withdraw, duplicate,
  // cancel and attendees.export are written by the OWNER — the CCA head via
  // assertHeadsCca, or a manageHallEvents holder for a hall-wide event.
  // attendees.export records a PII export (matric/block/telegram) and its audit
  // row carries the exported attendee count in `reason`.
  //
  // THERE IS NO `event.reject` OR `event.publish`. Rejection split into
  // `event.changes` (reopens the event, resubmittable) and `event.decline`
  // (terminal); publishing folded into `event.approve`, because approval now
  // publishes in one write. Both strings were retired while the collection held
  // ZERO rows carrying them, so no stored row became unfilterable.
  //
  // THERE IS DELIBERATELY NO `event.cancel.jcrc`: writeAudit denormalises
  // actorRoles onto the row, so `actorRoles contains "jcrc"` already selects a
  // reviewer cancellation — the same argument the scrc role changes make below.
  //
  // A HALL EVENT PUBLISHED BY ITS OWN AUTHOR WRITES TWO ROWS — `event.submit`
  // then `event.approve`, same actorUserID, same targetEventID, seconds apart.
  // That pairing IS the audit record of a self-approval and it must stay
  // legible: do not collapse the two calls into one row, and do not suppress the
  // submit row because "nobody reviewed it". Two rows with one actor is
  // precisely the fact an auditor needs to see.
  //
  // All are under the 32-char cap admin.listAuditLog's
  // `action: z.string().max(32)` filter imposes.
  "event.submit",
  "event.withdraw",
  "event.approve",
  "event.changes",
  "event.decline",
  "event.cancel",
  "event.duplicate",
  "event.attendees.export",
  // Part C. A CHECK-IN IS NOT AUDITED — the EventAttendance row IS the
  // record and carries who, when and by whom; a parallel audit row would
  // duplicate it in a table that pages 25 at a time. AN UNDO IS, because it
  // ERASES a claim about where a person physically was, and after it there
  // is no row left to carry that fact.
  "event.checkin.undo",
  // Admin CRUD over USER DETAILS (/admin/users detail dialog). NOTE what is
  // absent: no "user.create" (signup + PendingRoleGrant own onboarding) and no
  // role action — these endpoints are NOT a second writer of UserRole.roles
  // (I-14). `user.delete` REMOVES the whole UserRole document rather than
  // writing a role set, and its row carries the deleted user's rolesBefore so
  // the privilege that was destroyed stays on the record.
  //
  // `user.detail.read` is the ONLY read in this list, and it is here for the
  // same reason `explainAccess` audits: it is a per-target disclosure primitive
  // over the whole user base, reachable by every jcrc. `userAdmin.get` returns
  // matric, telegramHandle and bio — none of which is in the listUsers
  // projection — so a loop over the ids listUsers already hands out exfiltrates
  // the hall's matriculation numbers and Telegram handles. The target guard
  // audits only DENIALS (target holds admin / unkeyed row), so without this row
  // every successful read of a non-admin is silent and an admin investigating a
  // leak cannot say who read what, or that a bulk read happened at all. The
  // same PII exported in bulk is already audited by `event.attendees.export`.
  //
  // All three names are under the 32-character cap that admin.listAuditLog's
  // `action: z.string().max(32)` filter imposes — keep any future addition
  // under it too, or the filter silently cannot select it.
  "user.detail.read",
  "user.profile.update",
  "user.delete",
  // The SECOND read in this list, and it is here for exactly the
  // `user.detail.read` reason: admin.resolveJcrcCandidate is a per-target
  // disclosure primitive (identifier in, a named person out) reachable by every
  // scrc holder, and it is the ONLY enumeration-shaped surface `scrc` has. The
  // grant/revoke it precedes is already audited by applyRoleChange's "set" row,
  // so without this one a hall-office member can probe who exists — email by
  // email — and leave no trace at all unless they then act.
  //
  // There is deliberately NO "scrc.jcrc.grant" / ".revoke": the write goes
  // through applyRoleChange, which hardcodes action "set" and denormalises
  // actorRoles onto the row, so `actorRoles contains "scrc"` already selects
  // every hall-office role change. A distinct action would mean either editing
  // the chokepoint or writing a duplicate row — both worse than a query.
  //
  // 19 characters, under the 32-char cap admin.listAuditLog's filter imposes.
  "scrc.candidate.read",
  // D-7 BREAK-GLASS PIN SURFACE (admin.addAuthAllowlistEntry /
  // removeAuthAllowlistEntry, adminProcedure only). These two are the ONLY
  // actions in this list that create or destroy an IDENTITY rather than a
  // privilege: an AuthAllowlist row is what lets a non-@u.nus.edu address hold
  // a session key at all (see prisma/schema.prisma's AuthAllowlist model and
  // services/authAllowlist.ts). Everything else here presupposes an identity
  // and moves roles around on top of it.
  //
  // `targetUserID` carries the EXT pin and `reason` carries the pinned address,
  // so "who was handed an identity, by whom, when" is one query. Denials are
  // written as `denied` with denyReason EMAIL_IS_CANONICAL /
  // PIN_ALREADY_HAS_ROLES / EMAIL_ALREADY_PINNED / PIN_ALREADY_USED /
  // PIN_STILL_HOLDS_ROLES — the shapes the write refuses (M4).
  //
  // There is deliberately NO "authAllowlist.update": a pin is immutable, so
  // re-aiming a key at a different address is remove-then-add, i.e. two rows.
  // 18 and 21 characters, both under the 32-char cap.
  "authAllowlist.add",
  "authAllowlist.remove",
  // IDENTITY RE-KEY (scripts/remediation/rekey-to-ext-identity.mjs). Written
  // once per migrated account, and it is THE ONLY THING THAT TIES THE TWO KEYS
  // TOGETHER.
  //
  // That matters more here than for any other action in this list, because
  // `RoleAuditLog` is deliberately NOT re-keyed by that script — those rows
  // state what was true at the time and rewriting them would make the log
  // assert history that did not happen. The consequence is that an account's
  // audit trail is SPLIT across its old key and its pin, and this row is the
  // join: `rolesBefore: [<old key>]`, `rolesAfter: [<pin>]`, `targetUserID`
  // the pin. Without it the pre-migration half of a person's history is
  // unreachable by anyone who only knows their current id.
  // 13 characters, well under the 32-char cap.
  "identity.rekey",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Legacy-mirror precedence for the D-6 dual-write window. Must match
 * seed-roles-v2.mjs. `resident` is deliberately EXCLUDED: the only consumer of
 * the legacy scalar is a rollback to the pre-v2 access.ts, which is
 * default-OPEN and cannot interpret `resident`. Writing it there would be
 * meaningless at best and would displace a real value at worst.
 * Removed entirely in doc 06.
 *
 * `scrc` is EXCLUDED FOR THE SAME REASON, and this is the one place in the
 * whole scrc change where doing the obvious thing would touch live traffic.
 * legacyMirror returns the FIRST match, so putting `scrc` anywhere above `jcrc`
 * would mirror a jcrc+scrc holder as "scrc" — a scalar the still-deployed
 * pre-v2 access.ts cannot interpret — and a rollback would silently demote a
 * sitting JCRC member out of the SCRC Room and out of /admin. Putting it below
 * `cca_head` is harmless and also pointless. Leaving it out is correct: a plain
 * scrc holder mirrors to "" (falsy, benign, exactly the resident treatment) and
 * a jcrc+scrc holder still mirrors to "jcrc".
 *
 * Must stay identical to PRECEDENCE in scripts/remediation/lib/rbac.mjs.
 */
export const PRECEDENCE = ["admin", "jcrc", "cca_head"] as const;

/**
 * The `$set: { role: ... }` half of the dual-write. Returns null when the user
 * holds no mirrorable role — including the extremely common `["resident"]`
 * case, which must write null rather than "resident" (see PRECEDENCE).
 *
 * The chokepoint that consumes this carries `$set: { role: legacyMirror(after) }`
 * and MUST NOT also carry `$setOnInsert: { role: "" }`: MongoDB rejects two
 * operators naming the same path with ConflictingUpdateOperators, at parse
 * time, for the whole command (I-8c correction 2, I-9). The `""` sentinel
 * belongs only where nothing else writes `role` — i.e. ensureBaseline below.
 */
export function legacyMirror(roles: readonly string[]): string | null {
  return PRECEDENCE.find((r) => roles.includes(r)) ?? null;
}

/**
 * Privilege-escalation firewall as DATA, not if-statements.
 * Null prototype: a router that ever passes an unvalidated string must not be
 * able to reach Object.prototype via ASSIGNABLE_BY["constructor"].
 *
 * Constrains WHICH ROLES a caller may touch. It does NOT constrain WHICH
 * TARGET — that is the separate target guard G3. Both are required; neither is
 * sufficient.
 *
 * D-3, OVERRIDING v1: a jcrc may NOT grant jcrc. Only admins grant or revoke
 * jcrc. Consequence to be aware of: a jcrc who steps down can be restored only
 * by an admin, not by a peer.
 *
 * I-14: `cca_head` is absent from EVERY entry, admin's included. It never
 * travels the generic grant/revoke/set/bulk/deferred path; it is written only
 * by admin.grantCcaHead / revokeCcaHead / transferCcaHead, which maintain the
 * UserRole string and the CcaHead row in one transaction. The jcrc power to
 * manage CCA heads is a separate CAPABILITY (`manageCcaHeads` below), not an
 * assignable role. 02-backend-authz.md §3.1 still shows the pre-I-14 form
 * (`admin: [...,"cca_head"], jcrc: ["cca_head"]`); 00-overview.md §3.2 is the
 * form that ships and is the one below.
 *
 * `resident` maps to [] and appears in no other entry, in either direction, at
 * any level — I-8e. `user` is retained as a key only so a legacy row still
 * carrying the dead scalar resolves to [] instead of undefined.
 *
 * `scrc` (hall office) is the FIRST non-admin key with a non-empty entry, and
 * it is exactly ["jcrc"] — narrower than admin's, and narrower than the role
 * itself: `scrc` cannot grant `scrc`, so the role cannot self-propagate and
 * only an admin can ever create another hall-office account. It appears in
 * admin's list for the same reason `jcrc` does. Read SCRC_ROLE's comment for
 * the escalation closure this opens and what contains it.
 */
export const ASSIGNABLE_BY: Record<string, readonly GrantableRole[]> =
  Object.assign(
    Object.create(null) as Record<string, readonly GrantableRole[]>,
    {
      admin: ["admin", "jcrc", "scrc"] as const,
      jcrc: [] as const,
      cca_head: [] as const,
      resident: [] as const,
      scrc: ["jcrc"] as const,
      user: [] as const,
    },
  );

/**
 * Roles a caller may REVOKE from ANOTHER user. Kept as a separate map from
 * ASSIGNABLE_BY even though D-3 currently makes them identical, because they
 * answer different questions and will diverge again if a role is ever made
 * grant-but-not-revoke. `resident` is absent here too (I-8e).
 *
 * `scrc: ["jcrc"]` deliberately MATCHES its ASSIGNABLE_BY entry: a hall office
 * that can appoint the JCRC but not un-appoint it would push every removal back
 * to an admin, and the whole point of the role is that it does not need one.
 * Note it still cannot revoke `scrc` — not from others and, via G5's self-branch
 * plus this map, not meaningfully from anyone but itself.
 */
export const REVOCABLE_FROM_OTHERS_BY: Record<
  string,
  readonly GrantableRole[]
> = Object.assign(
  Object.create(null) as Record<string, readonly GrantableRole[]>,
  {
    admin: ["admin", "jcrc", "scrc"] as const,
    jcrc: [] as const,
    cca_head: [] as const,
    resident: [] as const,
    scrc: ["jcrc"] as const,
    user: [] as const,
  },
);

/* -------------------------------------------------------------------------- */
/* Mutually exclusive roles                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Role pairs NOBODY may hold at once. A FIFTH invariant, alongside the sticky
 * baseline, the last-admin guard, the compare-and-set and CH-1.
 *
 * ONE PAIR TODAY: `jcrc` + `scrc`. This is not tidiness — it closes a hole that
 * the capability matrix cannot see, because the leak is in the UNION of two
 * individually-sound role definitions:
 *
 *   - `roleManagerProcedure` admits anyone holding `jcrc`. So a jcrc+scrc holder
 *     reaches `setUserRoles`, whose payload is a CLIENT-SUPPLIED FINAL ROLE SET
 *     — defeating the entire reason `setJcrcRole` constructs its set on the
 *     server — plus `previewBulkImport` / `commitBulkChunk` and
 *     `createPendingGrants`.
 *   - `assignableBy(["jcrc","scrc"])` unions ASSIGNABLE_BY.jcrc ([]) with
 *     ASSIGNABLE_BY.scrc (["jcrc"]) to give ["jcrc"], which is non-empty, so
 *     `bulkAssign` and `createPendingGrants` both compute TRUE for them.
 *
 * Composed: one person who holds both can bulk-grant `jcrc` to hundreds of
 * accounts in a single call, or queue deferred grants that redeem later — and
 * NONE of those paths reads the `scrc.enabled` kill switch, because the switch
 * is checked in the three scrc procedures and nowhere else. The switch would be
 * off and the grant power would still be live. The original plan left this as an
 * "operational rule: do not grant scrc to a jcrc holder". An operational rule is
 * not a mechanism, and this one is a mechanism.
 *
 * ENFORCED ON THE RESULTING SET, NOT THE DELTA, at every writer of
 * `UserRole.roles`: assertCanMutateRoles (audited denial — covers setUserRoles,
 * setJcrcRole, bulk import, bulk undo and their previews), applyRoleChange (a
 * backstop assert for a hand-written caller), createPendingGrants (refused at
 * creation) and redeemPendingGrants (re-checked at redemption against the
 * target's CURRENT stored roles, because a grant is a bearer credential that
 * outlives the state it was created in). Checking the delta instead would let a
 * payload that merely OMITS the conflicting role slip past — the same shape of
 * mistake G4 exists to prevent.
 *
 * `resident` is in no pair and must never be: it is the sticky baseline, so a
 * pair containing it would make some role set unreachable rather than forbidden.
 */
export const EXCLUSIVE_ROLE_PAIRS = [[JCRC_ROLE, SCRC_ROLE]] as const;

/**
 * The deny reason if `roles` contains a forbidden pair, else null.
 *
 * Returns a STRING rather than throwing, because its four call sites need four
 * different failure modes — an audited `deny()`, an INTERNAL_SERVER_ERROR
 * assert, a Zod-level refusal and a quiet skip on the never-throws session path.
 * Lives here rather than in admin.ts so the redemption path in this file can use
 * it without closing the auth.ts import cycle.
 */
export function forbiddenRoleCombination(
  roles: readonly string[],
): string | null {
  for (const [a, b] of EXCLUSIVE_ROLE_PAIRS) {
    if (roles.includes(a) && roles.includes(b)) {
      return `CANNOT_HOLD_${a.toUpperCase()}_AND_${b.toUpperCase()}`;
    }
  }
  return null;
}

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

export function isGrantableRole(v: string): v is GrantableRole {
  return (GRANTABLE_ROLES as readonly string[]).includes(v);
}

export function isFacilityRole(v: string): v is FacilityRole {
  return (FACILITY_ROLES as readonly string[]).includes(v);
}

function union(
  map: Record<string, readonly GrantableRole[]>,
  callerRoles: readonly string[],
): Set<GrantableRole> {
  const out = new Set<GrantableRole>();
  for (const r of callerRoles) for (const a of map[r] ?? []) out.add(a);
  return out;
}
export const assignableBy = (roles: readonly string[]) =>
  union(ASSIGNABLE_BY, roles);
export const revocableFromOthersBy = (roles: readonly string[]) =>
  union(REVOCABLE_FROM_OTHERS_BY, roles);

/**
 * POST-CANONICALIZATION SANITY CHECK on an id. NOT an authorization test and
 * NOT a provenance test — it is a pure SHAPE test and it carries no evidence
 * about where its argument came from.
 *
 * Renamed from `isResidentEligible` on purpose. Under the stored baseline this
 * predicate GATES A WRITE (I-8d), and the old name invited exactly the misuse
 * that breaks it: calling it on an admin-supplied `targetUserID` and concluding
 * that the principal is NUS-verified. It is sound ONLY over a string that
 * canonicalUserID() has just produced, which is why ensureBaseline takes an
 * EMAIL and canonicalizes internally rather than accepting an id.
 *
 * Deliberately NOT E_FORMAT.test(id): `g.s_samuel@u.nus.edu` is a real,
 * legitimate account whose canonical id is "G.S_SAMUEL". Gating the baseline
 * WRITE on E-format would withhold it permanently, not merely mis-derive once
 * (lockout mode L-27).
 *
 * Re-exported from src/lib/identity.ts rather than redefined: two copies of a
 * write guard is how they drift.
 */
export { isCanonicalResidentID };

/**
 * THE read boundary. Every role consumer goes through this. Replaces v1's
 * normalizeRoles entirely.
 *
 * Takes ONLY the stored array. It does not take a userID and it derives
 * nothing: under I-8 the stored value IS the truth. Unknown strings are
 * dropped, so a stray script write can never become a live permission — and
 * `resident` is KEPT, because it is now a known, valid member of ROLES. The v2
 * discard-then-re-derive step is gone; keeping it would have made a
 * read-boundary filter able to erase a real stored grant.
 */
export function normalizeStoredRoles(
  stored: readonly string[] | null | undefined,
): Role[] {
  const out = new Set<Role>();
  for (const r of stored ?? []) {
    if (isGrantableRole(r)) out.add(r);
    else if (r === BASELINE_ROLE) out.add(r);
  }
  return [...out];
}

/**
 * E-format NUSNET id. A VALIDATION rule for grant targets and pasted bulk input
 * ONLY (guard G7) — never an eligibility test (see isCanonicalResidentID) and
 * never a gate on the baseline write.
 */
export const E_FORMAT = /^E\d{7}$/;
export function isEFormatUserID(id: string): boolean {
  return E_FORMAT.test(id);
}

/**
 * THE identity predicate for grant targets and for any UI that filters on one
 * (I-12: one predicate, not two). Lives here — and not in admin.ts — because
 * this module is runtime-pure and therefore importable by client components,
 * while admin.ts pulls in `node:crypto` and `~/env` and cannot be.
 *
 * `.trim()` and `.toUpperCase()` run BEFORE the regex and are load-bearing: a
 * value pasted from a spreadsheet carries an invisible trailing space, and a
 * client guard that rejects what this schema accepts fails open (09 §2.6).
 * Behaviour is exactly what admin.ts defined locally before this move — do not
 * "tidy" it; 11 server input sites depend on it verbatim.
 */
export const userIDSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(E_FORMAT, "Must be an E-format NUSNET id");

/**
 * An `EXT:` allowlist pin as an INPUT — the other half of the principal key
 * space (08-userid-keydrift.md §3 Branch C, prisma/schema.prisma's
 * `AuthAllowlist`).
 *
 * `.trim().toUpperCase()` first, mirroring `userIDSchema` above so the two
 * behave identically on whitespace and case: a pasted "  ext:ngocanh_mai " must
 * either resolve or be refused, never be quietly stored as a third spelling of
 * one key.
 *
 * The pattern is `EXT_ID` from ~/lib/identity, IMPORTED AND NOT RESTATED —
 * scripts/remediation/verify-identity-parity.mjs bans private identity
 * derivations by source scan, and a second copy of this regex is precisely the
 * thing that rots.
 */
export const extUserIDSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(EXT_ID, "Must be an EXT: allowlist id");

/**
 * The role-mutation TARGET: `userIDSchema` PLUS the EXT namespace, and NOTHING
 * ELSE WIDENS.
 *
 * LIVES HERE, BESIDE `userIDSchema`, FOR THE SAME REASON THAT ONE DOES: this
 * module is runtime-pure and therefore importable by client components, and
 * `src/app/admin/_components/audit/AuditLogTable.tsx` parses its filter inputs
 * with this exact schema so the client cannot be stricter than the server
 * (I-12; a client guard that rejects what the server accepts fails open,
 * 09 §2.6). Defining it in routers/admin.ts instead would drag `node:crypto`
 * and `~/env` into the browser bundle.
 *
 * The APPLICATION of it is enumerated, and the enumeration is the containment —
 * see the note beside `setUserRoles` in routers/admin.ts. It is applied at
 * exactly three server sites (`setUserRoles`, `explainAccess`, `listAuditLog`'s
 * filters). Every other target site — bulk import's `resolveIdentifier`,
 * pending grants, CCA-head grants, and the hall office's own `setJcrcRole` —
 * stays on the bare `userIDSchema`, so the EXT namespace is unreachable from a
 * pasted spreadsheet.
 *
 * `.or()` and NOT a rewritten regex: `userIDSchema`'s `.trim().toUpperCase()`
 * transform is load-bearing at all 11 of its existing sites and a hand-merged
 * pattern would drop it.
 */
/**
 * THE CCA-HEAD GRANT TARGET. Shape only — the real check is resolution against
 * a live account, in admin.ts's `resolveCcaHeadTarget`.
 *
 * WHY THIS EXISTS RATHER THAN `userIDSchema`. That one is `/^E\d{7}$/`, and
 * using it here was lockout mode **L-27** in production: `marcus-chua@u.nus.edu`
 * canonicalises to `MARCUS-CHUA`, which fails the regex, so he could not be made
 * a CCA head at all. Measured 2026-08-28 against the live cluster: **420 of 1624
 * NUS accounts — 25.9%** — have a non-E-format localpart and were therefore
 * ineligible for any headship. `identity.ts` warns about exactly this and says
 * E_FORMAT is "a validation rule for GRANT TARGETS only", which is where the
 * reasoning went wrong: grant targets are people, and a quarter of them do not
 * have E-format emails.
 *
 * WHAT G7 ACTUALLY WANTED was to keep the hall office out of CCA headships —
 * its own comment says "there is no requirement that an EXT principal ever head
 * a CCA". E-format was a blunt way to express "not EXT". That intent is now
 * stated directly: this schema admits the canonical NUS charset and REFUSES the
 * EXT namespace, so the security property is unchanged while the collateral
 * lockout is gone.
 *
 * THIS IS DELIBERATELY LOOSER THAN THE OLD RULE AND THE PIPELINE IS STRICTER.
 * A matric like `A0345036J` passes this shape test — and must not become a
 * CcaHead key, because it would never match the holder's session id and they
 * would be a head who is not a head. `resolveCcaHeadTarget` is what prevents
 * that: it looks the person up and grants on `canonicalUserID(their email)`,
 * so the stored key is always the one a session produces. Never grant straight
 * from this schema's output.
 */
export const ccaHeadTargetSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(64)
  // THE COLON IS ADMITTED HERE ON PURPOSE, then refused below with a truthful
  // message. Without it an `EXT:` pin fails the charset and the admin is told
  // "Not a valid account id" — which is false, it is a perfectly valid id that
  // is not ELIGIBLE — and the refine that says so would never fire.
  .regex(/^[A-Z0-9._%:-]+$/, "Not a valid account id")
  .refine((v) => !v.includes(":") || isExtUserID(v), {
    message: "Not a valid account id",
  })
  .refine((v) => !isExtUserID(v), {
    message: "The hall office can't be made a CCA head",
  });

export const roleTargetUserIDSchema = userIDSchema.or(extUserIDSchema);

/* -------------------------------------------------------------------------- */
/* I-8b — the stored baseline's self-heal                                      */
/* -------------------------------------------------------------------------- */

/**
 * Circuit breaker for ensureBaseline. Per-lambda-instance, same shape as the
 * 15s SystemFlag cache in access.ts.
 *
 * NOT a correctness mechanism. It is the thing that stops a `UserRole`-scoped
 * write fault from turning a per-user denial into an app-wide latency event:
 * without it every request from every affected user would issue 1-2 failing
 * AWAITED writes plus a console.error before the session resolves, on the
 * hottest route in the app. The same bound applies to a mass cold start
 * (stale-backup restore: ~515 users cold at once).
 */
const BREAKER_TTL_MS = 45_000;
const BREAKER_THRESHOLD = 5;
let breakerFailures = 0;
let breakerOpenUntil = 0;

function breakerOpen(): boolean {
  return Date.now() < breakerOpenUntil;
}
function breakerSuccess(): void {
  breakerFailures = 0;
  breakerOpenUntil = 0;
}
function breakerFailure(): void {
  breakerFailures += 1;
  if (breakerFailures >= BREAKER_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_TTL_MS;
    breakerFailures = 0;
  }
}

/** Shape of the MongoDB `update` command reply, as Prisma passes it through. */
type RawUpdateReply = {
  ok?: number;
  n?: number;
  nModified?: number;
  upserted?: unknown[];
  writeErrors?: { code?: number }[];
};

/**
 * I-8b. Idempotent, race-safe top-up of the STORED baseline.
 *
 * Returns true if the baseline is (now) present, false if the repair failed.
 * NEVER throws — it is called from the NextAuth session callback, and an
 * unhandled rejection there rejects the session and force-logs-out the user,
 * which is an unrecoverable state.
 *
 * TAKES THE EMAIL, NOT THE ID (I-8d). The eligibility predicate is a pure SHAPE
 * test with no provenance; it is sound only over a string that canonicalUserID()
 * just produced. Canonicalizing inside means the only way to reach this write is
 * to have presented an @u.nus.edu address. Do not add an id-taking overload
 * "for convenience" — that is how an admin-supplied E-format string becomes a
 * stored baseline for a principal that was never email-verified.
 */
export async function ensureBaseline(
  db: PrismaClient,
  email: string | null | undefined,
): Promise<boolean> {
  const userID = canonicalUserID(email);
  // I-8d trust boundary. The isCanonicalResidentID call is a belt-and-braces
  // sanity check on a string canonicalUserID just produced; the PROVENANCE is
  // established by the line above it, not by the shape test.
  if (!userID || !isCanonicalResidentID(userID)) return false;

  if (breakerOpen()) return false;

  // Exactly two attempts: the initial write, and ONE retry reserved for E11000.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Raw, not typed Prisma, and this is the one place in the design where
      // that is correct: Prisma's Mongo connector cannot express $addToSet
      // (its `push` does not dedupe — I-13 forbids it) and cannot express
      // $setOnInsert at all. This write is NOT inside a $transaction, so the
      // "raw commands do not join an interactive transaction" hazard does not
      // apply here; it is precisely why the role-mutation chokepoint may not
      // copy this shape.
      //
      // `role: ""` on insert satisfies the still-present legacy scalar without
      // polluting doc 06's containment gate. It MUST be the empty string, not
      // null: the still-deployed old client throws on absence AND on null,
      // while "" is falsy and preserves the live `if (!required) return true`.
      // Nothing else in this command touches `role`, which is why $setOnInsert
      // is legal HERE and illegal at the chokepoint (I-9 / I-8c correction 2).
      const res = (await db.$runCommandRaw({
        update: "UserRole",
        updates: [
          {
            q: { userID },
            u: {
              $addToSet: { roles: BASELINE_ROLE },
              $setOnInsert: { role: "" },
            },
            upsert: true,
          },
        ],
        ordered: false,
      })) as unknown as RawUpdateReply;

      // I-8f: INSPECT THE REPLY, DO NOT RELY ON THE EXCEPTION PATH. The MongoDB
      // `update` command does NOT throw on per-write failures — it resolves with
      // { ok: 1, n: 0, writeErrors: [{ code: 11000 | 121 | ... }] }, and
      // $runCommandRaw passes that through as DATA (it rejects only on ok:0 or
      // a driver-level fault). Reading only the catch block would (a) make the
      // E11000 retry below dead code, (b) return true for a write that never
      // applied, and (c) never log baseline_repair_failed — turning the design's
      // single honest residual from MITIGATED+DETECTED into UNDETECTED.
      const errs = res.writeErrors ?? [];
      if (res.ok === 1 && errs.length === 0) {
        breakerSuccess();
        return true;
      }

      // E11000: a CONCURRENT upsert inserted the document between our match and
      // our insert. This is NOT unconditionally success. Treating it as success
      // is wrong under a stored baseline: if the winner was a concurrent bulk
      // grant inserting { roles: ["jcrc"] }, our $addToSet never applied and the
      // user has no baseline. Retry ONCE — the document now exists, so the retry
      // MATCHES and $addToSet applies. Never swallowed, never retried forever.
      if (
        attempt === 0 &&
        errs.length > 0 &&
        errs.every((e) => e.code === 11000)
      ) {
        continue;
      }

      breakerFailure();
      console.error(
        JSON.stringify({
          evt: "baseline_repair_failed",
          userID,
          writeErrors: errs,
        }),
      );
      return false;
    } catch (err) {
      // Connection-level / ok:0 faults DO throw. Secondary path, kept because
      // the reply check above cannot see them.
      if (attempt === 0) continue;
      breakerFailure();
      console.error(
        JSON.stringify({
          evt: "baseline_repair_failed",
          userID,
          err: String(err),
        }),
      );
      return false;
    }
  }

  // Reachable only if attempt 0 signalled `continue` and attempt 1 did too,
  // which the loop bound forbids — kept so the function is total without a
  // non-null assertion.
  breakerFailure();
  return false;
}

/* -------------------------------------------------------------------------- */
/* D-8 — deferred grant redemption                                             */
/* -------------------------------------------------------------------------- */

/**
 * D-8. The READER for `PendingRoleGrant`, called once per user from the session
 * callback and guarded by `UserRole.pendingCheckedAt`.
 *
 * It exists because the WRITER (admin.createPendingGrants + the dashboard
 * panel) shipped without it: rows were validated, audited and persisted, the UI
 * reported success, and nothing ever consulted them — so 30 incoming JCRC
 * members would each sign up, receive `resident` only, hold no `jcrc`, and the
 * grants would sit until purgeExpiredPendingGrants silently deleted them.
 * Shipping the writer without the reader is worse than shipping neither.
 *
 * FIVE PROPERTIES, all load-bearing:
 *
 *  1. NEVER THROWS. Same rule as ensureBaseline — it is awaited (indirectly) on
 *     the NextAuth session path, and a rejection there force-logs-out the user.
 *     Every failure returns quietly and leaves the pending row intact, so the
 *     next login retries.
 *
 *  2. ADDITIVE ONLY. `$addToSet`, never a set-payload, never a `$pull` (I-13).
 *     This is the fourth role-write surface and it deliberately does NOT go
 *     through applyRoleChange's chokepoint; it is sticky by construction
 *     because it is incapable of removing anything, `resident` included.
 *
 *  3. RE-AUTHORIZED AT REDEMPTION AGAINST THE GRANTER'S CURRENT ROLES
 *     (02 §2.5). A grant is a bearer credential that outlives the session that
 *     created it: if the jcrc who queued it has since been demoted, the grant
 *     must not still confer what they may no longer confer. So the granter's
 *     roles are RE-READ here, now, and each role must still be in
 *     assignableBy(them). `resident` is filtered out unconditionally (I-8e) —
 *     the baseline is ensureBaseline's job and only its job (I-8d provenance).
 *
 *  4. `pendingCheckedAt` IS STAMPED UNCONDITIONALLY, including the no-grant and
 *     expired cases. That stamp is what makes the steady-state cost of this
 *     whole feature exactly zero queries after one run per user.
 *
 *  5. THE EXCLUSION INVARIANT IS RE-CHECKED AT REDEMPTION, against the TARGET'S
 *     current roles (EXCLUSIVE_ROLE_PAIRS). Property 3's argument applied to the
 *     other side of the grant: this is the one writer of UserRole.roles that
 *     does not pass through applyRoleChange, so G8 cannot see it, and a pending
 *     `jcrc` queued before the target was made `scrc` would otherwise create the
 *     forbidden pair silently at their next login. Costs one findUnique on a
 *     path that runs once per user, ever.
 */
export async function redeemPendingGrants(
  db: PrismaClient,
  userID: string,
): Promise<void> {
  if (!userID) return;

  try {
    const grant = await db.pendingRoleGrant.findUnique({ where: { userID } });

    // No grant, or an expired one. Stamp and leave. An expired row is DELETED
    // rather than left for purgeExpiredPendingGrants: the person it names has
    // now signed up, so the row can never be redeemed again and keeping it
    // would make listPendingGrants lie about who is still outstanding.
    if (!grant || grant.expiresAt.getTime() <= Date.now()) {
      if (grant) {
        await db.pendingRoleGrant.deleteMany({ where: { userID } });
        await writeRedemptionAudit(db, {
          actorUserID: grant.createdBy,
          actorRoles: grant.createdByRoles,
          targetUserID: userID,
          rolesAfter: grant.roles,
          ok: false,
          denyReason: "PENDING_GRANT_EXPIRED",
          batchId: grant.batchId,
        });
      }
      await stampPendingChecked(db, userID);
      return;
    }

    // Property 3. The granter's roles NOW, not the ones frozen on the row at
    // creation time (`createdByRoles` is kept for the audit trail only).
    const granterRow = await db.userRole.findUnique({
      where: { userID: grant.createdBy },
    });
    const granterRoles = normalizeStoredRoles(
      granterRow?.roles?.length
        ? granterRow.roles
        : granterRow?.role
          ? [granterRow.role]
          : [],
    );
    const canAssign = assignableBy(granterRoles);
    let granted = grant.roles.filter(
      (r) => isGrantableRole(r) && canAssign.has(r),
    );

    // Property 5. THE EXCLUSION INVARIANT, re-checked HERE against the target's
    // CURRENT stored roles — not against the roles they had when the grant was
    // queued, which is the same argument property 3 makes about the granter.
    // This path is the fourth writer of UserRole.roles and the ONE that does not
    // go through applyRoleChange, so G8 cannot cover it; without this, a pending
    // `jcrc` created before someone was made `scrc` would quietly produce the
    // forbidden pair at their next login, with no actor present to refuse.
    //
    // The whole grant is refused rather than partially applied: a bearer
    // credential that silently degrades to a subset is worse than one that fails
    // and says so, and `refused` below already carries the reason onto the audit
    // row. `$addToSet` is additive, so there is nothing to roll back.
    const targetRow = await db.userRole.findUnique({ where: { userID } });
    const targetStored = normalizeStoredRoles(
      targetRow?.roles?.length
        ? targetRow.roles
        : targetRow?.role
          ? [targetRow.role]
          : [],
    );
    const conflict = forbiddenRoleCombination([...targetStored, ...granted]);
    if (conflict) granted = [];

    const refused = grant.roles.filter((r) => !granted.includes(r));

    if (granted.length > 0) {
      const applied = await addRolesAdditive(db, userID, granted);
      if (!applied) {
        // The write failed. Do NOT delete the row and do NOT stamp — leaving
        // both intact is what makes this resumable on the next login, which is
        // the only recovery path a user has here.
        console.error(
          JSON.stringify({ evt: "pending_claim_failed", userID, granted }),
        );
        return;
      }
    }

    // Claimed (or wholly refused) — either way the row is spent. Deleted BEFORE
    // the stamp so a crash between the two re-runs a no-op rather than
    // re-granting.
    //
    // deleteMany, not delete: two concurrent session reads can both observe a
    // null `pendingCheckedAt` and both redeem. The grant itself is idempotent
    // ($addToSet), but `delete` throws P2025 on the loser, which would skip the
    // stamp and leave the check running forever. deleteMany treats zero rows as
    // success.
    await db.pendingRoleGrant.deleteMany({ where: { userID } });
    await writeRedemptionAudit(db, {
      actorUserID: grant.createdBy,
      actorRoles: grant.createdByRoles,
      targetUserID: userID,
      rolesBefore: grant.roles,
      rolesAfter: granted,
      ok: granted.length > 0,
      // The conflict is reported AHEAD of the granter check, because when both
      // fire the exclusion is the real reason and "the granter may no longer
      // assign this" would send an investigator to the wrong person.
      denyReason:
        conflict ??
        (refused.length > 0
          ? `GRANTER_NO_LONGER_MAY_ASSIGN:${refused.join("+")}`
          : null),
      batchId: grant.batchId,
    });
    await stampPendingChecked(db, userID);
  } catch (err) {
    // Property 1. Contained: the row and the absent stamp both survive, so the
    // next session read retries.
    console.error(
      JSON.stringify({
        evt: "pending_redeem_failed",
        userID,
        err: String(err),
      }),
    );
  }
}

/**
 * `$addToSet` with `$each`, via a raw command for the same reason ensureBaseline
 * uses one: Prisma's Mongo connector cannot express $addToSet, and its `push`
 * does not dedupe (I-13 forbids it). NOT inside a $transaction, so the "raw
 * commands do not join an interactive transaction" hazard does not apply.
 *
 * The legacy `role` mirror is deliberately NOT updated. Computing it needs the
 * post-write set, which a concurrent revocation can invalidate — and a stale
 * mirror that RE-ADDS a just-revoked role is a privilege-retention bug, whereas
 * an un-updated mirror merely under-privileges the caller on the still-deployed
 * old client. During the dual-write window this path fails closed on purpose;
 * doc 06 deletes the scalar. `$setOnInsert role: ""` still applies (I-9), and
 * it names a path no `$set` here touches (ConflictingUpdateOperators).
 */
async function addRolesAdditive(
  db: PrismaClient,
  userID: string,
  roles: string[],
): Promise<boolean> {
  const res = (await db.$runCommandRaw({
    update: "UserRole",
    updates: [
      {
        q: { userID },
        u: {
          $addToSet: { roles: { $each: roles } },
          $set: { updatedAt: { $date: new Date().toISOString() } },
          $setOnInsert: { role: "" },
        },
        upsert: true,
      },
    ],
    ordered: false,
  })) as unknown as RawUpdateReply;

  // I-8f: INSPECT THE REPLY. $runCommandRaw resolves with
  // { ok: 1, writeErrors: [...] } on a per-write failure rather than throwing,
  // so try/catch alone would report a grant that never applied as success.
  return res.ok === 1 && (res.writeErrors ?? []).length === 0;
}

/** Property 4. Best-effort: a failed stamp only costs one repeated lookup. */
async function stampPendingChecked(
  db: PrismaClient,
  userID: string,
): Promise<void> {
  try {
    await db.userRole.update({
      where: { userID },
      data: { pendingCheckedAt: new Date() },
    });
  } catch {
    // The row may not exist (ensureBaseline failed for an ineligible or
    // partially-created identity). Not worth a retry: the next session read
    // simply re-checks, which is one indexed findUnique.
  }
}

/**
 * Audit rows for redemption. A local copy rather than an import of admin.ts's
 * `writeAudit`: this module is imported by auth.ts, and admin.ts pulls in
 * ../trpc → auth.ts, so importing it here would close a cycle through the
 * NextAuth options object.
 */
async function writeRedemptionAudit(
  db: PrismaClient,
  e: {
    actorUserID: string;
    actorRoles: string[];
    targetUserID: string;
    rolesBefore?: string[];
    rolesAfter?: string[];
    ok: boolean;
    denyReason?: string | null;
    batchId?: string | null;
  },
): Promise<void> {
  try {
    await db.roleAuditLog.create({
      data: {
        actorUserID: e.actorUserID,
        actorRoles: e.actorRoles ?? [],
        targetUserID: e.targetUserID,
        action: "pending.claim",
        rolesBefore: e.rolesBefore ?? [],
        rolesAfter: e.rolesAfter ?? [],
        ok: e.ok,
        denyReason: e.denyReason ?? null,
        batchId: e.batchId ?? null,
      },
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "audit_write_failed",
        action: "pending.claim",
        targetUserID: e.targetUserID,
        error: String(err),
      }),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* D-2 — the server-computed capability set                                    */
/* -------------------------------------------------------------------------- */

/**
 * The capability set. Computed ONCE, server-side, from the caller's live roles.
 * The dashboard renders off this object and branches on NOTHING else.
 *
 * D-2 forbids an `isAdmin` fork. v1 forked in seven independent places; none
 * was a security hole — the server guards are independent — but seven copies of
 * a policy is how the eighth one gets it wrong.
 *
 * Adding a capability = one field here + one server guard. If you find yourself
 * writing `roles.includes("admin")` in a component, it belongs here.
 */
export type Capabilities = {
  reachDashboard: boolean;
  listUsers: boolean;
  /** Roles this caller may grant, from ASSIGNABLE_BY. D-3: jcrc gets []. */
  assignableRoles: GrantableRole[];
  revocableRoles: GrantableRole[];
  /**
   * I-14. `cca_head` is not an assignable ROLE, so this power cannot be read
   * off assignableRoles — it is a capability in its own right, exercised only
   * through the dedicated CCA endpoints. Per 00-overview.md §3 it belongs to
   * admin AND jcrc.
   */
  manageCcaHeads: boolean;
  /**
   * May reach /cca AT ALL — the CCA head's own surface.
   *
   * COARSE, exactly like reachDashboard: it answers "is this surface for you",
   * NEVER "which CCA". Which ccaID is enforced per request by assertHeadsCca
   * (services/ccaScope.ts), which reads CcaHead directly.
   *
   * The first capability in which `cca_head` appears. That couples the route to
   * CH-1, and it is safe in the failure direction: if the string ever outlives
   * its CcaHead rows, the holder reaches an index whose CONTENT comes from
   * CcaHead — so they see an empty list and every [ccaID] is refused. A stale
   * string yields an empty page, never a leaked roster.
   *
   * THIS IS NOT AN AUTHORIZATION STATEMENT. Do not "optimize" cca.getRoster by
   * trusting it.
   */
  reachCcaDashboard: boolean;
  /** May pick any CCA and read its roster (/admin/ccas). Read-only. */
  viewAnyCcaRoster: boolean;
  /**
   * May create/rename CCAs, manage their heads, and add/remove members
   * (/admin/manage-ccas). Admin only, and additionally behind the
   * `cca.management.enabled` kill switch checked in the procedures.
   *
   * Deliberately NOT a licence to delete: no surface deletes a CCA.
   */
  manageCcas: boolean;
  /**
   * May START and STOP hall-wide CCA recruitment (the `cca.recruitment` flag).
   *
   * Manager-tier (admin + jcrc): running recruitment is JCRC work, and the
   * control lives on /admin/ccas, a tab a jcrc already reaches.
   *
   * `scrc` is deliberately ABSENT. The hall office appoints the JCRC; it does
   * not run recruitment. Granting it here would also drag a hall-wide write
   * onto a surface that is itself behind the unrelated `scrc.enabled` switch,
   * so a hall-office member's ability to freeze recruitment would depend on a
   * flag about something else entirely.
   *
   * NOT `manageCcas` (admin-only): a jcrc must be able to use their own
   * control. NOT folded into `viewAnyCcaRoster`, which is a READ capability —
   * the tab gate and the write gate are different questions and must not share
   * a field, or widening the tab silently widens the freeze.
   *
   * THIS IS NOT A LICENCE TO BYPASS THE FREEZE. Holding it lets you change the
   * flag; it does not exempt you from it. An admin who accepts a member during
   * a freeze is refused exactly like a head — a freeze is an operational state
   * of the hall, not an authorisation tier, and a silent admin exemption would
   * mean the one person most likely to verify the freeze is the one person who
   * cannot observe it working.
   */
  manageCcaRecruitment: boolean;
  /**
   * May act on a user who holds `admin` at all. D-2: admin only.
   *
   * ALSO covers a target whose authority cannot be EVALUATED, which is the same
   * question asked of a row this deploy cannot key: an account with no canonical
   * id may still carry a pre-cutover `UserRole` holding `admin`, filed under the
   * unanchored derivation auth.ts used before the eligibility cutover. That is
   * why assertMayManageUserProfileOf refuses every non-admin actor on such a
   * target (CANNOT_MODIFY_AN_UNKEYED_ACCOUNT) — read that function for the full
   * argument — and why UserRoleTable disables its Details button on this
   * capability for those rows rather than letting a jcrc click into a FORBIDDEN
   * that also writes a `denied` audit row. One tier, one statement: unevaluable
   * authority is treated as admin authority.
   */
  modifyAdmins: boolean;
  /** May see WHO holds admin (counts and identities). D-2: admin only. */
  seeAdminIdentities: boolean;
  bulkAssign: boolean;
  createPendingGrants: boolean;
  undoBulkImport: boolean;
  readAuditLog: boolean;
  manageFacilityAccess: boolean;
  /** Aggregate health counts. Per-user identifier lists are admin-only. */
  viewSystemHealth: boolean;
  viewSystemHealthDetail: boolean;
  manageEnforcementFlag: boolean;
  /**
   * May review submitted events and approve / request changes / decline them
   * (the /admin/events tab). Manager-level (admin + jcrc), matching the JCRC
   * review role. Heads reach their OWN events surface via reachCcaDashboard +
   * per-event assertHeadsCca, not this.
   */
  reviewEvents: boolean;
  /**
   * May AUTHOR a HALL-WIDE event — one with `Event.ccaID == null`, owned by the
   * JCRC rather than by any CCA. Read by loadOwnedEvent (routers/event.ts) as
   * the null arm of the ownership branch, by `create` when no ccaID is supplied,
   * and by listForOwner's hall branch.
   *
   * `scrc` IS DELIBERATELY ABSENT. The hall office's whole events reach is
   * `viewEventsReadOnly`, described in its own comment as "view events,
   * read-only". Authorship is not read-only, and oversightProcedure must not
   * gain a write.
   *
   * A SEPARATE FIELD RATHER THAN REUSING `reviewEvents`, even though the two are
   * the same tier today. Reviewing and authoring are different powers over the
   * same object; sharing one field means the day someone widens the review queue
   * by one role, they hand out hall-wide authorship as a side effect. Same
   * argument as keeping manageCcaRecruitment off manageCcas.
   */
  manageHallEvents: boolean;
  /**
   * May open a user's detail record and EDIT their profile fields
   * (displayName / block / telegramHandle / bio / matric). Manager-level:
   * fixing a resident's onboarding data is JCRC work. It is NOT a licence to
   * reach any target — assertMayManageUserProfileOf (G3) is applied by EVERY
   * procedure in routers/userAdmin.ts, the `get` read included, so a jcrc
   * cannot open an admin's record. That read carries matric, telegramHandle
   * and bio, none of which is in the listUsers projection, which is why the
   * guard is on the read and not only on the writes; the enumeration cost that
   * buys, and why it was accepted, is argued once on
   * assertMayManageUserProfileOf. Do not restate it here — and do not describe
   * this capability's reach from memory, read that function.
   *
   * Deliberately NOT a role-editing capability: roles stay behind
   * setUserRoles / grantCcaHead and their own guards.
   */
  manageUserProfiles: boolean;
  /**
   * May DELETE an account. Admin only, and additionally behind the
   * admin.userDelete.enabled kill switch checked in the procedure. Joins
   * manageFacilityAccess / readAuditLog / manageCcas in the admin-only tier
   * because it is the only irreversible write in the admin surface.
   */
  deleteUsers: boolean;

  /* ---- Hall Office / SCRC (scrc) ---------------------------------------- */

  /**
   * May reach /scrc AT ALL — the hall office's own surface.
   *
   * COARSE, exactly like reachDashboard and reachCcaDashboard: it answers "is
   * this surface for you", never "may you do the thing on it". Every procedure
   * the page calls re-asserts its own capability and the `scrc.enabled` switch.
   *
   * DELIBERATELY NOT reachDashboard. /scrc is a top-level route with its own
   * layout precisely so that `scrc` never needs reachDashboard, which would
   * drag in AdminShell, the manager-only admin.getStats overview, and every
   * /admin/* child layout that trusts its parent.
   */
  reachScrcDashboard: boolean;
  /**
   * May list, grant and revoke `jcrc` through the /scrc surface — appointing
   * the JCRC is the hall office's job.
   *
   * This is the capability form of ASSIGNABLE_BY.scrc = ["jcrc"], not a second
   * source of truth: the actual write still goes through assertCanMutateRoles
   * and applyRoleChange, which re-read the actor's roles live (I-5) and consult
   * the maps. This field only gates reaching the three procedures.
   *
   * It is NOT `listUsers`. admin.listUsers pages the whole hall; the hall
   * office gets admin.listJcrcRoster (the jcrc roster only, admins filtered
   * OUT rather than redacted) plus a one-identifier-in, one-person-out
   * resolver, which is the narrowest pair that supports both grant and revoke.
   */
  manageJcrcRoster: boolean;
  /**
   * May read ANY CCA's roster (heads + members), read-only.
   *
   * Deliberately a SECOND capability rather than widening `viewAnyCcaRoster`,
   * which gates /admin/ccas — a page that also manages CCA heads. Consulted
   * only by `assertMayViewCcaRoster`. Do NOT pass it to `assertHeadsCca`.
   *
   * NEVER a licence to WRITE a roster, and never a licence to read PII.
   * "Roster" here means NAMES, headship and grant dates — and holding this
   * capability alone is NOT what makes that true. A raw roster carries every
   * member's email, stored userID and raw membership keys (mostly A-format
   * matric numbers), so cca.getRoster and cca.listHeads REDACT those away on
   * the `via: "readOnly"` branch; without that, a holder who can enumerate all
   * 89 CCAs would reassemble most of admin.listUsers plus a pile of matrics
   * from a capability whose name says read-only. cca.memberDirectory
   * (matric/telegram/bio) is not reachable from here at all — it stays on
   * assertHeadsCca.
   *
   * So: this field opens a DOOR, and the two procedures behind it decide what
   * walks through. Any third procedure that adopts assertMayViewCcaRoster
   * inherits the same obligation.
   */
  viewCcaRostersReadOnly: boolean;
  /**
   * May read events of ANY status, including submitted and unpublished ones,
   * through event.listForOversight / getForOversight.
   *
   * NEVER `reviewEvents`. The approve/reject mutation stays on
   * roleManagerProcedure AND re-checks reviewEvents live, so this field cannot
   * reach it even by accident. No attendee data is exposed by either oversight
   * procedure — that is event.exportAttendees, which is head-scoped.
   */
  viewEventsReadOnly: boolean;
};

export function computeCapabilities(roles: readonly string[]): Capabilities {
  const admin = roles.includes(ADMIN_ROLE);
  const manager = admin || roles.includes(JCRC_ROLE);
  // Hall office. Deliberately NOT folded into `manager`: `scrc` must compute
  // FALSE for every manager-tier field below, and the only safe way to
  // guarantee that is for `manager` to stay literally `admin || jcrc`.
  const scrc = roles.includes(SCRC_ROLE);
  return {
    reachDashboard: manager,
    listUsers: manager,
    // Derived from the maps, so D-3 and I-14 are expressed once, here in
    // roles.ts, and propagate everywhere. Note `admin` is ABSENT for jcrc
    // rather than rendered-disabled: do not leak the ladder.
    assignableRoles: [...assignableBy(roles)],
    revocableRoles: [...revocableFromOthersBy(roles)],
    manageCcaHeads: manager,
    // CCA_HEAD_ROLE's first appearance in a capability. Managers are included
    // so an admin who also heads a CCA still reaches their own surface.
    reachCcaDashboard: manager || roles.includes(CCA_HEAD_ROLE),
    viewAnyCcaRoster: manager,
    manageCcas: admin,
    modifyAdmins: admin,
    seeAdminIdentities: admin,
    bulkAssign: manager,
    createPendingGrants: manager,
    undoBulkImport: manager,
    readAuditLog: admin,
    manageFacilityAccess: admin,
    viewSystemHealth: manager,
    viewSystemHealthDetail: admin,
    manageEnforcementFlag: admin,
    reviewEvents: manager,
    // Authoring the JCRC's own hall-wide events. `manager`, matching
    // reviewEvents exactly today — the two are kept as separate FIELDS so that
    // widening one later does not silently widen the other. `scrc` is absent by
    // design: see the Capabilities declaration.
    manageHallEvents: manager,
    // The hall-wide recruitment freeze. `manager`, not `admin`: the JCRC runs
    // recruitment, so gating their own control behind admin would make the
    // feature useless to the people it is for.
    manageCcaRecruitment: manager,
    manageUserProfiles: manager,
    deleteUsers: admin,
    // SCRC_ROLE's first appearance in a capability. Admin is included in all
    // four so an admin can exercise and inspect the hall-office surface
    // without holding the role; `manager` in the two read-only fields is a
    // WIDENING OF NOTHING — admin and jcrc already reach both surfaces through
    // manageCcaHeads / reviewEvents, so those two fields are additive for
    // `scrc` and behaviour-identical for everyone else.
    reachScrcDashboard: admin || scrc,
    manageJcrcRoster: admin || scrc,
    viewCcaRostersReadOnly: manager || scrc,
    viewEventsReadOnly: manager || scrc,
  };
}

/* -------------------------------------------------------------------------- */
/* Compile-time proof for the profile gate's exemption list                    */
/* -------------------------------------------------------------------------- */

/**
 * `src/lib/profileCompleteness.ts` names the roles that are exempt from the
 * strict profile gate. It CANNOT import SCRC_ROLE from this file — it is
 * value-imported by `"use client"` components and must stay server-import-free —
 * so it duplicates the role string as a key of MINIMAL_PROFILE_ROLES.
 *
 * THIS LINE IS WHAT MAKES THAT DUPLICATION SAFE. Typing the key list as
 * `readonly Role[]` turns a typo ("srcc") or an invented role ("hall_office")
 * into a `tsc --noEmit` error at build time. Without it the exemption would be
 * SILENTLY INERT: the gate would keep holding the hall office, the symptom would
 * be "they are still stuck at /profile", and nothing anywhere would point at the
 * misspelled key.
 *
 * The import is safe in the other direction too: `~/lib/profileCompleteness` has
 * no server imports at all (no Prisma, no `~/env`, no `next/server`), so this
 * file stays runtime-pure exactly as its header requires — the same reasoning
 * that already permits the `~/lib/identity` import at the top.
 *
 * NOTE THE CAST, WHICH IS TO `keyof typeof` AND NOT TO `Role[]`. Writing
 * `Object.keys(MINIMAL_PROFILE_ROLES) as Role[]` — the obvious form — would be
 * INERT: it asserts the conclusion instead of checking it, and a misspelled key
 * would compile clean. Casting to the object's OWN key union and then ASSIGNING
 * that to `readonly Role[]` is what makes the compiler do the work: the
 * assignment fails if any key is not a member of ROLES.
 */
import { MINIMAL_PROFILE_ROLES } from "~/lib/profileCompleteness";
const _minimalRolesAreRealRoles: readonly Role[] = Object.keys(
  MINIMAL_PROFILE_ROLES,
) as (keyof typeof MINIMAL_PROFILE_ROLES)[];
// Referenced so `@typescript-eslint/no-unused-vars` stays quiet without an
// eslint-disable comment. Same escape hatch as `void KILL_SWITCH_NOTE` in
// src/server/api/routers/ccaAdmin.ts. The declaration above is the assertion;
// this statement only keeps it alive.
void _minimalRolesAreRealRoles;
