/**
 * THE ROLE NAME STRINGS, and nothing else.
 *
 * PURE. Imports nothing at all, so a `"use client"` component can value-import
 * these without dragging the server tree into the browser bundle.
 * `src/server/api/services/roles.ts` — which holds the actual authorization
 * machinery — imports Prisma and `~/env` at module scope and therefore CANNOT be
 * imported from a client component; the repo documents that consequence in
 * `services/eventQr.ts` and `AuditLogTable.tsx`.
 *
 * `services/roles.ts` RE-EXPORTS these rather than declaring its own, so there
 * is exactly one definition of each string in the codebase. A second copy would
 * be a role name that can drift — and a drifted role name does not fail loudly,
 * it silently stops matching, which reads as "this user has no permissions".
 *
 * NOTHING HERE IS AN AUTHORIZATION CHECK. These are labels. Every decision about
 * what a role may do lives in `services/roles.ts` (capabilities, grant guards)
 * and in the tRPC procedure builders. A client component may use these to decide
 * what to DRAW; it may never use them to decide what is ALLOWED — see I-7.
 */

export const ADMIN_ROLE = "admin" as const;
export const JCRC_ROLE = "jcrc" as const;
export const CCA_HEAD_ROLE = "cca_head" as const;
export const SCRC_ROLE = "scrc" as const;
export const BASELINE_ROLE = "resident" as const;
