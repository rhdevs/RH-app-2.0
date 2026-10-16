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
import {
  isEntryOpen,
  listOverrideRows,
  rangeProblem,
  readDefaultRow,
  readOverrideRow,
  removeOverride,
  resolveRange,
  writeDefaultRange,
  writeEntryOpen,
  writeOverride,
} from "~/server/api/services/ccaPointsConfig";
import {
  DEFAULT_RANGE,
  MEAN_LIMITS,
  SD_LIMITS,
  type Range,
} from "~/lib/points/constants";
import { fillRange } from "~/lib/points/meanSd";

/**
 * JCRC's points-entry configuration, and the one read a CCA head needs.
 *
 * CONFIDENTIAL BY CONSTRUCTION: NO PROCEDURE HERE ACCEPTS OR RETURNS POINTS.
 * The server only knows the allowed ranges and whether entry is open. Leaders
 * score their members, check mean/SD and build the CSV in their own browser
 * (src/lib/points), and the audit rows below carry config values only. Do not
 * add a procedure that takes a score, a matric or a roster of either — the
 * confidentiality rule for this feature is that points are never persisted or
 * transmitted to the server.
 *
 * The five JCRC procedures are `roleManagerProcedure` (admin + jcrc) and
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

const overrideInput = z.object({
  ccaID: z.number().int().positive(),
  // Blank (null / omitted) = use the default for that field.
  meanMin: mean.nullish(),
  meanMax: mean.nullish(),
  sdMin: sd.nullish(),
  sdMax: sd.nullish(),
  note: z.string().trim().min(1, "A note is required").max(REASON_MAX),
});

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
      return {
        entryOpen: isEntryOpen(defaultRow),
        range: resolved.range,
        isWaived: resolved.isWaived,
        waivedFields: resolved.waivedFields,
        note: resolved.isWaived ? (overrideRow?.note ?? null) : null,
      };
    }),

  /** Everything /admin/points shows: the switch, the default row and every waiver. */
  getConfig: roleManagerProcedure.query(async ({ ctx }) => {
    await requirePointsCapability(ctx.db, ctx.session.user.userID);

    const [defaultRow, overrideRows] = await Promise.all([
      readDefaultRow(ctx.db),
      listOverrideRows(ctx.db),
    ]);
    const ccaIDs = overrideRows.flatMap((r) =>
      r.ccaID === null ? [] : [r.ccaID],
    );
    const ccas =
      ccaIDs.length === 0
        ? []
        : await ctx.db.cCA.findMany({
            where: { ccaID: { in: ccaIDs } },
            select: { ccaID: true, ccaName: true },
          });
    const nameById = new Map(ccas.map((c) => [c.ccaID, c.ccaName]));

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
      overrides: overrideRows.flatMap((r) =>
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
});
