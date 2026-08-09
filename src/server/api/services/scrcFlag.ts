import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";

/* -------------------------------------------------------------------------- */
/* The Hall Office (SCRC) kill switch                                          */
/* -------------------------------------------------------------------------- */

const SCRC_FLAG_KEY = "scrc.enabled";
const FLAG_TTL_MS = 15_000;

let scrcFlagCache: { at: number; on: boolean } | null = null;

/**
 * I-11 applied to the /scrc surface, with the SAME deliberate divergence from
 * the three switches in access.ts that isCcaManagementEnabled makes.
 *
 * Those switches gate whether NEW enforcement applies to an EXISTING path, so
 * they fail OPEN — an unreachable flag means "behave as the app did yesterday",
 * which for them is no gate. That is right for enforcement and WRONG here.
 *
 * This switch gates a NEW surface whose central operation is GRANTING `jcrc` —
 * i.e. the one path by which a non-admin can create a manager-tier account.
 * "Behave as yesterday" for a surface that did not exist yesterday means
 * DISABLED. So an unreachable flag returns false, and the absence of the row
 * returns false: the whole hall-office surface is inert until someone
 * deliberately writes `scrc.enabled = "on"`, which is also how it is turned off
 * again in 15 seconds without a redeploy.
 *
 * Lives in its own module rather than in ccaScope.ts because it is neither a
 * CCA concern nor an enforcement mode, and because ccaScope.ts's
 * resetCcaManagementCache() is scoped to its own flag.
 */
export async function isScrcEnabled(db: PrismaClient): Promise<boolean> {
  if (scrcFlagCache && Date.now() - scrcFlagCache.at < FLAG_TTL_MS) {
    return scrcFlagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: SCRC_FLAG_KEY },
    });
    const on = row?.value === "on";
    scrcFlagCache = { at: Date.now(), on };
    return on;
  } catch {
    // Fail CLOSED, and deliberately NOT cached — the next request retries
    // rather than pinning "disabled" for 15s on a transient Atlas hiccup.
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetScrcFlagCache(): void {
  scrcFlagCache = null;
}

/**
 * Assert the switch is on. Called at the top of EVERY scrc-reachable procedure
 * and on the `scrc` branch of assertMayViewCcaRoster — the page-level check is
 * cosmetic (there is deliberately none in /scrc/layout.tsx, following the
 * manage-ccas precedent), this one is the boundary.
 *
 * Note where it is NOT called: computeCapabilities, which is synchronous,
 * DB-free and imported by client components, and the booking path, which is
 * governed purely by the FacilityAccess row for facility 17.
 */
export async function assertScrcEnabled(db: PrismaClient): Promise<void> {
  if (!(await isScrcEnabled(db))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "SCRC_DISABLED",
    });
  }
}
