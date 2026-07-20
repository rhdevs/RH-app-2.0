import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { createTRPCRouter, identifiedProcedure } from "~/server/api/trpc";
import { getUserRoles } from "~/server/api/services/access";
import { assertHeadsCca } from "~/server/api/services/ccaScope";
import { writeAudit } from "~/server/api/routers/admin";
import { addCcaMember, membershipKeysFor } from "~/server/api/services/ccaMembers";
import {
  assertApplicationsEnabled,
  nextCounter,
  SLOT_COUNTER_KEY,
  withCcaLock,
} from "~/server/api/services/ccaApplications";
import {
  addNoteInput,
  cancelSlotInput,
  ccaTargetInput,
  decisionInput,
  editSlotInput,
  headApplicationInput,
  isTerminalStatus,
  listApplicationsInput,
  openSlotsInput,
} from "~/lib/schemas/ccaApplication";
import { canonicalUserID } from "~/lib/identity";

/**
 * CCA-head-facing side of the applications workflow: review the queue, open and
 * cancel interview slots, record interview notes, and accept/reject.
 *
 * THE ONE RULE, identical to cca.ts: every procedure takes `input.ccaID` from
 * the client and MUST call assertHeadsCca before touching CCA-scoped data — the
 * builder only narrows identity. `roles` for that call is ALWAYS a live
 * getUserRoles() read (I-5), never session.user.roles. And every procedure
 * asserts cca.applications.enabled first: the surface is inert until the switch
 * is on.
 *
 * Acceptance ends in the exact `UserCCA.create({ ccaID, userID })` write that
 * ccaAdmin.addMember performs (canonical key, deduped against both key formats),
 * because "make this resident a member" is a single membership row and that is
 * the only writer of one.
 */

/**
 * Resolve canonical applicant ids to a human: displayName, email, matric. Same
 * approach as cca.listHeads (there is no reverse canonical→User query, so guess
 * the email AND match the stored key), plus the matric from UserMatric.
 */
async function resolveApplicants(
  db: PrismaClient,
  userIDs: readonly string[],
): Promise<
  Map<string, { displayName: string | null; email: string | null; matric: string | null }>
> {
  const keys = [...new Set(userIDs)];
  const out = new Map<
    string,
    { displayName: string | null; email: string | null; matric: string | null }
  >();
  if (keys.length === 0) return out;

  const guessedEmails = keys.map((k) => `${k.toLowerCase()}@u.nus.edu`);
  const [byEmail, byStored, matrics] = await Promise.all([
    db.user.findMany({
      where: { email: { in: guessedEmails, mode: "insensitive" } },
      // Never a bare read: passwordHash must not leave the server (I-2).
      select: { email: true, displayName: true, userID: true },
    }),
    db.user.findMany({
      where: { userID: { in: keys } },
      select: { email: true, displayName: true, userID: true },
    }),
    db.userMatric.findMany({
      where: { userID: { in: keys } },
      select: { userID: true, matric: true },
    }),
  ]);

  const matricByKey = new Map(matrics.map((m) => [m.userID, m.matric]));
  const set = (
    key: string,
    v: { displayName: string | null; email: string | null },
  ) => {
    if (!out.has(key)) {
      out.set(key, { ...v, matric: matricByKey.get(key) ?? null });
    }
  };
  for (const u of byEmail) {
    const cid = canonicalUserID(u.email);
    if (cid) set(cid, { displayName: u.displayName, email: u.email });
  }
  for (const u of byStored) {
    if (u.userID) set(u.userID, { displayName: u.displayName, email: u.email });
  }
  // Ensure every requested key is present, even if unresolved (amber in the UI).
  for (const k of keys) {
    if (!out.has(k)) {
      out.set(k, { displayName: null, email: null, matric: matricByKey.get(k) ?? null });
    }
  }
  return out;
}

