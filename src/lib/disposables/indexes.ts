/**
 * The partial unique index that allows one request per proposal. Created by
 * scripts/remediation/create-disposable-reminder-indexes.mjs (Prisma cannot
 * express a partial unique index, so it is not in the schema).
 */
export const DISPOSABLE_PROPOSAL_INDEX = "disposable_request_proposal_unique";
