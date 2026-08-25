import { postRouter } from "~/server/api/routers/post";
import { facilityBookingRouter } from "~/server/api/routers/facilitiesBooking";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";
import { userRouter } from "./routers/user";
import { adminRouter } from "./routers/admin";
import { ccaRouter } from "./routers/cca";
import { ccaAdminRouter } from "./routers/ccaAdmin";
import { ccaApplicationsRouter } from "./routers/ccaApplications";
import { ccaApplicationsHeadRouter } from "./routers/ccaApplicationsHead";
import { ccaRecruitmentRouter } from "./routers/ccaRecruitment";
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
  /**
   * The JCRC's hall-wide recruitment freeze (admin + jcrc). Two procedures over
   * ONE SystemFlag row; it does not enforce anything itself — the gate is five
   * assertRecruitmentOpen calls across the two routers above: two in
   * submitApplication and two in bookSlot (each a fail-fast check plus the
   * load-bearing one inside the lock), and one on the accepted branch of the
   * head's decide. Applying, booking an interview and accepting are the three
   * points at which the pool grows.
   *
   * Note it is deliberately NOT behind `cca.applications.enabled` the way those
   * two are: turning the applications feature off entirely and freezing
   * recruitment are different statements, and a JCRC must be able to reopen
   * recruitment even while an admin has the whole feature switched off.
   * See services/ccaRecruitment.ts for the open-by-default reasoning.
   */
  ccaRecruitment: ccaRecruitmentRouter,
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