/** Half-open overlap: two intervals collide iff aStart < bEnd AND bStart < aEnd. */
function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export const ccaApplicationsHeadRouter = createTRPCRouter({
  /** The review queue for one CCA, optionally filtered by status. */
  listApplications: identifiedProcedure
    .input(listApplicationsInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const apps = await ctx.db.ccaApplication.findMany({
        where: {
          ccaID: input.ccaID,
          ...(input.status ? { status: input.status } : {}),
        },
        select: {
          applicationID: true,
          userID: true,
          status: true,
          notes: true,
          interviewSlotID: true,
          createdAt: true,
          decidedAt: true,
          decisionReason: true,
        },
        orderBy: { applicationID: "desc" },
      });

      const [people, slots] = await Promise.all([
        resolveApplicants(ctx.db, apps.map((a) => a.userID)),
        (async () => {
          const slotIDs = apps
            .map((a) => a.interviewSlotID)
            .filter((s): s is number => s !== null);
          if (slotIDs.length === 0) return new Map<number, { startTime: number | null; endTime: number | null; location: string | null }>();
          const rows = await ctx.db.ccaInterviewSlot.findMany({
            where: { slotID: { in: slotIDs } },
            select: { slotID: true, startTime: true, endTime: true, location: true },
          });
          return new Map(rows.map((r) => [r.slotID, r]));
        })(),
      ]);

      return {
        applications: apps.map((a) => ({
          applicationID: a.applicationID,
          userID: a.userID,
          status: a.status,
          notes: a.notes,
          createdAt: a.createdAt,
          decidedAt: a.decidedAt,
          decisionReason: a.decisionReason,
          applicant: people.get(a.userID) ?? {
            displayName: null,
            email: null,
            matric: null,
          },
          slot:
            a.interviewSlotID !== null
              ? (slots.get(a.interviewSlotID) ?? null)
              : null,
        })),
      };
    }),

  /** One application in full — for the head to read DURING the interview. */
  getApplication: identifiedProcedure
    .input(headApplicationInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const app = await ctx.db.ccaApplication.findUnique({
        where: { applicationID: input.applicationID },
        select: {
          applicationID: true,
          ccaID: true,
          userID: true,
          status: true,
          notes: true,
          interviewSlotID: true,
          createdAt: true,
          decidedAt: true,
          decidedBy: true,
          decisionReason: true,
        },
      });
      // ccaID from the row must match the authorised scope — an applicationID
      // from another CCA is NOT_FOUND to a head who does not head that CCA.
      if (!app || app.ccaID !== input.ccaID) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "NO_SUCH_APPLICATION",
        });
      }

      const [people, notes, slot] = await Promise.all([
        resolveApplicants(ctx.db, [app.userID]),
        ctx.db.ccaInterviewNote.findMany({
          where: { applicationID: app.applicationID },
          select: {
            id: true,
            authorUserID: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        }),
        app.interviewSlotID !== null
          ? ctx.db.ccaInterviewSlot.findUnique({
              where: { slotID: app.interviewSlotID },
              select: {
                slotID: true,
                startTime: true,
                endTime: true,
                location: true,
              },
            })
          : Promise.resolve(null),
      ]);

      const authors = await resolveApplicants(
        ctx.db,
        notes.map((n) => n.authorUserID).filter((a): a is string => a !== null),
      );

      return {
        // ...app carries the APPLICANT's own `notes` string. The interview
        // notes are a separate array under `interviewNotes` so the two never
        // collide (an earlier version overwrote `notes` and lost the applicant
        // text).
        ...app,
        applicant: people.get(app.userID) ?? {
          displayName: null,
          email: null,
          matric: null,
        },
        slot,
        interviewNotes: notes.map((n) => ({
          id: n.id,
          body: n.body,
          createdAt: n.createdAt,
          authorUserID: n.authorUserID,
          authorName:
            (n.authorUserID && authors.get(n.authorUserID)?.displayName) ||
            n.authorUserID ||
            null,
        })),
      };
    }),

  /** All interview slots for a CCA, with who booked each — the head's calendar. */
  listSlots: identifiedProcedure
    .input(ccaTargetInput)
    .query(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      // NOTE: do NOT filter `canceledAt: null` in the query. A slot created
      // before this field was written explicitly has canceledAt ABSENT, and
      // Prisma+Mongo's `{ canceledAt: null }` matches a stored null but NOT an
      // absent field — so that filter silently hides every open slot. Prisma
      // deserializes an absent optional scalar as null, so filtering in JS on
      // `s.canceledAt === null` catches both the absent and the null case.
      const all = await ctx.db.ccaInterviewSlot.findMany({
        where: { ccaID: input.ccaID },
        select: {
          slotID: true,
          startTime: true,
          endTime: true,
          location: true,
          bookedByUserID: true,
          bookedApplicationID: true,
          canceledAt: true,
        },
        orderBy: { startTime: "asc" },
      });
      const slots = all.filter((s) => s.canceledAt === null);

      const booked = slots
        .map((s) => s.bookedByUserID)
        .filter((u): u is string => u !== null);
      const people = await resolveApplicants(ctx.db, booked);

      return {
        slots: slots.map((s) => ({
          ...s,
          bookedBy:
            s.bookedByUserID !== null
              ? (people.get(s.bookedByUserID) ?? {
                  displayName: null,
                  email: null,
                  matric: null,
                })
              : null,
        })),
      };
    }),

  /**
   * Open one or more interview slots. Rejects a slot in the past, a zero/negative
   * duration (the schema already blocks end<=start), or one overlapping an
   * existing open slot OR another slot in the same batch.
   */
  openSlots: identifiedProcedure
    .input(openSlotsInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
      const now = Math.floor(Date.now() / 1000);

      if (input.slots.some((s) => s.endTime <= now)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "SLOT_IN_PAST" });
      }

      // Serialize per-CCA so two concurrent "open" requests (a double-click, or
      // two heads at once) cannot both pass the duplicate/overlap check and then
      // both insert the same slots — the check-then-create must be atomic. Same
      // lock the booking and decide paths use.
      return withCcaLock(ctx.db, input.ccaID, async () => {
        // Existing NON-canceled slots. canceledAt is filtered in JS, not the
        // query: `canceledAt: null` misses absent-field slots (Prisma+Mongo), so
        // a DB filter would let the check skip them. See the note in listSlots.
        const existing = (
          await ctx.db.ccaInterviewSlot.findMany({
            where: { ccaID: input.ccaID },
            select: { startTime: true, endTime: true, canceledAt: true },
          })
        ).filter((e) => e.canceledAt === null);

        const sameTime = (
          a: { startTime: number | null; endTime: number | null },
          b: { startTime: number; endTime: number },
        ) => a.startTime === b.startTime && a.endTime === b.endTime;

        // Validate every incoming slot against the existing ones AND against the
        // slots earlier in this same batch. An exact DUPLICATE (identical
        // start+end) is reported distinctly from a partial OVERLAP so the head
        // gets a clear "already opened" message.
        const accepted: { startTime: number; endTime: number }[] = [];
        for (const s of input.slots) {
          if (existing.some((e) => sameTime(e, s)) || accepted.some((e) => sameTime(e, s))) {
            throw new TRPCError({ code: "CONFLICT", message: "DUPLICATE_SLOT" });
          }
          const clash =
            existing.some(
              (e) =>
                e.startTime !== null &&
                e.endTime !== null &&
                overlaps(s.startTime, s.endTime, e.startTime, e.endTime),
            ) ||
            accepted.some((e) =>
              overlaps(s.startTime, s.endTime, e.startTime, e.endTime),
            );
          if (clash) {
            throw new TRPCError({ code: "CONFLICT", message: "SLOT_OVERLAP" });
          }
          accepted.push({ startTime: s.startTime, endTime: s.endTime });
        }

        const batchId = randomUUID();
        const created: number[] = [];
        for (const s of input.slots) {
          const slotID = await nextCounter(ctx.db, SLOT_COUNTER_KEY);
          await ctx.db.ccaInterviewSlot.create({
            data: {
              slotID,
              ccaID: input.ccaID,
              startTime: s.startTime,
              endTime: s.endTime,
              location: s.location ?? null,
              createdBy: userID,
              createdAt: new Date(),
              // Explicit nulls (not absent) so other queries' null filters match
              // — Prisma+Mongo's null filter does not match an absent field.
              bookedByUserID: null,
              bookedApplicationID: null,
              bookedAt: null,
              canceledAt: null,
            },
          });
          created.push(slotID);
        }

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.open",
          batchId,
          reason: `${scope.via}: opened ${created.length} slot(s)`,
        });

        return { ccaID: input.ccaID, opened: created.length, slotIDs: created };
      });
    }),

  /**
   * Edit an OPEN slot's time and/or location. A BOOKED slot is refused — moving
   * a slot out from under an applicant who already claimed it would silently
   * change their interview time; the head must cancel it (which reverts the
   * applicant) and open a new one instead.
   */
  updateSlot: identifiedProcedure
    .input(editSlotInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const slot = await ctx.db.ccaInterviewSlot.findUnique({
          where: { slotID: input.slotID },
          select: {
            slotID: true,
            ccaID: true,
            canceledAt: true,
            bookedByUserID: true,
          },
        });
        if (!slot || slot.ccaID !== input.ccaID || slot.canceledAt !== null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SLOT" });
        }
        if (slot.bookedByUserID !== null) {
          throw new TRPCError({ code: "CONFLICT", message: "SLOT_BOOKED" });
        }
        const now = Math.floor(Date.now() / 1000);
        if (input.endTime <= now) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "SLOT_IN_PAST" });
        }

        // Overlap against every OTHER non-canceled slot for this CCA.
        const others = await ctx.db.ccaInterviewSlot.findMany({
          where: {
            ccaID: input.ccaID,
            canceledAt: null,
            slotID: { not: input.slotID },
          },
          select: { startTime: true, endTime: true },
        });
        const clash = others.some(
          (o) =>
            o.startTime !== null &&
            o.endTime !== null &&
            overlaps(input.startTime, input.endTime, o.startTime, o.endTime),
        );
        if (clash) {
          throw new TRPCError({ code: "CONFLICT", message: "SLOT_OVERLAP" });
        }

        await ctx.db.ccaInterviewSlot.update({
          where: { slotID: input.slotID },
          data: {
            startTime: input.startTime,
            endTime: input.endTime,
            location: input.location ?? null,
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.edit",
          reason: `${scope.via}: edited slot #${input.slotID}`,
        });

        return { slotID: input.slotID };
      });
    }),

  /**
   * Cancel a slot. If it was booked, the applicant's application is reverted to
   * `submitted` (so they can rebook) BEFORE the slot is marked canceled — a
   * booked slot is never yanked out from under a resident silently.
   */
  cancelSlot: identifiedProcedure
    .input(cancelSlotInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const slot = await ctx.db.ccaInterviewSlot.findUnique({
          where: { slotID: input.slotID },
          select: {
            slotID: true,
            ccaID: true,
            canceledAt: true,
            bookedApplicationID: true,
          },
        });
        if (!slot || slot.ccaID !== input.ccaID || slot.canceledAt !== null) {
          throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_SLOT" });
        }

        let revertedApplicationID: number | null = null;
        if (slot.bookedApplicationID !== null) {
          // Only revert if that application is still pointing at THIS slot and
          // is not already decided.
          const reverted = await ctx.db.ccaApplication.updateMany({
            where: {
              applicationID: slot.bookedApplicationID,
              interviewSlotID: slot.slotID,
              status: "interview_scheduled",
            },
            data: {
              status: "submitted",
              interviewSlotID: null,
              updatedAt: new Date(),
            },
          });
          if (reverted.count > 0) revertedApplicationID = slot.bookedApplicationID;
        }

        await ctx.db.ccaInterviewSlot.update({
          where: { slotID: input.slotID },
          data: {
            canceledAt: new Date(),
            bookedByUserID: null,
            bookedApplicationID: null,
            bookedAt: null,
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: input.ccaID,
          action: "ccaInterviewSlot.cancel",
          reason: `${scope.via}: canceled slot #${input.slotID}${
            revertedApplicationID !== null
              ? ` (reverted application #${revertedApplicationID})`
              : ""
          }`,
        });

        return { slotID: input.slotID, revertedApplicationID };
      });
    }),

  /** Append an interview note to an application. */
  addNote: identifiedProcedure
    .input(addNoteInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const app = await ctx.db.ccaApplication.findUnique({
        where: { applicationID: input.applicationID },
        select: { ccaID: true },
      });
      if (!app || app.ccaID !== input.ccaID) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "NO_SUCH_APPLICATION",
        });
      }

      const note = await ctx.db.ccaInterviewNote.create({
        data: {
          applicationID: input.applicationID,
          ccaID: input.ccaID,
          authorUserID: userID,
          body: input.body,
          createdAt: new Date(),
        },
        select: { id: true, createdAt: true },
      });

      await writeAudit(ctx.db, {
        actorUserID: userID,
        actorRoles: roles,
        targetCcaID: input.ccaID,
        action: "ccaInterviewNote.add",
        reason: `application #${input.applicationID} (${input.body.length} chars)`,
      });

      return { id: note.id, createdAt: note.createdAt };
    }),

  /** Mark a scheduled/submitted application as interviewed (optional stage). */
  markInterviewed: identifiedProcedure
    .input(headApplicationInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      const updated = await ctx.db.ccaApplication.updateMany({
        where: {
          applicationID: input.applicationID,
          ccaID: input.ccaID,
          status: { in: ["submitted", "interview_scheduled"] },
        },
        data: { status: "interviewed", updatedAt: new Date() },
      });
      if (updated.count === 0) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "NOT_INTERVIEWABLE",
        });
      }
      return { applicationID: input.applicationID, status: "interviewed" as const };
    }),

  /**
   * THE ACCEPT/REJECT STEP. Under withCcaLock so two heads cannot both decide
   * one application. Accept writes the UserCCA membership row (canonical key,
   * deduped against both formats exactly as ccaAdmin.addMember), then records
   * the decision; reject frees any FUTURE booked slot for other applicants.
   */
  decide: identifiedProcedure
    .input(decisionInput)
    .mutation(async ({ ctx, input }) => {
      await assertApplicationsEnabled(ctx.db);
      const userID = ctx.session.user.userID;
      const roles = await getUserRoles(ctx.db, userID); // I-5 live read
      const scope = await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);

      return withCcaLock(ctx.db, input.ccaID, async () => {
        const app = await ctx.db.ccaApplication.findUnique({
          where: { applicationID: input.applicationID },
          select: {
            applicationID: true,
            ccaID: true,
            userID: true,
            status: true,
            interviewSlotID: true,
          },
        });
        if (!app || app.ccaID !== input.ccaID) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "NO_SUCH_APPLICATION",
          });
        }
        if (isTerminalStatus(app.status)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "ALREADY_DECIDED",
          });
        }

        const batchId = randomUUID();
        const now = new Date();

        if (input.decision === "accepted") {
          // Resolve the applicant's key set the same way ccaAdmin.addMember
          // does, so we don't add a canonical row next to an existing legacy
          // one for the same person.
          const target = await ctx.db.user.findFirst({
            where: {
              OR: [
                {
                  email: {
                    equals: `${app.userID.toLowerCase()}@u.nus.edu`,
                    mode: "insensitive",
                  },
                },
                { userID: app.userID },
              ],
            },
            select: { email: true, userID: true },
          });
          const keys = target ? membershipKeysFor(target) : [app.userID];

          const already = await ctx.db.userCCA.findFirst({
            where: { ccaID: app.ccaID, userID: { in: keys } },
            select: { id: true },
          });
          if (!already) {
            // Raw insert via addCcaMember — a Prisma userCCA.create is rejected
            // by the UserCCA validator (ccaID must be int32; Prisma sends long).
            await addCcaMember(ctx.db, app.ccaID, app.userID);
          }

          await ctx.db.ccaApplication.update({
            where: { applicationID: app.applicationID },
            data: {
              status: "accepted",
              decidedBy: userID,
              decidedAt: now,
              decisionReason: input.reason ?? null,
              updatedAt: now,
            },
          });

          await writeAudit(ctx.db, {
            actorUserID: userID,
            actorRoles: roles,
            targetCcaID: app.ccaID,
            targetUserID: app.userID,
            action: "ccaApplication.accept",
            batchId,
            reason: `${scope.via}: application #${app.applicationID}${
              input.reason ? ` — ${input.reason}` : ""
            }`,
          });
          // Paired membership row, so the roster change is attributable — the
          // same action string ccaAdmin.addMember writes.
          await writeAudit(ctx.db, {
            actorUserID: userID,
            actorRoles: roles,
            targetCcaID: app.ccaID,
            targetUserID: app.userID,
            action: "ccaMember.add",
            batchId,
            reason: already
              ? "already a member (accept was idempotent)"
              : "via application acceptance",
          });

          return {
            applicationID: app.applicationID,
            status: "accepted" as const,
            alreadyMember: already !== null,
          };
        }

        // REJECT. Free a still-future booked slot so another applicant can take
        // it; a past interview slot is left as the historical record.
        if (app.interviewSlotID !== null) {
          const nowSec = Math.floor(Date.now() / 1000);
          await ctx.db.ccaInterviewSlot.updateMany({
            where: {
              slotID: app.interviewSlotID,
              bookedApplicationID: app.applicationID,
              endTime: { gt: nowSec },
            },
            data: {
              bookedByUserID: null,
              bookedApplicationID: null,
              bookedAt: null,
            },
          });
        }

        await ctx.db.ccaApplication.update({
          where: { applicationID: app.applicationID },
          data: {
            status: "rejected",
            decidedBy: userID,
            decidedAt: now,
            decisionReason: input.reason ?? null,
            updatedAt: now,
          },
        });

        await writeAudit(ctx.db, {
          actorUserID: userID,
          actorRoles: roles,
          targetCcaID: app.ccaID,
          targetUserID: app.userID,
          action: "ccaApplication.reject",
          reason: `${scope.via}: application #${app.applicationID}${
            input.reason ? ` — ${input.reason}` : ""
          }`,
        });

        return {
          applicationID: app.applicationID,
          status: "rejected" as const,
          alreadyMember: false,
        };
      });
    }),
});
