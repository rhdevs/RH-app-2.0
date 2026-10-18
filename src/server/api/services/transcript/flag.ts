import type { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

/**
 * THE TRANSCRIPT KILL SWITCH: the `transcript.enabled` SystemFlag row.
 *
 * The same shape as `cca.management.enabled` (ccaScope.ts), for the same
 * reason: transcripts are a NEW surface, so "behave as yesterday" means OFF.
 * Only `value === "on"` turns it on; an absent row, any other value, or an
 * unreachable database all read as off. Every transcript procedure refuses
 * while it is off (see ./procedures.ts), so the code can be deployed before the
 * unique indexes are built, and turned on only after
 * `create-transcript-indexes.mjs --commit` has run.
 *
 * Flipped by `node scripts/remediation/set-transcript-flag.mjs on --commit`
 * (a DB row, not an env var, so it needs no redeploy).
 */

export const TRANSCRIPT_FLAG_KEY = "transcript.enabled";
export const TRANSCRIPT_DISABLED = "TRANSCRIPT_DISABLED";
const FLAG_TTL_MS = 15_000;

let flagCache: { at: number; on: boolean } | null = null;

export async function isTranscriptEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<boolean> {
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.on;
  }
  try {
    const row = await db.systemFlag.findUnique({
      where: { key: TRANSCRIPT_FLAG_KEY },
    });
    const on = row?.value === "on";
    flagCache = { at: Date.now(), on };
    return on;
  } catch {
    // Fail CLOSED, and deliberately NOT cached: the next request retries
    // rather than pinning "off" for 15s on a transient database hiccup.
    return false;
  }
}

/** Test/ops seam: drop the per-lambda cache so the next read hits the row. */
export function resetTranscriptFlagCache(): void {
  flagCache = null;
}

/** Throws TRANSCRIPT_DISABLED unless the switch is on. */
export async function assertTranscriptEnabled(
  db: Pick<PrismaClient, "systemFlag">,
): Promise<void> {
  if (!(await isTranscriptEnabled(db))) {
    throw new TRPCError({ code: "FORBIDDEN", message: TRANSCRIPT_DISABLED });
  }
}
