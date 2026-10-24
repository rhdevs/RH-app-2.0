import { describe, expect, it, vi } from "vitest";

import { PROCEDURE_ACCESS, PROCEDURE_ROUTERS } from "./procedureAccess";

/**
 * DATABASE-FREE (so CI runs it): the access table must list EVERY procedure of
 * the `transcript` and `transcriptManage` routers, and nothing else. A new
 * procedure fails this test until it is added to procedureAccess.ts with its
 * access class; a removed one fails until it is taken out.
 */
vi.stubEnv("SKIP_ENV_VALIDATION", "1");

const procedures = async () => {
  const { appRouter } = await import("~/server/api/root");
  return Object.keys(
    (appRouter as unknown as { _def: { procedures: object } })._def.procedures,
  )
    .filter((path) => PROCEDURE_ROUTERS.some((r) => path.startsWith(r)))
    .sort();
};

describe("the transcript procedures and their access classes", () => {
  it("has a class for every procedure of both routers, and no stale entry", async () => {
    const actual = await procedures();

    const missing = actual.filter((p) => !(p in PROCEDURE_ACCESS));
    const stale = Object.keys(PROCEDURE_ACCESS).filter(
      (p) => !actual.includes(p),
    );

    expect(missing, "in a router but not in the table").toEqual([]);
    expect(stale, "in the table but not in a router").toEqual([]);
  }, 60_000);

  it("uses only the four known classes, and keeps every writer off resident-self", () => {
    const classes = new Set(Object.values(PROCEDURE_ACCESS));
    expect([...classes].sort()).toEqual([
      "head-or-manager",
      "manager-only",
      "resident-self",
      "signed-in-ungated",
    ]);
    // Resident-self procedures take no resident id: only the signed-in person.
    const own = Object.entries(PROCEDURE_ACCESS)
      .filter(([, a]) => a === "resident-self")
      .map(([p]) => p);
    expect(
      own.every((p) =>
        /\.(mine|saveMine|get|years|readiness|markOpened)$/.test(p),
      ),
    ).toBe(true);
  });

  it("treats preview, Open transcripts and every correction as manager-only", () => {
    for (const p of [
      "transcript.preview",
      "transcript.periods.open",
      "transcriptManage.corrections.unlock",
      "transcriptManage.corrections.withhold",
      "transcriptManage.awardImport.commit",
    ]) {
      expect(PROCEDURE_ACCESS[p], p).toBe("manager-only");
    }
  });
});
