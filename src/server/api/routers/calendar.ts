import { monthGrid } from "~/lib/calendar/month";
import { calendarMonthInput } from "~/lib/schemas/calendar";
import {
  createTRPCRouter,
  identifiedProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";
import { areEventsEnabled } from "~/server/api/services/events";
import {
  assertCalendarFeedEnabled,
  isCalendarFeedEnabled,
} from "~/server/api/services/calendar/flag";
import {
  readProposalLayer,
  readPublishedEvents,
} from "~/server/api/services/calendar/read";
import {
  assertFeedWithinLimit,
  createFeedToken,
  feedTokenStatus,
  revokeFeedToken,
  rotateFeedToken,
} from "~/server/api/services/calendar/token";

type Layer<T> =
  | { state: "off" }
  | { state: "error" }
  | { state: "ok"; items: T[] };

/** Log the kind of failure only; a driver message can carry stored values. */
function logLayerFailure(layer: string, err: unknown): void {
  console.error(
    JSON.stringify({
      evt: "calendar_layer_read_failed",
      layer,
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
}

/** Never throws: a failed layer is a state the page draws as an error. */
async function layer<T>(
  name: string,
  read: () => Promise<T[] | null>,
): Promise<Layer<T>> {
  try {
    const items = await read();
    return items === null ? { state: "off" } : { state: "ok", items };
  } catch (err) {
    logLayerFailure(name, err);
    return { state: "error" };
  }
}

/**
 * The calendar page and the personal feed's link.
 *
 * `month` reads two layers separately. A failed proposal read is an error on
 * that layer only: the Events still draw. Neither layer is an empty list when
 * its read failed. The token procedures check `calendar.feed.enabled` first,
 * through one gated builder, and fail closed (a failed flag read is off).
 * They only ever touch the caller's own token: no input names a user. The
 * token comes back once, from create and rotate, and is never readable again.
 */
const feedProcedure = identifiedProcedure
  .use(sanitizeErrors)
  .use(async ({ ctx, next }) => {
    await assertCalendarFeedEnabled(ctx.db);
    return next();
  });

export const calendarRouter = createTRPCRouter({
  month: identifiedProcedure
    .input(calendarMonthInput)
    .query(async ({ ctx, input }) => {
      const grid = monthGrid(input.year, input.month);
      const userID = ctx.session.user.userID;
      const [events, proposals] = await Promise.all([
        layer("events", async () =>
          (await areEventsEnabled(ctx.db))
            ? (await readPublishedEvents(ctx.db, grid.from, grid.to)).map(
                (e) => ({
                  eventID: e.eventID,
                  owner: e.owner,
                  title: e.title,
                  location: e.location,
                  startTime: e.startTime,
                  endTime: e.endTime,
                }),
              )
            : null,
        ),
        layer("proposals", async () => {
          const items = await readProposalLayer(
            ctx.db,
            userID,
            grid.from,
            grid.to,
          );
          return (
            items?.map((p) => ({
              id: p.id,
              ccaID: p.ccaID,
              owner: p.owner,
              title: p.title,
              status: p.status,
              viewer: p.viewer,
              plannedStart: p.plannedStart,
              plannedEnd: p.plannedEnd,
            })) ?? null
          );
        }),
      ]);
      return { days: grid.days, events, proposals };
    }),

  /** The settings panel asks this. Never throws on off. */
  feedStatus: identifiedProcedure.query(async ({ ctx }) => {
    if (!(await isCalendarFeedEnabled(ctx.db))) {
      return { enabled: false as const };
    }
    return {
      enabled: true as const,
      ...(await feedTokenStatus(ctx.db, ctx.session.user.userID)),
    };
  }),

  feedCreate: feedProcedure.mutation(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    await assertFeedWithinLimit("create", userID);
    return createFeedToken(ctx.db, userID);
  }),

  feedRotate: feedProcedure.mutation(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    await assertFeedWithinLimit("rotate", userID);
    return rotateFeedToken(ctx.db, userID);
  }),

  feedRevoke: feedProcedure.mutation(async ({ ctx }) => {
    const userID = ctx.session.user.userID;
    await assertFeedWithinLimit("revoke", userID);
    await revokeFeedToken(ctx.db, userID);
    return { revoked: true as const };
  }),
});
