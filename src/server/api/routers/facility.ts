import { createTRPCRouter, publicProcedure } from "../trpc";

export const facilityRouter = createTRPCRouter({
  getFacilities: publicProcedure.query(({ ctx }) => {
    return ctx.db.facilities.findMany();
  }),
});
