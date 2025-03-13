import { z } from "zod";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

export const eventRouter = createTRPCRouter({
  create: protectedProcedure
    .input(
      z.object({
        location: z.string(),
        slot: z.date(),
        description: z.string(),
        signUpLink: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.auth.userId) throw new Error("User not authenticated");
      const event = await ctx.db.event.create({
        data: {
          ...input,
          organiserId: ctx.auth.userId,
        },
      });
      return event;
    }),

  delete: protectedProcedure
    .input(z.number())
    .mutation(async ({ ctx, input }) => {
      // Fetch the event to verify ownership.
      const event = await ctx.db.event.findUnique({
        where: { id: input },
      });
      if (!event) {
        throw new Error("Event not found");
      }
      if (event.organiserId !== ctx.auth.userId) {
        throw new Error("Not authorized to delete this event");
      }
      return await ctx.db.event.delete({
        where: { id: input },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.number(),
        location: z.string().optional(),
        slot: z.date().optional(),
        description: z.string().optional(),
        signUpLink: z.string().url().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the event exists and belongs to the current user
      const event = await ctx.db.event.findUnique({
        where: { id: input.id },
      });
      if (!event) {
        throw new Error("Event not found");
      }
      if (event.organiserId !== ctx.auth.userId) {
        throw new Error("Not authorized to update this event");
      }
      const updatedEvent = await ctx.db.event.update({
        where: { id: input.id },
        data: {
          // Only update the fields provided in the input
          location: input.location,
          slot: input.slot,
          description: input.description,
          signUpLink: input.signUpLink,
        },
      });
      return updatedEvent;
    }),

  getAll: publicProcedure.query(async ({ ctx }) => {
    return await ctx.db.event.findMany();
  }),
});
