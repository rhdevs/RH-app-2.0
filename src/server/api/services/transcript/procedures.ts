import { identifiedProcedure, roleManagerProcedure } from "~/server/api/trpc";
import { assertTranscriptEnabled } from "./flag";

/**
 * The two procedure builders every transcript router starts from: the repo's
 * own builders with the kill switch added AFTER their sign-in and role checks
 * (so a signed-out caller still gets UNAUTHORIZED, and nobody learns the switch
 * state without passing them) and BEFORE anything else, input included. While
 * `transcript.enabled` is not "on", every transcript procedure refuses with
 * FORBIDDEN TRANSCRIPT_DISABLED.
 */

export const transcriptIdentifiedProcedure = identifiedProcedure.use(
  async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  },
);

export const transcriptRoleManagerProcedure = roleManagerProcedure.use(
  async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  },
);
