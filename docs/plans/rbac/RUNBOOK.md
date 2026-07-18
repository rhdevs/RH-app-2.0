# RBAC v2 — Migration Runbook

> Generated from the implementation pass. Every writer is dry-run by default.
> Nothing in here has been run. All of it touches production.

RBAC v2 — ORDERED RUNBOOK. Every writer is dry-run by default; `--commit` and `APPLY=yes` are equivalent. Run all commands from the repo root.

=== PHASE 1 ===

0. Backups + PII guard (already applied by this task, re-verify)
   git check-ignore -v scripts/remediation/backups/
   git log --all --oneline -- scripts/remediation/backups/     # MUST be empty
   Take an Atlas snapshot if the cluster tier supports it (M0/M2/M5 do NOT —
   check first; if not, the JSON dumps below are your ONLY backup).

1. Parity gate (pure, no DB)
   node scripts/remediation/verify-identity-parity.mjs         # must exit 0

2. INVENTORY — read-only, covers doc-01 Steps 1/3/4/5
   node scripts/remediation/inventory-rbac.mjs --admin-email <you>@u.nus.edu
   Exits 1 ONLY on Step-4 orphans. Triage every warning with the user before
   step 4 below. Act on:
     missingPasswordHash > 0  -> add `passwordHash String?` to the Step 7 diff
     canonicalCollisions > 0  -> resolve BEFORE the resident backfill
     nonNus > 0               -> hand-review; if YOUR admin is listed, STOP

3. Re-key remediation — ONLY if step 2 reported orphans
   node scripts/remediation/rekey-canonical.mjs
   node scripts/remediation/rekey-canonical.mjs --commit
   node scripts/remediation/inventory-rbac.mjs                 # until zero orphans

4. Array backfill — MUST run BEFORE db push (I-3)
   node scripts/remediation/backfill-roles-v2.mjs
   node scripts/remediation/backfill-roles-v2.mjs --commit
   Both VERIFY counts must be 0.

5. Schema push (schema edit is already done)
   npx prisma db push && npx prisma generate && npx tsc --noEmit
   A --accept-data-loss prompt here means STOP.

6. Classify the facility gating
   Copy "facilityRolesTemplate" from the step-2 report into
   scripts/remediation/data/facility-roles.json, classify each room, have a
   SECOND PERSON review, then set _reviewedBy / _reviewedAt.
   The seed REFUSES to commit while _reviewedBy is null.

7. Seed roles + facility access
   node scripts/remediation/seed-roles-v2.mjs                  # REVIEW THIS
   node scripts/remediation/seed-roles-v2.mjs --commit
   node scripts/remediation/seed-counters.mjs --commit
   The dry run is the LAST human checkpoint on room gating.

8. Resident backfill (AUTHORITATIVE)
   node scripts/remediation/backfill-resident.mjs
   node scripts/remediation/backfill-resident.mjs --commit
   # if it exits 1 with a MISSING list:
   ONLY=backups/resident-backfill-missing.json node scripts/remediation/backfill-resident.mjs --commit
   Must reach: MISSING 0, writeErrors 0, collisions 0, missing legacy 'role' 0.

9. Kill switch — BEFORE any Phase 2 code deploys
   node scripts/remediation/set-enforcement.mjs off --commit
   Also add RBAC_BOOKING_ENFORCEMENT (default "off") to src/env.js.

10. Smoke + health
    node scripts/remediation/smoke-rbac.mjs
    node scripts/remediation/rbac-doctor.mjs
    All green except `enforcement mode: off`. Run rbac-doctor DAILY from here.

=== THE FLIP ===

11. Immediately before flipping past "off" (doc-01 Step 12b):
    node scripts/remediation/backfill-resident.mjs --commit
    REQUIRED: `MISSING 0` AND `modified 0  upserted 0`.
    MISSING 0 alone is NOT sufficient — non-zero modified/upserted means a
    creation-time grant point is broken. Block the flip and find which one.

12. node scripts/remediation/set-enforcement.mjs permissive --commit
    Soak. Watch rbac-doctor's "shadow denials, last 24h".
13. node scripts/remediation/set-enforcement.mjs enforce --commit

=== LEGACY CUTOVER (doc 06) — steps 15-18 are the one-way door ===

14. At the START of the window:
    node scripts/remediation/clear-resident-mirror.mjs
    node scripts/remediation/clear-resident-mirror.mjs --commit
    Also fix setFacilityAccess to use legacyMirror(), not requiredRoles[0].

15. THE GATE — run WHILE THE DUAL-WRITE IS STILL DEPLOYED (before 5c):
    node scripts/remediation/verify-legacy-drop.mjs
    Must exit 0. Writes backups/gate-pass-<ISO>.json.
    NEVER re-run this as a gate after the dual-write is removed — it reports
    false failures on legitimately stale scalars.

16. Deploy cutover step 3 (remove legacy READS) — AFTER a passing gate.
    Deploy cutover step 4 (remove legacy WRITES). Same maintenance window as 17.

17. node scripts/remediation/backup-role-collections.mjs
    Record the six printed counts in the go/no-go checklist.
    Then the schema drop: npx prisma db push (--accept-data-loss is EXPECTED
    here and only here; confirm it names only role and requiredRole).

18. THE DROP (within 2h of step 17's snapshot):
    node scripts/remediation/drop-legacy-role-fields.mjs                     # dry run
    APPLY=yes CONFIRM=drop-legacy node scripts/remediation/drop-legacy-role-fields.mjs
    Re-run the counts at +24h and +72h. A login-path writer will not show up
    immediately — "0 / 0" now is necessary, not sufficient.

=== RECOVERY (only under a Phase-2 revert) ===

    Hand-edit prisma/schema.prisma back to `role String?` / `requiredRole
    String?` and db push FIRST. NEVER git checkout the pre-v2 schema.
    node scripts/remediation/restore-legacy-scalars.mjs
    node scripts/remediation/restore-legacy-scalars.mjs --commit
    node scripts/remediation/restore-legacy-scalars.mjs --forensics <snapshot.json>
    Rebuilds the scalar from the LIVE roles[] (rule R1), never from the
    snapshot — copying snapshot scalars would re-grant revoked privileges.

DEAD: scripts/remediation/seed-rbac.mjs now exits 1 with a SUPERSEDED message.