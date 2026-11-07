import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { JCRC_ROLE, normalizeStoredRoles } from "~/server/api/services/roles";

// The doctor's pure rules, imported without running the script (no database).
const lib = pathToFileURL(
  join(process.cwd(), "scripts", "remediation", "lib", "directorChecks.mjs"),
).href;

type Check = {
  label: string;
  offenders: string[];
  always: boolean;
  blocks: "proposals" | "disposables" | null;
  note: string;
};
type Input = {
  ccas: { ccaID: number; ccaName: string }[];
  positions: {
    id: string;
    name: string;
    vetsProposals: boolean;
    handlesDisposables: boolean;
  }[];
  links: { positionID: string; ccaID: number }[];
  holders: { positionID: string; userID: string; endsAt: Date | null }[];
  userRoles: { userID: string; roles?: string[]; role?: string }[];
  terms: { userID: string; endsAt: Date }[];
  now: Date;
};
const {
  evaluateDirectorChecks,
  liveJcrcSet,
  isGating,
  proposalsNeedDirectors,
} = (await import(/* @vite-ignore */ lib)) as {
  evaluateDirectorChecks: (input: Input) => {
    flaggedPositions: number;
    checks: Check[];
  };
  isGating: (
    check: Pick<Check, "always" | "blocks">,
    state: { flagArg: boolean; directorsOn: boolean; proposalsOn: boolean },
  ) => boolean;
  proposalsNeedDirectors: (state: {
    proposalsOn: boolean;
    directorsOn: boolean;
  }) => { label: string; offenders: string[]; note: string } | null;
  liveJcrcSet: (
    userRoles: Input["userRoles"],
    terms: Input["terms"],
    now: Date,
  ) => Set<string>;
};

const NOW = new Date("2027-01-10T00:00:00Z");
const PAST = new Date("2027-01-01T00:00:00Z");
const FUTURE = new Date("2027-02-01T00:00:00Z");

const base = (over: Partial<Input> = {}): Input => ({
  ccas: [
    { ccaID: 1, ccaName: "Basketball" },
    { ccaID: 2, ccaName: "Choir" },
  ],
  positions: [
    {
      id: "p1",
      name: "Sports Director",
      vetsProposals: true,
      handlesDisposables: false,
    },
    {
      id: "p2",
      name: "Social Director",
      vetsProposals: true,
      handlesDisposables: true,
    },
  ],
  links: [
    { positionID: "p1", ccaID: 1 },
    { positionID: "p2", ccaID: 2 },
  ],
  holders: [
    { positionID: "p1", userID: "E1", endsAt: null },
    { positionID: "p2", userID: "E2", endsAt: FUTURE },
  ],
  userRoles: [
    { userID: "E1", roles: ["resident", "jcrc"] },
    { userID: "E2", roles: ["resident", "jcrc"] },
  ],
  terms: [],
  now: NOW,
  ...over,
});

const check = (
  result: ReturnType<typeof evaluateDirectorChecks>,
  part: string,
) => result.checks.find((c) => c.label.includes(part))!;
const redNow = (result: ReturnType<typeof evaluateDirectorChecks>) =>
  result.checks.filter((c) => c.offenders.length > 0).map((c) => c.label);

describe("liveJcrcSet: who holds jcrc right now", () => {
  it("needs the stored role and no ended step-out date", () => {
    const set = liveJcrcSet(
      [
        { userID: "A", roles: ["jcrc"] },
        { userID: "B", roles: ["resident"] },
        { userID: "C", roles: ["jcrc"] },
        { userID: "D", roles: [], role: "jcrc" },
        { userID: "E", roles: ["jcrc"] },
      ],
      [
        { userID: "C", endsAt: PAST },
        { userID: "E", endsAt: FUTURE },
      ],
      NOW,
    );
    expect([...set].sort()).toEqual(["A", "D", "E"]);
  });
});

describe("liveJcrcSet reads stored roles the way the guard does", () => {
  // The guard normalises with normalizeStoredRoles (TypeScript, so a .mjs
  // script cannot import it). This keeps the doctor's copy in step with it.
  const stored: { roles?: string[]; role?: string }[] = [
    { roles: ["jcrc"] },
    { roles: ["resident", "jcrc"] },
    { roles: ["JCRC"] },
    { roles: [" jcrc"] },
    { roles: ["jcrc_old"] },
    { roles: [], role: "jcrc" },
    { roles: [], role: "resident" },
    { roles: ["scrc"] },
    { roles: [] },
    {},
  ];
  it.each(stored.map((row, i) => [i, row] as const))(
    "agrees for stored row %i",
    (i, row) => {
      const raw = row.roles?.length ? row.roles : row.role ? [row.role] : [];
      const guard = normalizeStoredRoles(raw).includes(JCRC_ROLE);
      const doctor = liveJcrcSet([{ userID: "U", ...row }], [], NOW).has("U");
      expect(doctor).toBe(guard);
    },
  );
});

