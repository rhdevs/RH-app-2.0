import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

import {
  identifiedProcedure,
  createTRPCRouter,
  roleManagerProcedure,
} from "~/server/api/trpc";
import { writeAudit } from "~/server/api/routers/admin";
import { getUserRoles } from "~/server/api/services/access";
import { assertIsHeadOfCca } from "~/server/api/services/ccaPointsAccess";
import {
  computeCapabilities,
  type AuditAction,
} from "~/server/api/services/roles";
import { buildDirectoryEntries } from "~/server/api/services/ccaDirectory";
import { resolveRoster } from "~/server/api/services/ccaRoster";
import {
  clearFlat,
  effectiveIsSport,
  hasWaiver,
  ihgReason,
  isEntryOpen,
  isFlatRow,
  isIhgComplete,
  listOverrideRows,
  newYearReason,
  rangeProblem,
  readDefaultRow,
  readOverrideRow,
  removeOverride,
  resolveRange,
  brokenWaiversMessage,
  bundleExportReason,
  sportReason,
  sportsMissingIhg,
  startNewPointsYear as resetPointsYear,
  typeReason,
  waiverRows,
  waiversBrokenByDefault,
  writeDefaultRange,
  writeEntryOpen,
  writeFlat,
  writeIhg,
  writeOverride,
  writeSport,
  writeType,
  validConfigValue,
} from "~/server/api/services/ccaPointsConfig";
import {
  flatPointsProblem,
  formatFlatPoints,
  isValidFlatPoints,
} from "~/lib/points/flat";
import {
  CCA_TYPES,
  DEFAULT_RANGE,
  IHG_CAP_MAX,
  IHG_CAP_MIN,
  IHG_RESULTS,
  isCcaType,
  isIhgResult,
  isSportsCategory,
  isValidIhgCap,
  MEAN_LIMITS,
  SD_LIMITS,
  type Range,
} from "~/lib/points/constants";
import { fillRange } from "~/lib/points/meanSd";
import type { BundleCca } from "~/lib/points/bundleCsv";

/**
 * JCRC's points-entry configuration, and the one read a CCA head needs.
 *
 * CONFIDENTIAL BY CONSTRUCTION: NO PROCEDURE HERE ACCEPTS OR RETURNS
 * LEADER-ENTERED POINTS. The server only knows the allowed ranges, whether entry
 * is open and which CCAs are flat. Leaders score their members, check mean/SD and
 * build the CSV in their own browser (src/lib/points), and the audit rows below
 * carry config values and counts only. Do not add a procedure that takes a score
 * or a roster of scores — the confidentiality rule for this feature is that
 * leader-entered points are never persisted or transmitted to the server.
 *
 * IHG IS THE SAME: only a sport's result and cap (config) live here. Which
 * members the head ticks for the IHG points stays in the head's browser and the
 * CSV; no procedure takes a matric, a row key or a tick.
 *
 * ONE EXCEPTION IN WHAT IS RETURNED: `bundleExportData`
 * returns, to JCRC only (live capability re-check), the rosters of the flat CCAs
 * with matrics and names. That is membership plus JCRC's own flat value, never a
 * leader's score. Every call writes an audit row (`ccaPoints.bundle.export`,
 * counts only) before the payload is returned; like event.exportAttendees that
 * row is best-effort (writeAudit logs a failure and never throws), so a failed
 * write is logged and does not block.
 *
 * The twelve JCRC procedures are `roleManagerProcedure` (admin + jcrc) and
 * ADDITIONALLY assert `manageCcaPointsRanges` against a LIVE role read (I-5), the
 * same belt-and-braces shape as ccaRecruitment.ts. roleManagerProcedure also
 * narrows `ctx.session.user.userID` to a non-null canonical id (I-1).
 */

const FORBIDDEN_CAPABILITY = "CAPABILITY_REQUIRED:manageCcaPointsRanges";
const REASON_MAX = 500;

/** Live capability check; returns the roles so the caller can audit with them. */
async function requirePointsCapability(
  db: PrismaClient,
  userID: string,
): Promise<string[]> {
  const roles = await getUserRoles(db, userID); // I-5 live read
  if (!computeCapabilities(roles).manageCcaPointsRanges) {
    throw new TRPCError({ code: "FORBIDDEN", message: FORBIDDEN_CAPABILITY });
  }
  return roles;
}

