import {
  createTRPCRouter,
  publicProcedure,
  protectedProcedure,
} from "~/server/api/trpc";

export const authRouter = createTRPCRouter({
  // Public endpoint: returns a greeting that varies based on authentication status
  hello: publicProcedure.query(async ({ ctx }) => {
    if (ctx.auth && ctx.auth.userId) {
      return { greeting: `Hello, user ${ctx.auth.userId}!` };
    }
    return { greeting: "Hello, guest!" };
  }),

  // Protected endpoint: returns the authenticated user's status
  getAuthStatus: protectedProcedure.query(async ({ ctx }) => {
    // At this point, ctx.auth.userId is guaranteed to exist.
    return {
      userId: ctx.auth.userId,
      message: "You are authenticated",
    };
  }),
});