describe("a passing state", () => {
  it("reports nothing wrong when every CCA has a director and one position handles disposables", () => {
    const result = evaluateDirectorChecks(base());
    expect(result.flaggedPositions).toBe(2);
    expect(redNow(result)).toEqual([]);
  });

  it("counts a CCA under two flagged positions as covered by either", () => {
    const result = evaluateDirectorChecks(
      base({
        links: [
          { positionID: "p1", ccaID: 1 },
          { positionID: "p2", ccaID: 1 },
          { positionID: "p2", ccaID: 2 },
        ],
        holders: [{ positionID: "p2", userID: "E2", endsAt: null }],
      }),
    );
    expect(redNow(result)).toEqual([]);
  });
});

describe("CCAs without a current qualifying director", () => {
  const label = "CCAs";

  it("lists a CCA that no flagged position lists", () => {
    const result = evaluateDirectorChecks(
      base({ links: [{ positionID: "p2", ccaID: 2 }] }),
    );
    expect(check(result, label).offenders).toEqual(["1 (Basketball)"]);
    expect(check(result, label).always).toBe(false);
  });

  it("lists a CCA that only an unflagged position lists", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: [
          ...base().positions,
          {
            id: "p3",
            name: "Culture",
            vetsProposals: false,
            handlesDisposables: false,
          },
        ],
        links: [
          { positionID: "p3", ccaID: 1 },
          { positionID: "p2", ccaID: 2 },
        ],
        holders: [
          ...base().holders,
          { positionID: "p3", userID: "E1", endsAt: null },
        ],
      }),
    );
    expect(check(result, label).offenders).toEqual(["1 (Basketball)"]);
  });

  it("lists a CCA whose only flagged position has no holder, every row ended, or holders without jcrc", () => {
    for (const holders of [
      [{ positionID: "p2", userID: "E2", endsAt: FUTURE }],
      [
        { positionID: "p1", userID: "E1", endsAt: PAST },
        { positionID: "p2", userID: "E2", endsAt: FUTURE },
      ],
      [
        { positionID: "p1", userID: "E3", endsAt: null },
        { positionID: "p2", userID: "E2", endsAt: FUTURE },
      ],
    ]) {
      const result = evaluateDirectorChecks(base({ holders }));
      expect(check(result, label).offenders, JSON.stringify(holders)).toEqual([
        "1 (Basketball)",
      ]);
    }
  });

  it("lists a CCA whose holder's jcrc step-out date has passed", () => {
    const result = evaluateDirectorChecks(
      base({ terms: [{ userID: "E1", endsAt: PAST }] }),
    );
    expect(check(result, label).offenders).toEqual(["1 (Basketball)"]);
  });

  it("does not count a position flagged only for disposables as vetting", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: [
          {
            id: "p1",
            name: "Sports Director",
            vetsProposals: false,
            handlesDisposables: true,
          },
          {
            id: "p2",
            name: "Social Director",
            vetsProposals: true,
            handlesDisposables: false,
          },
        ],
      }),
    );
    expect(check(result, label).offenders).toEqual(["1 (Basketball)"]);
  });

  it("lists every CCA when nothing is flagged yet", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: base().positions.map((p) => ({
          ...p,
          vetsProposals: false,
          handlesDisposables: false,
        })),
      }),
    );
    expect(result.flaggedPositions).toBe(0);
    expect(check(result, label).offenders).toEqual([
      "1 (Basketball)",
      "2 (Choir)",
    ]);
  });
});

describe("the position flagged for disposables", () => {
  it("is not flagged at all: listed, and only a gate", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: base().positions.map((p) => ({
          ...p,
          handlesDisposables: false,
        })),
      }),
    );
    const holder = check(result, "has a current qualifying holder");
    expect(holder.offenders).toEqual(["no position is flagged"]);
    expect(holder.always).toBe(false);
    expect(check(result, "more than one").offenders).toEqual([]);
  });

  it("is flagged but vacant", () => {
    const result = evaluateDirectorChecks(
      base({
        holders: [{ positionID: "p1", userID: "E1", endsAt: null }],
      }),
    );
    expect(check(result, "has a current qualifying holder").offenders).toEqual([
      "Social Director",
    ]);
  });

  it("is flagged, held, but the holder lacks jcrc", () => {
    const result = evaluateDirectorChecks(
      base({ userRoles: [{ userID: "E1", roles: ["resident", "jcrc"] }] }),
    );
    expect(check(result, "has a current qualifying holder").offenders).toEqual([
      "Social Director",
    ]);
  });

  it("warns clearly about a second flag, and always counts it as wrong", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: base().positions.map((p) => ({
          ...p,
          handlesDisposables: true,
        })),
      }),
    );
    const many = check(result, "more than one");
    expect(many.offenders).toEqual(["Sports Director", "Social Director"]);
    expect(many.always).toBe(true);
    expect(many.note).toMatch(/WARNING.*silently.*nobody/i);
    // The holder line does not pile on: the second flag is the problem.
    expect(check(result, "has a current qualifying holder").offenders).toEqual(
      [],
    );
  });
});

