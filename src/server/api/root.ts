import { postRouter } from "~/server/api/routers/post";
import { facilityBookingRouter } from "~/server/api/routers/facilitiesBooking";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { userRouter } from "./routers/user";
import { adminRouter } from "./routers/admin";
import { ccaRouter } from "./routers/cca";
import { ccaAdminRouter } from "./routers/ccaAdmin";
import { ccaApplicationsRouter } from "./routers/ccaApplications";
import { ccaApplicationsHeadRouter } from "./routers/ccaApplicationsHead";
import { eventRouter } from "./routers/event";
import { userAdminRouter } from "./routers/userAdmin";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  post: postRouter,
  bookings: facilityBookingRouter,
  user: userRouter,
  admin: adminRouter,
  /**
   * Admin CRUD over user DETAILS (the /admin/users detail dialog). Read/update:
   * admin + jcrc, behind the manageUserProfiles capability and the G3 target
   * guard. Delete: admin only, behind deleteUsers AND the default-off
   * admin.userDelete.enabled switch. EMAIL IS IMMUTABLE and ROLES ARE NOT
   * WRITTEN here — admin.setUserRoles / grantCcaHead own them (I-14).
   */
  userAdmin: userAdminRouter,
  /** Object-scoped CCA reads. Guarded per-ccaID, not per-role — see cca.ts. */
  cca: ccaRouter,
  /** Admin-only CCA management, behind the cca.management.enabled switch. */
  ccaAdmin: ccaAdminRouter,
  /** Resident-facing CCA applications, behind the cca.applications.enabled switch. */
  ccaApplications: ccaApplicationsRouter,
  /** CCA-head review/interview/decide, object-scoped by assertHeadsCca. */
  ccaApplicationsHead: ccaApplicationsHeadRouter,
  /** Events: head authoring, JCRC review, resident timeline + signup. Behind
   * the events.enabled switch; object-scoped per event's ccaID. */
  event: eventRouter,
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
