/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { auth } from "~/server/auth";
import { db } from "~/server/db";
import { ADMIN_ROLE, JCRC_ROLE } from "~/server/api/services/roles";
import { isMatricRequired } from "~/server/api/services/access";

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 *
 * This helper generates the "internals" for a tRPC context. The API handler and RSC clients each
 * wrap this and provides the required context.
 *
 * @see https://trpc.io/docs/server/context
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
  const session = await auth();

  return {
    db,
    session,
    ...opts,
  };
};

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get typesafety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */
const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

/**
 * Create a server-side caller.
 *
 * @see https://trpc.io/docs/server/server-side-calls
 */
export const createCallerFactory = t.createCallerFactory;

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    // artificial delay in dev
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  console.log(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(({ ctx, next }) => {
    if (!ctx.session?.user) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    // D-7 backstop for pre-cutover JWTs (02-backend-authz.md §5). session.maxAge
    // is 30 days and the `signIn` callback does not re-run for a live token, so
    // without this an ineligible legacy session keeps every non-role-gated
    // capability — posts, profile mutations, reads — for up to a month.
    //
    // Trusting the session field here is NOT an I-5 violation: `eligible` is
    // derived by the session callback from canonicalUserID(token.email) !== "",
    // a DB-free transform of the token's own email. It is not a role and it is
    // not cached in the token.
    if (!ctx.session.user.eligible) {
      throw new TRPCError({ code: "FORBIDDEN", message: "NUS_ACCOUNT_REQUIRED" });
    }
    return next({
      ctx: {
        // infers the `session` as non-nullable
        session: { ...ctx.session, user: ctx.session.user },
      },
    });
  });

/**
 * Matric-gated procedure.
 *
 * Authenticated AND has a matric number on file (`session.user.hasMatric`,
 * which the auth.ts session callback populates from the UserMatric collection).
 * Use this for app actions that must be blocked until onboarding is complete —
 * e.g. creating/consuming app content (bookings, posts).
 *
 * Do NOT use it for `user.setMatric` / `user.getMatricStatus`: a gated user
 * must still be able to call those to clear the gate. This is the server-side
 * backstop so a hand-crafted API call cannot bypass the client `MatricGate`.
 *
 * I-11: BEHIND ITS OWN KILL SWITCH (`rbac.matric.enforcement`), which defaults
 * to "off". `UserMatric` is a NEW, EMPTY collection with no backfill, so an
 * ungated check denies 100% of the existing population on deploy — bookings,
 * booking EDITS (so nobody can even shorten a booking they already hold) and
 * posts alike. `rbac.booking.enforcement` does not reach this path, so without
 * a switch of its own the only remedy would be a redeploy. See
 * isMatricRequired.
 */
export const matricProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ctx.session.user.hasMatric && (await isMatricRequired(ctx.db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "MATRIC_REQUIRED",
    });
  }
  return next({ ctx });
});

/**
 * Composable matric gate, so role + matric can be layered in either order.
 * Same rule as `matricProcedure`, including the kill switch, expressed as a
 * middleware for callers that build their own chain.
 */
export const requireMatric = t.middleware(async ({ ctx, next }) => {
  if (!ctx.session?.user?.hasMatric && (await isMatricRequired(ctx.db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "MATRIC_REQUIRED" });
  }
  // `next()` with NO argument, deliberately, here and in every middleware below.
  // These are built with `t.middleware`, so their `ctx` parameter is typed as the
  // ROOT context (session nullable). Passing `next({ ctx })` would write that
  // widened type back and undo protectedProcedure's non-null narrowing for every
  // downstream resolver — which is how `ctx.session.user` becomes possibly-null
  // inside a procedure that has already proven it is not.
  return next();
});

/**
 * Error hygiene (02-backend-authz.md §7 "Error hygiene").
 *
 * A raw Prisma error carries collection names, field names and index details.
 * The role surface is reachable by jcrc-level users — students — so an
 * unhandled throw there is an information leak, not just an ugly toast.
 *
 * tRPC has already converted whatever was thrown into a TRPCError by the time
 * this middleware sees the result, so the leak is the MESSAGE, not the shape:
 * anything that arrives as INTERNAL_SERVER_ERROR was not deliberately raised by
 * our own code (every intentional denial uses FORBIDDEN / PRECONDITION_FAILED /
 * CONFLICT / NOT_FOUND / BAD_REQUEST, all of which pass through untouched, as
 * does the zodError attached by the errorFormatter). The real message is logged
 * server-side so the sanitisation does not also destroy the diagnostic.
 */
const sanitizeErrors = t.middleware(async ({ next, path }) => {
  const result = await next();
  if (!result.ok && result.error.code === "INTERNAL_SERVER_ERROR") {
    console.error(
      JSON.stringify({
        evt: "admin_internal_error",
        path,
        error: result.error.message,
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

/**
 * Reusable role middleware. Authenticated AND holds at least one of `allowed`.
 * `admin` implicitly satisfies every role check.
 *
 * Reads ctx.session.user.roles, which the session callback populates with a
 * LIVE database read on every request (I-4), so there is no stale-privilege
 * window. This is deliberately a COARSE gate: it answers "may this caller reach
 * the role surface at all". WHAT a caller may do to WHICH TARGET is enforced
 * per-mutation by assertCanMutateRoles, which re-reads both sides from the
 * database rather than trusting the session (I-5).
 *
 * A middleware, not a pre-built procedure, so it composes:
 * `matricProcedure.use(requireRoles("jcrc"))` works.
 */
export const requireRoles = (...allowed: string[]) =>
  t.middleware(({ ctx, next }) => {
    if (!ctx.session?.user) throw new TRPCError({ code: "UNAUTHORIZED" });
    const roles = ctx.session.user.roles ?? [];
    if (!roles.includes(ADMIN_ROLE) && !allowed.some((r) => roles.includes(r))) {
      throw new TRPCError({ code: "FORBIDDEN", message: "INSUFFICIENT_ROLE" });
    }
    return next();
  });

/**
 * Role procedures build on `protectedProcedure`, NOT `matricProcedure`: an
 * admin fixing someone else's account must not be blocked by their own
 * onboarding state.
 */
export const roleProcedure = (...allowed: string[]) =>
  protectedProcedure.use(sanitizeErrors).use(requireRoles(...allowed));

/** Strictly `admin`. No other role satisfies it — not even via requireRoles. */
export const adminProcedure = protectedProcedure.use(sanitizeErrors).use(
  t.middleware(({ ctx, next }) => {
    if (!(ctx.session?.user?.roles ?? []).includes(ADMIN_ROLE)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "ADMIN_REQUIRED" });
    }
    return next();
  }),
);

/** May reach role management at all: admin or jcrc. The D-2 dashboard gate. */
export const roleManagerProcedure = roleProcedure(JCRC_ROLE);
