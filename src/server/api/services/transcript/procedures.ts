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

/** A deliberate error message: a code, not text from a database. */
const DELIBERATE_CODE = /^[A-Z][A-Z0-9_]+$/;

type StepResult = { ok: true } | { ok: false; error: TRPCError };

/**
 * An unexpected error (a raw database error) reaches the caller as "Something
 * went wrong.", and is logged by its code and name only, never its message.
 * A deliberate INTERNAL_SERVER_ERROR (its message is a code, such as
 * OPEN_FAILED) and every other kind of error pass through untouched.
 */
export async function sanitiseInternalErrors<R extends StepResult>({
  next,
  path,
}: {
  next: () => Promise<R>;
  path: string;
}): Promise<R> {
  const result = await next();
  if (
    !result.ok &&
    result.error.code === "INTERNAL_SERVER_ERROR" &&
    !DELIBERATE_CODE.test(result.error.message)
  ) {
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
}

export const transcriptIdentifiedProcedure = identifiedProcedure
  .use(async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  })
  .use(sanitiseInternalErrors);

export const transcriptRoleManagerProcedure = roleManagerProcedure
  .use(async ({ ctx, next }) => {
    await assertTranscriptEnabled(ctx.db);
    return next();
  })
  .use(sanitiseInternalErrors);