describe("holders of flagged positions who lack jcrc", () => {
  const label = "without jcrc";

  it("lists a current holder with no jcrc, and counts it as always wrong", () => {
    const result = evaluateDirectorChecks(
      base({
        holders: [
          ...base().holders,
          { positionID: "p1", userID: "E3", endsAt: null },
        ],
      }),
    );
    expect(check(result, label).offenders).toEqual(["E3 on Sports Director"]);
    expect(check(result, label).always).toBe(true);
  });

  it("lists a holder whose jcrc ended, but not a holder whose row ended", () => {
    const result = evaluateDirectorChecks(
      base({
        terms: [{ userID: "E1", endsAt: PAST }],
        holders: [
          ...base().holders,
          { positionID: "p1", userID: "E3", endsAt: PAST },
        ],
      }),
    );
    expect(check(result, label).offenders).toEqual(["E1 on Sports Director"]);
  });

  it("ignores holders of unflagged positions", () => {
    const result = evaluateDirectorChecks(
      base({
        positions: [
          ...base().positions,
          {
            id: "p3",
            name: "Culture",
            vetsProposals: false,
            handlesDisposables: false,
          },
        ],
        holders: [
          ...base().holders,
          { positionID: "p3", userID: "E9", endsAt: null },
        ],
      }),
    );
    expect(check(result, label).offenders).toEqual([]);
  });
});

describe('isGating: which switch turns a "not set up" line RED', () => {
  const off = { flagArg: false, directorsOn: false, proposalsOn: false };
  const noDirector = (c = base()) =>
    check(
      evaluateDirectorChecks(c),
      "CCAs with no current qualifying director",
    );
  const social = (c = base()) =>
    check(
      evaluateDirectorChecks(c),
      "handlesDisposables position has a current qualifying holder",
    );

  it("tags each not-set-up line with the switch it blocks", () => {
    expect(noDirector().blocks).toBe("proposals");
    expect(social().blocks).toBe("disposables");
    expect(noDirector().always).toBe(false);
    expect(social().always).toBe(false);
  });

  it("with every switch off, neither not-set-up line gates", () => {
    expect(isGating(noDirector(), off)).toBe(false);
    expect(isGating(social(), off)).toBe(false);
  });

  it("proposals.enabled on makes the no-director line gate, and only that one", () => {
    const on = { ...off, proposalsOn: true };
    expect(isGating(noDirector(), on)).toBe(true);
    expect(isGating(social(), on)).toBe(false);
  });

  it("--directors or directors.enabled gates both, as before", () => {
    for (const state of [
      { ...off, flagArg: true },
      { ...off, directorsOn: true },
    ]) {
      expect(isGating(noDirector(), state)).toBe(true);
      expect(isGating(social(), state)).toBe(true);
    }
  });

  it("a line that is wrong whenever it appears always gates", () => {
    const result = evaluateDirectorChecks(base());
    for (const c of result.checks.filter((c) => c.always)) {
      expect(isGating(c, off)).toBe(true);
    }
  });

  it("only an exact true counts as the proposals switch", () => {
    expect(
      isGating(noDirector(), { ...off, proposalsOn: undefined as never }),
    ).toBe(false);
  });
});

describe("proposalsNeedDirectors: proposals on, directors off", () => {
  it("is a RED line that names the switch to turn on", () => {
    const line = proposalsNeedDirectors({
      proposalsOn: true,
      directorsOn: false,
    });
    expect(line).not.toBeNull();
    expect(line?.offenders).toEqual(["turn on directors.enabled"]);
    expect(line?.label).toContain("proposals.enabled is on");
    expect(line?.label).toContain("directors.enabled is off");
  });

  it("says nothing when directors are on, or proposals are off", () => {
    for (const state of [
      { proposalsOn: true, directorsOn: true },
      { proposalsOn: false, directorsOn: false },
      { proposalsOn: false, directorsOn: true },
    ]) {
      expect(proposalsNeedDirectors(state)).toBeNull();
    }
  });

  it("only an exact true counts as proposals on", () => {
    expect(
      proposalsNeedDirectors({
        proposalsOn: undefined as never,
        directorsOn: false,
      }),
    ).toBeNull();
  });
});
