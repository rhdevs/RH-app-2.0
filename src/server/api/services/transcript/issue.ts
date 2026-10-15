import { randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import {
  assembleTranscript,
  normaliseVerificationCode,
} from "~/lib/transcript/assemble";
import type { TranscriptViewModel } from "~/lib/transcript/types";
import {
  activeKeyFor,
  loadTranscriptInput,
  NOT_ON_FILE,
  NOT_REVOKED,
} from "./loader";
import { STATUS_PUBLISHED, getPeriod } from "./periods";

/**
 * Issuing and verifying transcripts.
 *
 *  - ISSUE: a resident gets their transcript for a year only once the year is
 *    published, and only their own. It is idempotent: asking again returns the
 *    same issue. What is issued is FROZEN into `snapshot`, so /verify shows the
 *    record as it was issued even if live data later changes.
 *  - VERIFY: public, so it returns the snapshot with the matric MASKED, and says
 *    only valid / revoked / superseded / not_found. It never reveals whether a
 *    code "almost" matches.
 *
 * Nothing here logs a code or a matric number.
 */

/** No 0, 1, I, L, N-confusable or vowel-lookalike characters; 31 symbols. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const CODE_LENGTH = 16;
export const CODE_PATTERN = /^RH-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{16}$/;

/**
 * "RH-" + 16 characters from CODE_ALPHABET, from crypto.randomBytes. Rejection
 * sampling (accept a byte only below the largest multiple of 31 that fits in a
 * byte, 248) so every symbol is equally likely: `byte % 31` alone would favour
 * the first 8 symbols. 31^16 is about 2^79, so a code cannot be guessed.
 */
export function generateCode(
  bytes: (n: number) => Uint8Array = randomBytes,
): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const b of bytes(CODE_LENGTH * 2)) {
      if (b >= limit) continue;
      out += CODE_ALPHABET[b % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return `RH-${out}`;
}

/** A duplicate-key error from the database, on any unique index. */
const isDuplicateKey = (error: unknown) =>
  (error as { code?: string }).code === "P2002";

/** Keep only the first and last character: "A0001000X" -> "A*******X". */
export function maskMatric(matric: string): string {
  if (matric === NOT_ON_FILE) return matric;
  if (matric.length <= 2) return "*".repeat(matric.length);
  return `${matric[0]}${"*".repeat(matric.length - 2)}${matric[matric.length - 1]}`;
}

export interface IssueSnapshot {
  issuedAt: string;
  transcript: TranscriptViewModel;
  meta?: { superseded?: boolean; reason?: string };
}

function readSnapshot(value: unknown): IssueSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<IssueSnapshot>;
  if (!v.transcript || typeof v.transcript !== "object") return null;
  return v as IssueSnapshot;
}

export interface IssuedTranscript {
  code: string;
  academicYear: string;
  issuedAt: string;
  transcript: TranscriptViewModel;
}

/**
 * The transcript a resident downloads. THE CALLER SUPPLIES `userID` FROM THE
 * SESSION, never from the client: a resident can only issue for themselves.
 *
 * Throws PRECONDITION_FAILED "NOT_PUBLISHED" unless the year is published.
 */
export async function issueForResident(
  db: PrismaClient,
  userID: string,
  academicYear: string,
  now: Date = new Date(),
): Promise<IssuedTranscript> {
  const period = await getPeriod(db, academicYear);
  if (period?.status !== STATUS_PUBLISHED) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NOT_PUBLISHED",
    });
  }

  const find = () =>
    db.transcriptIssue.findFirst({
      where: { academicYear, userID, ...NOT_REVOKED },
      orderBy: { id: "asc" },
    });
  const toResult = (row: NonNullable<Awaited<ReturnType<typeof find>>>) => {
    const snap = readSnapshot(row.snapshot);
    if (!snap)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "BAD_SNAPSHOT",
      });
    return {
      code: row.code,
      academicYear,
      issuedAt: snap.issuedAt,
      transcript: snap.transcript,
    };
  };

  const existing = await find();
  if (existing) return toResult(existing);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const code = generateCode();
    const input = await loadTranscriptInput(db, userID, academicYear, {
      mode: "frozen",
      verificationCode: code,
      now,
    });
    const transcript = assembleTranscript(input, academicYear);
    const snapshot: IssueSnapshot = { issuedAt: now.toISOString(), transcript };
    let created;
    try {
      created = await db.transcriptIssue.create({
        data: {
          code,
          academicYear,
          userID,
          issuedAt: now,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          activeKey: activeKeyFor(academicYear, userID),
        },
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // Either a concurrent first download won (the unique key on the valid
      // issue), in which case answer with theirs, or the code itself collided
      // (vanishingly unlikely), in which case draw another.
      const winner = await find();
      if (winner) return toResult(winner);
      continue;
    }

    // The year may have been reopened between the published check above and
    // this insert; a late row would otherwise stay live and stale. Withdraw it.
    const after = await getPeriod(db, academicYear);
    if (after?.status !== STATUS_PUBLISHED) {
      await db.transcriptIssue.delete({ where: { id: created.id } });
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "NOT_PUBLISHED",
      });
    }
    return { code, academicYear, issuedAt: snapshot.issuedAt, transcript };
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "CODE_COLLISION",
  });
}

export type VerifyResult =
  | { status: "not_found" }
  | { status: "revoked" }
  | {
      status: "valid" | "superseded";
      academicYear: string;
      issuedAt: string;
      transcript: TranscriptViewModel;
    };

/**
 * Look a code up. A malformed code never reaches the database. Every kind of
 * miss is the same `not_found`, so nothing leaks about near-matches. The
 * snapshot is returned with the matric masked, and a revoked (not superseded)
 * code returns no record at all.
 */
export async function verifyCode(
  db: PrismaClient,
  rawCode: string,
): Promise<VerifyResult> {
  const code = normaliseVerificationCode(rawCode);
  if (!CODE_PATTERN.test(code)) return { status: "not_found" };

  const row = await db.transcriptIssue.findUnique({ where: { code } });
  const snap = row ? readSnapshot(row.snapshot) : null;
  if (!row || !snap) return { status: "not_found" };

  const superseded = row.revokedAt !== null && snap.meta?.superseded === true;
  if (row.revokedAt !== null && !superseded) return { status: "revoked" };

  const transcript: TranscriptViewModel = {
    ...snap.transcript,
    resident: {
      ...snap.transcript.resident,
      matric: maskMatric(snap.transcript.resident.matric),
    },
  };
  return {
    status: superseded ? "superseded" : "valid",
    academicYear: row.academicYear,
    issuedAt: snap.issuedAt,
    transcript,
  };
}
