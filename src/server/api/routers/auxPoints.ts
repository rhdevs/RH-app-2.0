import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import { createTRPCRouter, roleManagerProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { computeCapabilities } from "~/server/api/services/roles";
import { AUX_TEXT_MAX } from "~/lib/auxPoints";
import { isValidAcademicYear } from "~/lib/transcript/academicYear";
import { escapeRegex } from "~/server/api/services/transcript/residents";
import { auxPeople } from "~/server/api/services/auxPoints/people";
import {
  auxDetail,
  auxEventsOf,
  auxTotals,
  auxYears,
} from "~/server/api/services/auxPoints/totals";
import {
  readAuxYear,
  readAuxYearStartedAt,
  sgtIsoDate,
} from "~/server/api/services/auxPoints/year";
import {
  addEventAttendees,
  addRecordAttendees,
  createAward,
  createRecord,
  deleteAward,
  deleteRecord,
  importAwards,
  removeEventAttendee,
  removeRecordAttendee,
  setEventAux,
  updateAward,
  updateRecord,
  type AuxActor,
} from "~/server/api/services/auxPoints/writes";

/**
 * AUX: hall participation counted towards points (proposal Part 3). JCRC only,
 * through the same capability as the points settings (`manageCcaPointsRanges`,
 * admin + jcrc), re-checked with a live role read on every call. CCA heads
 * never reach this router, so they cannot flag an event or touch a count.
 *
 * Writes live in services/auxPoints/writes.ts: each is audited and refused for any
 * year but the current points year.
 */

const FORBIDDEN_CAPABILITY = "CAPABILITY_REQUIRED:manageCcaPointsRanges";

async function requireAux(db: PrismaClient, userID: string): Promise<string[]> {
  const roles = await getUserRoles(db, userID); // I-5 live read
  if (!computeCapabilities(roles).manageCcaPointsRanges) {
    throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_CAPABILITY });
  }
  return roles;
}

/** A procedure that has passed the live capability check, with the actor. */
const auxProcedure = roleManagerProcedure.use(async ({ ctx, next }) => {
  const userID = ctx.session.user.userID;
  const roles = await requireAux(ctx.db, userID);
  const actor: AuxActor = { userID, roles, now: new Date() };
  return next({ ctx: { ...ctx, actor } });
});

const year = z.string().refine(isValidAcademicYear, "AUX_BAD_YEAR");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = z.string().trim().min(1).max(AUX_TEXT_MAX);
const pasted = z.string().max(50_000);
const eventID = z.number().int().positive();
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const userID = z.string().min(1).max(200);
const award = {
  amount: z.number().int(),
  reason: text,
  awardedOn: isoDate,
};

