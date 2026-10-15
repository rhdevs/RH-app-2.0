import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assembleTranscript } from "~/lib/transcript/assemble";
import { getFixtureBySlug } from "~/lib/transcript/fixtures";
import {
  CODE_ALPHABET,
  CODE_PATTERN,
  generateCode,
  maskMatric,
  verifyCode,
} from "../issue";

const VALID_CODE = "RH-ABCDEFGHJKMNPQRS";

function snapshot(meta?: object) {
  const fixture = getFixtureBySlug("plain-member")!;
  const transcript = assembleTranscript(fixture.input, "AY2026/27");
  return {
    issuedAt: "2027-05-10T00:00:00.000Z",
    transcript,
    ...(meta ? { meta } : {}),
  };
}

/** A stand-in database that answers one lookup and has nothing else. */
function dbReturning(row: object | null) {
  const findUnique = vi.fn(async () => row);
  return {
    db: { transcriptIssue: { findUnique } } as unknown as PrismaClient,
    findUnique,
  };
}

describe("generateCode", () => {
  it("is 'RH-' plus 16 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();

      expect(code).toMatch(CODE_PATTERN);
      expect(code).toHaveLength(19);
      for (const ch of code.slice(3)) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it("excludes the look-alike characters", () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    for (const bad of ["0", "1", "O", "I", "L"]) {
      expect(CODE_ALPHABET).not.toContain(bad);
    }
  });

  it("never repeats across 10000 codes", () => {
    const codes = new Set(Array.from({ length: 10_000 }, () => generateCode()));

    expect(codes.size).toBe(10_000);
  });

  it("uses every symbol about equally often (no modulo bias)", () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 10_000; i += 1) {
      for (const ch of generateCode().slice(3)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }

    const expected = (10_000 * 16) / CODE_ALPHABET.length;
    expect(counts.size).toBe(CODE_ALPHABET.length);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.9);
      expect(n).toBeLessThan(expected * 1.1);
    }
  });

  it("skips bytes that would bias the draw", () => {
    // 255 is >= 248 (8 * 31) and must be skipped; the other bytes are 0, 1, 2, ...
    const bytes = (n: number) =>
      Uint8Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? 255 : (i - 1) / 2,
      );

    const code = generateCode(bytes);

    expect(code).toMatch(CODE_PATTERN);
    expect(code).toBe("RH-23456789ABCDEFGH");
  });

  it("does not use Math.random", () => {
    const spy = vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Math.random must not be used for codes");
    });

    expect(() => generateCode()).not.toThrow();
    spy.mockRestore();
  });
});

describe("maskMatric", () => {
  it("keeps only the first and last character", () => {
    expect(maskMatric("A0001000X")).toBe("A*******X");
    expect(maskMatric("A0001000X")).toHaveLength("A0001000X".length);
  });

  it.each([
    ["", ""],
    ["A", "*"],
    ["AB", "**"],
    ["ABC", "A*C"],
  ])("handles short input %j", (input, expected) => {
    expect(maskMatric(input)).toBe(expected);
  });
});

describe("verifyCode: input handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    "",
    "   ",
    "RH-SHORT",
    "RH-ABCDEFGHJKMNPQRST",
    "XX-ABCDEFGHJKMNPQRS",
    "RH-ABCDEFGHJKMNPQR0",
    "RH-ABCDEFGHJKMNPQ' OR 1",
    "../../etc/passwd",
    "<script>alert(1)</script>",
  ])(
    "answers not_found for malformed input %j without touching the database",
    async (code) => {
      const { db, findUnique } = dbReturning(null);

      expect(await verifyCode(db, code)).toEqual({ status: "not_found" });
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it("normalises case and surrounding spaces before the lookup", async () => {
    const { db, findUnique } = dbReturning(null);

    await verifyCode(db, `  ${VALID_CODE.toLowerCase()} `);

    expect(findUnique).toHaveBeenCalledWith({ where: { code: VALID_CODE } });
  });

  it("answers not_found for an unknown code, the same as for a malformed one", async () => {
    const { db } = dbReturning(null);

    expect(await verifyCode(db, VALID_CODE)).toEqual({ status: "not_found" });
  });

  it("answers not_found for a row whose snapshot is unreadable", async () => {
    const { db } = dbReturning({
      code: VALID_CODE,
      revokedAt: null,
      snapshot: null,
    });

    expect(await verifyCode(db, VALID_CODE)).toEqual({ status: "not_found" });
  });
});

describe("verifyCode: results", () => {
  const row = (over: object) => ({
    code: VALID_CODE,
    academicYear: "AY2026/27",
    revokedAt: null,
    snapshot: snapshot(),
    ...over,
  });

  it("returns the record for a valid code, with the matric masked", async () => {
    const { db } = dbReturning(row({}));

    const result = await verifyCode(db, VALID_CODE);

    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.transcript.resident.matric).toBe("A*******X");
    expect(result.transcript.resident.name).toBe("Lim Wei Xiang");
    expect(result.academicYear).toBe("AY2026/27");
    expect(JSON.stringify(result)).not.toContain("A0001000X");
  });

  it("returns the record for a superseded code, also masked", async () => {
    const { db } = dbReturning(
      row({
        revokedAt: new Date(),
        snapshot: snapshot({
          superseded: true,
          reason: "Academic year reopened",
        }),
      }),
    );

    const result = await verifyCode(db, VALID_CODE);

    expect(result.status).toBe("superseded");
    if (result.status !== "superseded") return;
    expect(result.transcript.resident.matric).toBe("A*******X");
  });

  it("returns no record at all for a revoked code", async () => {
    const { db } = dbReturning(row({ revokedAt: new Date() }));

    expect(await verifyCode(db, VALID_CODE)).toEqual({ status: "revoked" });
  });

  it("does not mutate the stored snapshot when masking", async () => {
    const stored = snapshot();
    const { db } = dbReturning(row({ snapshot: stored }));

    await verifyCode(db, VALID_CODE);

    expect(stored.transcript.resident.matric).toBe("A0001000X");
  });
});
