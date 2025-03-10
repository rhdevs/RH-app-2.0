import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { bookingRouter } from "./routers/booking";
import { eventRouter } from "./routers/event";
import { facilityRouter } from "./routers/facility";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  booking: bookingRouter,
  event: eventRouter,
  facility: facilityRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