/** Every CCA, name order: what the gate and the CCA list are built from. */
const listCcas = (db: PrismaClient) =>
  db.cCA.findMany({
    select: { ccaID: true, ccaName: true, category: true },
    orderBy: { ccaName: "asc" },
  });

/** The CCA must exist; returns what the type, sport and IHG writes need. */
async function requireCca(db: PrismaClient, ccaID: number) {
  const cca = await db.cCA.findFirst({
    where: { ccaID },
    select: { ccaID: true, category: true },
  });
  if (!cca)
    throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
  return cca;
}

/**
 * While points entry is open, heads are ticking IHG recipients against the cap, so
 * a non-flat sport must not lose its result or cap (or become a sport without
 * them). Callers pass whether the write would leave such a sport incomplete.
 */
async function refuseWhileEntryOpen(
  db: PrismaClient,
  wouldLeaveSportIncomplete: boolean,
): Promise<void> {
  if (!wouldLeaveSportIncomplete) return;
  if (!isEntryOpen(await readDefaultRow(db))) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "ENTRY_OPEN_IHG",
  });
}

const mean = z.number().min(MEAN_LIMITS[0]).max(MEAN_LIMITS[1]);
const sd = z.number().min(SD_LIMITS[0]).max(SD_LIMITS[1]);

function assertSound(range: Readonly<Range>): void {
  const problem = rangeProblem(range);
  if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
}

const fmtRange = (r: Readonly<Range>): string =>
  `mean ${r.meanMin}–${r.meanMax}; SD ${r.sdMin}–${r.sdMax}`;

/** Audit rows describe config only. `action` is one of AUDIT_ACTIONS. */
function audit(
  db: PrismaClient,
  e: {
    actorUserID: string;
    actorRoles: string[];
    action: AuditAction;
    targetCcaID?: number;
    rolesAfter?: string[];
    reason?: string;
  },
) {
  return writeAudit(db, e);
}

/** The flat CCAs' value and whole roster with matrics: membership plus JCRC's own config. */
async function flatRosters(
  db: PrismaClient,
  flatRows: Awaited<ReturnType<typeof listOverrideRows>>,
  nameById: ReadonlyMap<number, string>,
) {
  return Promise.all(
    flatRows.flatMap((r) =>
      r.ccaID === null || r.flatPoints === null
        ? []
        : [
            (async () => {
              const { entries } = await buildDirectoryEntries(db, r.ccaID!);
              return {
                ccaID: r.ccaID!,
                ccaName: nameById.get(r.ccaID!) ?? `CCA ${r.ccaID}`,
                flatPoints: r.flatPoints!,
                members: entries.map((e) => ({
                  rowKey: e.rowKey,
                  matric: e.matric,
                  name: e.name,
                  resolved: e.resolved,
                })),
              };
            })(),
          ],
    ),
  );
}

const overrideInput = z.object({
  ccaID: z.number().int().positive(),
  // Blank (null / omitted) = use the default for that field.
  meanMin: mean.nullish(),
  meanMax: mean.nullish(),
  sdMin: sd.nullish(),
  sdMax: sd.nullish(),
  note: z.string().trim().min(1, "A note is required").max(REASON_MAX),
});

const flatPointsInput = z.number().refine(isValidFlatPoints, (n) => ({
  message: flatPointsProblem(n) ?? "Not a valid number of points.",
}));

