import { describe, expect, it } from "vitest";

import {
  CATEGORY_REQUIREMENTS,
  NOT_YET_STORED,
  PROPOSAL_CATEGORIES,
  missingForSubmit,
  type SubmitContent,
} from "../categories";
import {
  EDITABLE_STATUSES,
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  SUBMITTABLE_STATUSES,
  canTransition,
  isProposalStatus,
} from "../status";
import {
  proposalCreateInput,
  proposalUpdateInput,
} from "~/lib/schemas/proposal";

describe("the transition table", () => {
  it("has an entry for every status and only for statuses", () => {
    expect(Object.keys(PROPOSAL_TRANSITIONS).sort()).toEqual(
      [...PROPOSAL_STATUSES].sort(),
    );
    for (const targets of Object.values(PROPOSAL_TRANSITIONS)) {
      for (const t of targets) expect(isProposalStatus(t)).toBe(true);
    }
  });

  it("allows approve and return only from in_review", () => {
    for (const from of PROPOSAL_STATUSES) {
      expect(canTransition(from, "cleared")).toBe(from === "in_review");
      // needs_action is reached only by a return, and a return only happens
      // from in_review.
      expect(canTransition(from, "needs_action")).toBe(from === "in_review");
    }
  });

  it("lets a head submit from draft and resubmit from needs_action, only", () => {
    for (const from of PROPOSAL_STATUSES) {
      expect(canTransition(from, "in_review")).toBe(
        from === "draft" || from === "needs_action",
      );
    }
    expect([...SUBMITTABLE_STATUSES].sort()).toEqual(
      ["draft", "needs_action"].sort(),
    );
    expect([...EDITABLE_STATUSES].sort()).toEqual(
      ["draft", "needs_action"].sort(),
    );
  });

  it("finishes only an approved proposal and leaves final statuses final", () => {
    for (const from of PROPOSAL_STATUSES) {
      expect(canTransition(from, "finished")).toBe(from === "cleared");
    }
    expect(PROPOSAL_TRANSITIONS.finished).toEqual([]);
    expect(PROPOSAL_TRANSITIONS.canceled).toEqual([]);
  });

  it("never allows a status to move to itself", () => {
    for (const s of PROPOSAL_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("rejects values that are not statuses", () => {
    expect(isProposalStatus("published")).toBe(false);
    expect(isProposalStatus(undefined)).toBe(false);
  });
});

describe("category rules", () => {
  const complete: SubmitContent = {
    category: "pubs",
    title: "Pub night",
    description: "A night at the pub",
    blastMessage: "Come along",
    plannedStart: 1_800_000_000,
    plannedEnd: 1_800_003_600,
  };

  it("has a rule row for every category", () => {
    expect(Object.keys(CATEGORY_REQUIREMENTS).sort()).toEqual(
      [...PROPOSAL_CATEGORIES].sort(),
    );
  });

  it("matches the table in the proposal", () => {
    expect(CATEGORY_REQUIREMENTS).toEqual({
      event: ["plannedStart", "blastMessage", "poster", "docLink"],
      initiative: ["plannedStart", "blastMessage", "poster"],
      welfare: ["blastMessage", "poster"],
      decor: [],
      pantry_cleaning: ["plannedStart"],
      merch: ["poster", "docLink"],
      pubs: [],
    });
  });

  it("asks every category for a title and a description", () => {
    for (const category of PROPOSAL_CATEGORIES) {
      expect(
        missingForSubmit({
          ...complete,
          category,
          title: " ",
          description: "",
        }),
      ).toEqual(expect.arrayContaining(["A title", "A description"]));
    }
  });

  it("asks for the date, and the blast message, exactly where the table says", () => {
    const bare: SubmitContent = {
      ...complete,
      blastMessage: null,
      plannedStart: null,
      plannedEnd: null,
    };
    for (const category of PROPOSAL_CATEGORIES) {
      const missing = missingForSubmit({ ...bare, category });
      const wants = CATEGORY_REQUIREMENTS[category];
      expect(missing.some((m) => m.includes("start date"))).toBe(
        wants.includes("plannedStart"),
      );
      expect(missing.some((m) => m.includes("blast"))).toBe(
        wants.includes("blastMessage"),
      );
    }
  });

  it("does not ask a welfare proposal for a date (the server rule, not the old form's)", () => {
    expect(
      missingForSubmit({
        ...complete,
        category: "welfare",
        plannedStart: null,
        plannedEnd: null,
      }),
    ).toEqual([]);
  });

  it("treats a blank blast message as missing", () => {
    expect(
      missingForSubmit({ ...complete, category: "event", blastMessage: "  " }),
    ).toEqual(["A blast message"]);
  });

  it("accepts a complete proposal of every category while posters and links are not stored", () => {
    expect(NOT_YET_STORED).toEqual(["poster", "docLink"]);
    for (const category of PROPOSAL_CATEGORIES) {
      expect(missingForSubmit({ ...complete, category })).toEqual([]);
    }
  });

  it("refuses an end that is not after the start", () => {
    expect(
      missingForSubmit({ ...complete, plannedEnd: complete.plannedStart }),
    ).toEqual(["An end that is after the start"]);
  });
});

describe("the save schemas", () => {
  const base = { ccaID: 7, category: "pubs", title: "  Pub night  " };

  it("trims, defaults the optional fields to explicit nulls and keeps the rest", () => {
    const parsed = proposalCreateInput.parse(base);
    expect(parsed).toEqual({
      ccaID: 7,
      category: "pubs",
      title: "Pub night",
      description: "",
      blastMessage: null,
      plannedStart: null,
      plannedEnd: null,
    });
  });

  it("strips control characters but keeps line breaks", () => {
    const parsed = proposalCreateInput.parse({
      ...base,
      description: "a\u0000b​c\nd",
    });
    expect(parsed.description).toBe("abc\nd");
  });

  it("caps the planned dates at the largest 32-bit integer the columns hold", () => {
    const LIMIT = 2_147_483_647;
    for (const key of ["plannedStart", "plannedEnd"] as const) {
      expect(
        proposalCreateInput.safeParse({ ...base, [key]: LIMIT }).success,
        key,
      ).toBe(true);
      expect(
        proposalCreateInput.safeParse({ ...base, [key]: LIMIT + 1 }).success,
        key,
      ).toBe(false);
      expect(
        proposalUpdateInput.safeParse({
          id: "0123456789abcdef01234567",
          version: 0,
          [key]: LIMIT + 1,
        }).success,
        key,
      ).toBe(false);
    }
  });

  it("turns a blank blast message into null", () => {
    expect(
      proposalCreateInput.parse({ ...base, blastMessage: "   " }).blastMessage,
    ).toBeNull();
  });

  it("refuses an unknown category, an empty title, a bad cca id and an end before the start", () => {
    expect(
      proposalCreateInput.safeParse({ ...base, category: "other" }).success,
    ).toBe(false);
    expect(
      proposalCreateInput.safeParse({ ...base, title: "   " }).success,
    ).toBe(false);
    expect(proposalCreateInput.safeParse({ ...base, ccaID: 0 }).success).toBe(
      false,
    );
    expect(
      proposalCreateInput.safeParse({
        ...base,
        plannedStart: 1_800_003_600,
        plannedEnd: 1_800_000_000,
      }).success,
    ).toBe(false);
  });

  it("refuses an over-long title and description", () => {
    expect(
      proposalCreateInput.safeParse({ ...base, title: "x".repeat(201) })
        .success,
    ).toBe(false);
    expect(
      proposalCreateInput.safeParse({
        ...base,
        description: "x".repeat(5001),
      }).success,
    ).toBe(false);
  });

  it("an update needs an id and the version the editor loaded, and carries no status", () => {
    const id = "a".repeat(24);
    expect(proposalUpdateInput.safeParse({ id }).success).toBe(false);
    const ok = proposalUpdateInput.parse({
      id,
      version: 3,
      status: "cleared",
      title: "New",
    });
    expect(ok).toEqual({ id, version: 3, title: "New" });
    expect("status" in ok).toBe(false);
  });
});
