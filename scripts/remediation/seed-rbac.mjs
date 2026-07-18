/**
 * SUPERSEDED — DO NOT RUN. This script is a live hazard and now refuses to
 * execute.
 *
 * It wrote the LEGACY SINGULAR shape: `db.userRole.upsert({ userID, role })`
 * and `db.facilityAccess.upsert({ facilityID, requiredRole })`, with NO `roles`
 * / `requiredRoles` array. Under RBAC v2 one run creates a roles-less document,
 * and once the legacy reads are removed that user reads as ZERO roles and
 * silently loses `admin` or `jcrc`. The containment gate has already passed by
 * then, so nothing catches it. It also hardcoded an 11-id jcrc grant list and
 * resolved the restricted facility BY NAME, which under D-1 means a rename
 * LOCKS a room rather than opening it.
 *
 * Its logic has been moved, not lost:
 *   - the 11 JCRC ids  -> scripts/remediation/data/jcrc-users.json
 *   - the bookingID counter seed (the ONLY place this existed)
 *                      -> scripts/remediation/seed-counters.mjs
 *   - role + facility seeding
 *                      -> scripts/remediation/seed-roles-v2.mjs
 *
 * See docs/plans/rbac/01-data-model.md Step 9 and 06-legacy-cutover.md §5 step 2.
 *
 * The file is retained rather than deleted so that a stale shell history entry,
 * a stale README link or a stale runbook line hits THIS message instead of a
 * "command not found" that invites someone to go looking for the old file in
 * git history and run that copy instead.
 */
console.error(`
*** seed-rbac.mjs is SUPERSEDED and will not run. ***

It writes the legacy singular role shape with no roles[] array, which silently
strips privileges once the legacy reads are removed.

Use instead:
    node scripts/remediation/seed-roles-v2.mjs            # dry run
    node scripts/remediation/seed-roles-v2.mjs --commit   # apply
    node scripts/remediation/seed-counters.mjs --commit   # the bookingID counter

Roster:   scripts/remediation/data/jcrc-users.json
Gating:   scripts/remediation/data/facility-roles.json
Runbook:  docs/plans/rbac/01-data-model.md
`);
process.exit(1);
