import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

export const postRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .query(({ input }) => {
      return {
        greeting: `Hello ${input.text}`,
      };
    }),

  // post feature not top priority so not implemented yet
  create: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async () => {
      return null;
    }),

  getLatest: protectedProcedure.query(async ({ ctx }) => {
    const post = ctx.db.posts.findFirst({
      orderBy: { createdAt: "desc" },
      where: { id: ctx.session.user.id },
    });
    return post ?? null;
  }),

  getSecretMessage: protectedProcedure.query(() => {
    return "you can now see this secret message!";
  }),
});