export const ccaPointsRouter = createTRPCRouter({
  /**
   * What a head needs to run their page: is entry open, and the range THIS CCA
   * is judged against. STRICTLY heads only: the caller must hold a CcaHead row
   * for THIS ccaID. Unlike assertHeadsCca, admin and jcrc are not let through by
   * capability. Returns config only — no roster, no points.
   */
  getEntryContext: identifiedProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      await assertIsHeadOfCca(ctx.db, ctx.session.user.userID, input.ccaID);

      const [defaultRow, overrideRow] = await Promise.all([
        readDefaultRow(ctx.db),
        readOverrideRow(ctx.db, input.ccaID),
      ]);
      const resolved = resolveRange(defaultRow, overrideRow);
      const flatPoints = overrideRow?.flatPoints ?? null;
      const cca = await ctx.db.cCA.findFirst({
        where: { ccaID: input.ccaID },
        select: { ccaName: true, category: true },
      });
      // A sport's head needs JCRC's IHG result and cap; null = not a sport, or flat.
      const isSport = effectiveIsSport(overrideRow, cca?.category ?? null);
      return {
        entryOpen: isEntryOpen(defaultRow),
        range: resolved.range,
        isWaived: resolved.isWaived,
        waivedFields: resolved.waivedFields,
        note: resolved.isWaived ? (overrideRow?.note ?? null) : null,
        /** Set when JCRC marked this CCA flat: the leader has nothing to do. */
        flatPoints,
        /** A flat CCA's page loads no roster, so it needs the name from here. */
        flatCcaName: flatPoints === null ? null : (cca?.ccaName ?? null),
        ihg:
          isSport && flatPoints === null
            ? {
                result: validConfigValue(
                  input.ccaID,
                  "ihgResult",
                  overrideRow?.ihgResult,
                  isIhgResult,
                ),
                cap: validConfigValue(
                  input.ccaID,
                  "ihgCap",
                  overrideRow?.ihgCap,
                  isValidIhgCap,
                ),
              }
            : null,
      };
    }),

  /** Everything /admin/points shows: the switch, the default row and every waiver. */
  getConfig: roleManagerProcedure.query(async ({ ctx }) => {
    await requirePointsCapability(ctx.db, ctx.session.user.userID);

    const [defaultRow, overrideRows, allCcas] = await Promise.all([
      readDefaultRow(ctx.db),
      listOverrideRows(ctx.db),
      listCcas(ctx.db),
    ]);
    const waivers = waiverRows(overrideRows);
    const flatRows = overrideRows.filter(isFlatRow);
    const nameById = new Map(allCcas.map((c) => [c.ccaID, c.ccaName]));
    const rowById = new Map(overrideRows.map((r) => [r.ccaID, r]));
    const flatWithCounts = await Promise.all(
      flatRows.flatMap((r) =>
        r.ccaID === null || r.flatPoints === null
          ? []
          : [
              (async () => {
                const roster = await resolveRoster(ctx.db, r.ccaID!);
                return {
                  ccaID: r.ccaID!,
                  ccaName: nameById.get(r.ccaID!) ?? `CCA ${r.ccaID}`,
                  flatPoints: r.flatPoints!,
                  memberCount: roster.heads.length + roster.members.length,
                  /** A waiver on the same CCA is not used while it is flat. */
                  hasWaiver: waivers.some((w) => w.ccaID === r.ccaID),
                  updatedAt: r.updatedAt,
                };
              })(),
            ],
      ),
    );

    return {
      entryOpen: isEntryOpen(defaultRow),
      /** The stored default row, or null when JCRC has never set one. */
      defaultRange: defaultRow
        ? {
            meanMin: defaultRow.meanMin,
            meanMax: defaultRow.meanMax,
            sdMin: defaultRow.sdMin,
            sdMax: defaultRow.sdMax,
          }
        : null,
      /** What applies today after filling blanks from the built-in defaults. */
      effectiveDefault: resolveRange(defaultRow, null).range,
      builtInDefault: DEFAULT_RANGE,
      updatedAt: defaultRow?.updatedAt ?? null,
      updatedBy: defaultRow?.updatedBy ?? null,
      flatCcas: flatWithCounts,
      /** EVERY CCA with its type, sport flag, IHG config, flat and waiver state. */
      ccas: allCcas.map((c) => {
        const row = rowById.get(c.ccaID) ?? null;
        return {
          ccaID: c.ccaID,
          ccaName: c.ccaName,
          isSport: effectiveIsSport(row, c.category),
          sportSource:
            typeof row?.isSport === "boolean"
              ? ("jcrc" as const)
              : ("category" as const),
          type: validConfigValue(c.ccaID, "ccaType", row?.ccaType, isCcaType),
          ihgResult: validConfigValue(
            c.ccaID,
            "ihgResult",
            row?.ihgResult,
            isIhgResult,
          ),
          ihgCap: validConfigValue(
            c.ccaID,
            "ihgCap",
            row?.ihgCap,
            isValidIhgCap,
          ),
          isFlat: isFlatRow(row),
          hasWaiver: hasWaiver(row),
        };
      }),
      overrides: waivers.flatMap((r) =>
        r.ccaID === null
          ? []
          : [
              {
                ccaID: r.ccaID,
                ccaName: nameById.get(r.ccaID) ?? `CCA ${r.ccaID}`,
                meanMin: r.meanMin,
                meanMax: r.meanMax,
                sdMin: r.sdMin,
                sdMax: r.sdMax,
                note: r.note,
                updatedAt: r.updatedAt,
                updatedBy: r.updatedBy,
              },
            ],
      ),
    };
  }),

  /** Open or close points entry hall-wide. Idempotent, and audited every time. */
  setEntryOpen: roleManagerProcedure
    .input(
      z.object({
        open: z.boolean(),
        reason: z.string().trim().max(REASON_MAX).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      if (input.open) {
        // Every non-flat sport needs its IHG result and cap before heads start.
        const notReady = sportsMissingIhg(
          await listCcas(ctx.db),
          await listOverrideRows(ctx.db),
        );
        if (notReady.length > 0) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `IHG_NOT_READY: ${notReady.join(", ")}`,
          });
        }
      }
      const now = new Date();
      await writeEntryOpen(ctx.db, input.open, actorUserID, now);
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.entry.set",
        rolesAfter: [input.open ? "open" : "closed"],
        reason: input.reason,
      });
      return { entryOpen: input.open, updatedAt: now };
    }),

  /** The hall-wide default ranges. All four fields are required here. */
  setDefault: roleManagerProcedure
    .input(z.object({ meanMin: mean, meanMax: mean, sdMin: sd, sdMax: sd }))
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      assertSound(input);

      // A waiver only sets some fields; the rest follow the default. Refuse a new
      // default that would leave any waiver impossible, and save nothing.
      const broken = waiversBrokenByDefault(
        await listOverrideRows(ctx.db),
        input,
      );
      if (broken.length > 0) {
        const named = await ctx.db.cCA.findMany({
          where: { ccaID: { in: broken.map((b) => b.ccaID) } },
          select: { ccaID: true, ccaName: true },
        });
        const nameById = new Map(named.map((c) => [c.ccaID, c.ccaName]));
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: brokenWaiversMessage(
            broken.map((b) => ({
              ccaName: nameById.get(b.ccaID) ?? `CCA ${b.ccaID}`,
              problem: b.problem,
            })),
          ),
        });
      }

      const now = new Date();
      await writeDefaultRange(ctx.db, input, actorUserID, now);
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.default.set",
        reason: fmtRange(input),
      });
      return { range: input, updatedAt: now };
    }),

  /**
   * A per-CCA waiver. Blank fields keep following the default. The range is
   * validated AFTER fallback to the current default, so a half-filled waiver can
   * never produce min > max.
   */
  setOverride: roleManagerProcedure
    .input(overrideInput)
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);

      const values = {
        meanMin: input.meanMin ?? null,
        meanMax: input.meanMax ?? null,
        sdMin: input.sdMin ?? null,
        sdMax: input.sdMax ?? null,
      };
      if (Object.values(values).every((v) => v === null)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Fill in at least one range field, or the waiver changes nothing.",
        });
      }
      const cca = await ctx.db.cCA.findFirst({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca)
        throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });

      const defaultRow = await readDefaultRow(ctx.db);
      assertSound(fillRange(values, resolveRange(defaultRow, null).range));

      const now = new Date();
      await writeOverride(
        ctx.db,
        input.ccaID,
        { ...values, note: input.note },
        actorUserID,
        now,
      );
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.override.set",
        targetCcaID: input.ccaID,
        reason:
          `${fmtRange(fillRange(values, resolveRange(defaultRow, null).range))}. Note: ${input.note}`.slice(
            0,
            REASON_MAX,
          ),
      });
      return { ccaID: input.ccaID, updatedAt: now };
    }),

  /** Remove a waiver, so the CCA follows the default again. */
  clearOverride: roleManagerProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      const existed = await removeOverride(ctx.db, input.ccaID);
      // Nothing to remove means nothing changed, so nothing is audited.
      if (existed) {
        await audit(ctx.db, {
          actorUserID,
          actorRoles: roles,
          action: "ccaPoints.override.clear",
          targetCcaID: input.ccaID,
        });
      }
      return { cleared: existed };
    }),

  /**
   * Mark a CCA as FLAT: every member receives `flatPoints` as the whole CCA's
   * points (the sandbox applies the maths). A waiver on the same CCA is kept but
   * not used while it is flat.
   */
  setFlat: roleManagerProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        flatPoints: flatPointsInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      const cca = await ctx.db.cCA.findFirst({
        where: { ccaID: input.ccaID },
        select: { ccaID: true },
      });
      if (!cca)
        throw new TRPCError({ code: "NOT_FOUND", message: "CCA_NOT_FOUND" });
      const now = new Date();
      await writeFlat(ctx.db, input.ccaID, input.flatPoints, actorUserID, now);
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.flat.set",
        targetCcaID: input.ccaID,
        reason: `${formatFlatPoints(input.flatPoints)} points each`,
      });
      return {
        ccaID: input.ccaID,
        flatPoints: input.flatPoints,
        updatedAt: now,
      };
    }),

  /** Take a CCA off flat points. Nothing to remove means nothing is audited. */
  clearFlat: roleManagerProcedure
    .input(z.object({ ccaID: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      // Un-flattening a sport without both makes it a sport that needs them.
      const cca = await ctx.db.cCA.findFirst({
        where: { ccaID: input.ccaID },
        select: { category: true },
      });
      if (cca) {
        const row = await readOverrideRow(ctx.db, input.ccaID);
        await refuseWhileEntryOpen(
          ctx.db,
          isFlatRow(row) &&
            effectiveIsSport(row, cca.category) &&
            !isIhgComplete(row),
        );
      }
      const existed = await clearFlat(ctx.db, input.ccaID);
      if (existed) {
        await audit(ctx.db, {
          actorUserID,
          actorRoles: roles,
          action: "ccaPoints.flat.clear",
          targetCcaID: input.ccaID,
        });
      }
      return { cleared: existed };
    }),

  /** A CCA's points type (1x / 0.5x); null clears it. Carried to the sandbox in the bundle. */
  setType: roleManagerProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        type: z.enum(CCA_TYPES).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      await requireCca(ctx.db, input.ccaID);
      const now = new Date();
      await writeType(ctx.db, input.ccaID, input.type, actorUserID, now);
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.type.set",
        targetCcaID: input.ccaID,
        reason: typeReason(input.type),
      });
      return { ccaID: input.ccaID, type: input.type, updatedAt: now };
    }),

  /**
   * A sport's IHG result and the most members its head may tick for the points.
   * Config only: the ticks never reach the server. Refused for a CCA that is not
   * effectively a sport (JCRC's tick, else the category). While points entry is
   * open a blank result or cap is refused; lowering a cap is not.
   */
  setIhg: roleManagerProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        result: z.enum(IHG_RESULTS).nullable(),
        cap: z.number().int().min(IHG_CAP_MIN).max(IHG_CAP_MAX).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      const cca = await requireCca(ctx.db, input.ccaID);
      const row = await readOverrideRow(ctx.db, input.ccaID);
      if (!effectiveIsSport(row, cca.category)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "NOT_A_SPORT" });
      }
      await refuseWhileEntryOpen(
        ctx.db,
        (input.result === null || input.cap === null) && !isFlatRow(row),
      );
      const now = new Date();
      await writeIhg(
        ctx.db,
        input.ccaID,
        { ihgResult: input.result, ihgCap: input.cap },
        actorUserID,
        now,
      );
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.ihg.set",
        targetCcaID: input.ccaID,
        reason: ihgReason(input.result, input.cap),
      });
      return {
        ccaID: input.ccaID,
        result: input.result,
        cap: input.cap,
        updatedAt: now,
      };
    }),

  /**
   * JCRC's "Sport" tick for a CCA. true / false overrides the category default;
   * null goes back to it. While points entry is open it cannot make a CCA a sport
   * that has no IHG result and cap.
   */
  setSport: roleManagerProcedure
    .input(
      z.object({
        ccaID: z.number().int().positive(),
        isSport: z.boolean().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actorUserID = ctx.session.user.userID;
      const roles = await requirePointsCapability(ctx.db, actorUserID);
      const cca = await requireCca(ctx.db, input.ccaID);
      const row = await readOverrideRow(ctx.db, input.ccaID);
      const willBeSport = input.isSport ?? isSportsCategory(cca.category);
      await refuseWhileEntryOpen(
        ctx.db,
        willBeSport &&
          !effectiveIsSport(row, cca.category) &&
          !isFlatRow(row) &&
          !isIhgComplete(row),
      );
      const now = new Date();
      await writeSport(ctx.db, input.ccaID, input.isSport, actorUserID, now);
      await audit(ctx.db, {
        actorUserID,
        actorRoles: roles,
        action: "ccaPoints.sport.set",
        targetCcaID: input.ccaID,
        reason: sportReason(input.isSport),
      });
      return { ccaID: input.ccaID, isSport: input.isSport, updatedAt: now };
    }),

  /**
   * The yearly reset: clears every IHG result (caps stay) and closes points entry.
   * Types, caps, sport ticks, waivers, flat values and the default range are kept.
   */
  startNewPointsYear: roleManagerProcedure.mutation(async ({ ctx }) => {
    const actorUserID = ctx.session.user.userID;
    const roles = await requirePointsCapability(ctx.db, actorUserID);
    const cleared = await resetPointsYear(ctx.db, actorUserID, new Date());
    await audit(ctx.db, {
      actorUserID,
      actorRoles: roles,
      action: "ccaPoints.year.start",
      rolesAfter: ["closed"],
      reason: newYearReason(cleared),
    });
    return { cleared, entryOpen: false };
  }),

  /**
   * The ONE file JCRC gives the sandbox: the effective default range, the waivers,
   * every CCA (type, sport tick, IHG result and cap, flat value) and the flat
   * rosters with matrics. It is a MUTATION: a bulk read of
   * matrics and names, so each call writes one `ccaPoints.bundle.export` audit row
   * (counts only) before the payload is returned, and the result is not cached.
   */
  bundleExportData: roleManagerProcedure.mutation(async ({ ctx }) => {
    const actorUserID = ctx.session.user.userID;
    const roles = await requirePointsCapability(ctx.db, actorUserID);
    const [defaultRow, overrideRows, allCcas] = await Promise.all([
      readDefaultRow(ctx.db),
      listOverrideRows(ctx.db),
      ctx.db.cCA.findMany({
        select: { ccaID: true, ccaName: true, category: true },
        orderBy: { ccaID: "asc" },
      }),
    ]);
    const nameById = new Map(allCcas.map((c) => [c.ccaID, c.ccaName]));
    const rowById = new Map(overrideRows.map((r) => [r.ccaID, r]));
    const flat = await flatRosters(
      ctx.db,
      overrideRows.filter(isFlatRow),
      nameById,
    );
    const ccas: BundleCca[] = allCcas.map((c) => {
      const row = rowById.get(c.ccaID) ?? null;
      const isSport = effectiveIsSport(row, c.category);
      return {
        ccaID: c.ccaID,
        ccaName: c.ccaName,
        flatPoints: isFlatRow(row) ? (row?.flatPoints ?? null) : null,
        type: validConfigValue(c.ccaID, "ccaType", row?.ccaType, isCcaType),
        isSport,
        ihgResult: isSport
          ? validConfigValue(c.ccaID, "ihgResult", row?.ihgResult, isIhgResult)
          : null,
        ihgCap: isSport
          ? validConfigValue(c.ccaID, "ihgCap", row?.ihgCap, isValidIhgCap)
          : null,
      };
    });
    const waivers = waiverRows(overrideRows).flatMap((r) =>
      r.ccaID === null
        ? []
        : [
            {
              ccaID: r.ccaID,
              ccaName: nameById.get(r.ccaID) ?? `CCA ${r.ccaID}`,
              meanMin: r.meanMin,
              meanMax: r.meanMax,
              sdMin: r.sdMin,
              sdMax: r.sdMax,
              note: r.note,
            },
          ],
    );
    // Audit before returning; best-effort like event.exportAttendees. Counts only.
    await audit(ctx.db, {
      actorUserID,
      actorRoles: roles,
      action: "ccaPoints.bundle.export",
      reason: bundleExportReason(
        ccas.length,
        flat.length,
        flat.reduce((n, c) => n + c.members.length, 0),
      ),
    });
    return {
      effectiveDefault: resolveRange(defaultRow, null).range,
      waivers,
      ccas,
      flat,
    };
  }),
});
