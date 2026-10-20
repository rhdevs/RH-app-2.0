import { TRPCError } from "@trpc/server";
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

export const transcriptIdentifiedProcedure = identifiedProcedure
  .use(async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  })
  // identifiedProcedure does not sanitise errors: an unexpected one (a raw
  // database error) reaches the caller as "Something went wrong.", and is
  // logged by its code and name only, never its message.
  .use(async ({ next, path }) => {
    const result = await next();
    if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR") {
      const cause = (result.error.cause ?? result.error) as {
        code?: unknown;
        name?: unknown;
      };
      console.error(
        JSON.stringify({
          evt: "transcript_internal_error",
          path,
          ...(typeof cause.code === "string" && { code: cause.code }),
          name: cause.name,
        }),
      );
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Something went wrong.",
        cause: result.error,
      });
    }
    return result;
  });

export const transcriptRoleManagerProcedure = roleManagerProcedure.use(
  async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  },
);