export const auxRouter = createTRPCRouter({
  /** Each resident's AUX for a year (the current points year by default). */
  overview: auxProcedure
    .input(z.object({ year: year.optional() }))
    .query(async ({ ctx, input }) => {
      const current = await readAuxYear(ctx.db, ctx.actor.now);
      const shown = input.year ?? current;
      const [years, totals] = await Promise.all([
        auxYears(ctx.db, current),
        auxTotals(ctx.db, shown),
      ]);
      return {
        year: shown,
        current,
        readOnly: shown !== current,
        years,
        totals,
      };
    }),

  /** Where one resident's AUX came from. */
  detail: auxProcedure
    .input(z.object({ year, userID }))
    .query(({ ctx, input }) => auxDetail(ctx.db, input.year, input.userID)),

  /** The year's AUX events and record-only events, with list sizes. */
  sources: auxProcedure
    .input(z.object({ year }))
    .query(async ({ ctx, input }) => {
      const [events, records] = await Promise.all([
        auxEventsOf(ctx.db, input.year),
        ctx.db.auxRecord.findMany({
          where: { academicYear: input.year },
          orderBy: { heldOn: "desc" },
        }),
      ]);
      const [checkIns, attendees] = await Promise.all([
        events.length === 0
          ? Promise.resolve([])
          : ctx.db.eventAttendance.findMany({
              where: { eventID: { in: events.map((e) => e.eventID) } },
              select: { eventID: true },
            }),
        ctx.db.auxRecordAttendee.findMany({
          where: { academicYear: input.year },
          select: { recordID: true },
        }),
      ]);
      const count = <K>(rows: { k: K }[]) => {
        const m = new Map<K, number>();
        for (const r of rows) m.set(r.k, (m.get(r.k) ?? 0) + 1);
        return m;
      };
      const perEvent = count(checkIns.map((c) => ({ k: c.eventID })));
      const perRecord = count(attendees.map((a) => ({ k: a.recordID })));
      return {
        events: events.map((e) => ({
          eventID: e.eventID,
          title: e.title ?? `Event #${e.eventID}`,
          startTime: e.startTime,
          status: e.status,
          attendees: perEvent.get(e.eventID) ?? 0,
        })),
        records: records.map((r) => ({
          id: r.id,
          title: r.title,
          heldOn: sgtIsoDate(r.heldOn),
          attendees: perRecord.get(r.id) ?? 0,
        })),
      };
    }),

  /**
   * Events JCRC may flag as AUX: any CCA's or the hall's, not cancelled or
   * declined, not already AUX. Matches the title; newest first.
   */
  flaggable: auxProcedure
    .input(z.object({ query: z.string().trim().max(80).default("") }))
    .query(async ({ ctx, input }) => {
      const current = await readAuxYear(ctx.db, ctx.actor.now);
      const startedAt = await readAuxYearStartedAt(ctx.db);
      // Not AUX yet, or flagged for an earlier year but held in this one
      // (setEventAux moves those).
      const movable = startedAt
        ? [
            {
              auxYear: { not: current },
              startTime: { gte: Math.floor(startedAt.getTime() / 1000) },
            },
          ]
        : [];
      return ctx.db.event.findMany({
        where: {
          OR: [{ auxYear: null }, { auxYear: { isSet: false } }, ...movable],
          status: { notIn: ["canceled", "declined"] },
          ...(input.query
            ? {
                title: {
                  contains: escapeRegex(input.query),
                  mode: "insensitive" as const,
                },
              }
            : {}),
        },
        select: {
          eventID: true,
          title: true,
          startTime: true,
          status: true,
          auxYear: true,
        },
        orderBy: { startTime: "desc" },
        take: 25,
      });
    }),

  setEventAux: auxProcedure
    .input(z.object({ eventID, aux: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setEventAux(ctx.db, ctx.actor, input.eventID, input.aux),
    ),

  /** An AUX event's attendance list. */
  eventAttendees: auxProcedure
    .input(z.object({ eventID }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.event.findUnique({
        where: { eventID: input.eventID },
        select: { auxYear: true },
      });
      if (!event?.auxYear) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "NOT_AN_AUX_EVENT",
        });
      }
      const rows = await ctx.db.eventAttendance.findMany({
        where: { eventID: input.eventID },
        select: { userID: true, method: true, checkedInAt: true },
        orderBy: { checkedInAt: "asc" },
      });
      const people = await auxPeople(
        ctx.db,
        rows.map((r) => r.userID),
      );
      return rows.map((r) => ({
        ...people.get(r.userID)!,
        method: r.method ?? "qr",
        checkedInAt: r.checkedInAt,
      }));
    }),

  addEventAttendees: auxProcedure
    .input(z.object({ eventID, text: pasted }))
    .mutation(({ ctx, input }) =>
      addEventAttendees(ctx.db, ctx.actor, input.eventID, input.text),
    ),

  removeEventAttendee: auxProcedure
    .input(z.object({ eventID, userID }))
    .mutation(({ ctx, input }) =>
      removeEventAttendee(ctx.db, ctx.actor, input.eventID, input.userID),
    ),

  createRecord: auxProcedure
    .input(z.object({ title: text, heldOn: isoDate, text: pasted }))
    .mutation(({ ctx, input }) => createRecord(ctx.db, ctx.actor, input)),

  updateRecord: auxProcedure
    .input(z.object({ id: objectId, title: text, heldOn: isoDate }))
    .mutation(({ ctx, input }) => updateRecord(ctx.db, ctx.actor, input)),

  deleteRecord: auxProcedure
    .input(z.object({ id: objectId }))
    .mutation(({ ctx, input }) => deleteRecord(ctx.db, ctx.actor, input.id)),

  recordAttendees: auxProcedure
    .input(z.object({ id: objectId }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.auxRecordAttendee.findMany({
        where: { recordID: input.id },
        select: { userID: true },
        orderBy: { addedAt: "asc" },
      });
      const people = await auxPeople(
        ctx.db,
        rows.map((r) => r.userID),
      );
      return rows.map((r) => people.get(r.userID)!);
    }),

  addRecordAttendees: auxProcedure
    .input(z.object({ id: objectId, text: pasted }))
    .mutation(({ ctx, input }) =>
      addRecordAttendees(ctx.db, ctx.actor, input.id, input.text),
    ),

  removeRecordAttendee: auxProcedure
    .input(z.object({ id: objectId, userID }))
    .mutation(({ ctx, input }) =>
      removeRecordAttendee(ctx.db, ctx.actor, input.id, input.userID),
    ),

  createAward: auxProcedure
    .input(z.object({ userID, ...award }))
    .mutation(({ ctx, input }) => createAward(ctx.db, ctx.actor, input)),

  importAwards: auxProcedure
    .input(z.object({ text: pasted, reason: text, awardedOn: isoDate }))
    .mutation(({ ctx, input }) => importAwards(ctx.db, ctx.actor, input)),

  updateAward: auxProcedure
    .input(z.object({ id: objectId, ...award }))
    .mutation(({ ctx, input }) => updateAward(ctx.db, ctx.actor, input)),

  deleteAward: auxProcedure
    .input(z.object({ id: objectId }))
    .mutation(({ ctx, input }) => deleteAward(ctx.db, ctx.actor, input.id)),
});
