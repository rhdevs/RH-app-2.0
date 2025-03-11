import z from "zod";
import { clerkClient } from "@clerk/nextjs/server";
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

  getUsername: protectedProcedure.query(async ({ ctx }) => {
    // If you're using protectedProcedure, you should have a valid user session.
    const targetUserId = ctx.auth.userId;
    if (!targetUserId) {
      throw new Error("No user id available");
    }
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(targetUserId);
    return { name: user.username };
  }),

  updateName: protectedProcedure
    .input(
      z.object({
        name: z.string(),
        roomNumber: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // If you're using protectedProcedure, you should have a valid user session.
      const targetUserId = ctx.auth.userId;
      if (!targetUserId) {
        throw new Error("No user id available");
      }
      const clerk = await clerkClient();
      await clerk.users.updateUserMetadata(targetUserId, {
        publicMetadata: {
          name: input.name,
          roomNumber: input.roomNumber,
        },
      });
      return { success: true };
    }),
});
