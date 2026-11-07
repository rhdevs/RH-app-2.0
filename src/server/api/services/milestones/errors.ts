import { TRPCError } from "@trpc/server";

import { EVIDENCE_NOT_FOUND, MILESTONE_NOT_FOUND } from "./access";
import type { ResolvedMilestone } from "./candidates";

/** The stable strings the screens know (src/app/milestones/_lib/errors.ts). */
export const MILESTONE_NOT_OPEN = "MILESTONE_NOT_OPEN";
export const MILESTONE_CONFLICT = "MILESTONE_CONFLICT";
export const MILESTONE_FROZEN = "MILESTONE_FROZEN";
export const MILESTONE_ALREADY_RATED = "MILESTONE_ALREADY_RATED";
export const MILESTONE_NOTHING_TO_RATE = "MILESTONE_NOTHING_TO_RATE";
export const MILESTONE_TOO_MANY_PHOTOS = "MILESTONE_TOO_MANY_PHOTOS";
export const EVIDENCE_TOO_OLD = "EVIDENCE_TOO_OLD";
export const EVIDENCE_ALREADY_ATTACHED = "EVIDENCE_ALREADY_ATTACHED";
export const EVIDENCE_ATTACH_CONFLICT = "EVIDENCE_ATTACH_CONFLICT";

export const notFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: MILESTONE_NOT_FOUND });

export const evidenceNotFound = () =>
  new TRPCError({ code: "NOT_FOUND", message: EVIDENCE_NOT_FOUND });

export const conflict = (message = MILESTONE_CONFLICT) =>
  new TRPCError({ code: "CONFLICT", message });

/** Only an open milestone takes a write. A canceled one keeps what was filed. */
export function assertOpen(m: ResolvedMilestone): void {
  if (m.state !== "open") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: MILESTONE_NOT_OPEN,
    });
  }
}
