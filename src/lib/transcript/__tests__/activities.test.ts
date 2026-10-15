import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_TITLE_MAX,
  MAX_ACTIVITIES,
  MAX_PARTICIPANTS,
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
  activityCountLine,
  compareActivities,
  diffParticipants,
  firstDuplicate,
  participantText,
  periodSuffix,
  readPeriod,
  type ExistingParticipant,
} from "../activities";
import { assembleTranscript, MISSING_DESCRIPTION_TEXT } from "../assemble";
import { FIXTURE_ACADEMIC_YEAR, getFixtureBySlug } from "../fixtures";
import {
  activityCreateInput,
  activityUpdateInput,
  participantsSetInput,
} from "../manageInput";
import type {
  ActivityInput,
  TranscriptInput,
  TranscriptPage,
  TranscriptSection,
  TranscriptViewModel,
} from "../types";

const AY = FIXTURE_ACADEMIC_YEAR;
const ID = "0123456789abcdef01234567";

function activity(over: Partial<ActivityInput> = {}): ActivityInput {
  return {
    academicYear: AY,
    ccaName: "Hall Choir",
    title: "Concert",
    description: null,
    period: "full",
    role: null,
    personDescription: null,
    isMember: true,
    ...over,
  };
}

function inputWith(
  activities: ActivityInput[],
  ccas: string[] = ["Hall Choir"],
): TranscriptInput {
  return {
    resident: { name: "Test", matric: "A0000000X", isSpecimen: true },
    issues: [
      { academicYear: AY, issuedOn: null, block: null, yearOfResidence: null },
    ],
    memberships: ccas.map((ccaName) => ({
      ccaName,
      category: "C",
      academicYear: AY,
      leadershipRole: null,
      description: `${ccaName} description.`,
      extraContribution: null,
    })),
    regularVolunteering: [],
    oneOffVolunteering: [],
    awards: [],
    jcrc: null,
    activities,
  };
}

function section<K extends TranscriptSection["kind"]>(
  vm: TranscriptViewModel,
  kind: K,
) {
  const main = vm.pages.find((p) => p.kind === "main") as Extract<
    TranscriptPage,
    { kind: "main" }
  >;
  return main.sections.find(
    (s): s is Extract<TranscriptSection, { kind: K }> => s.kind === kind,
  );
}

const notesPage = (vm: TranscriptViewModel) =>
  vm.pages.find((p) => p.kind === "notes") as Extract<
    TranscriptPage,
    { kind: "notes" }
  >;

describe("activity limits", () => {
  it("fixes the limits the prompt names", () => {
    expect(MAX_ACTIVITIES).toBe(20);
    expect(MAX_PARTICIPANTS).toBe(200);
    expect(ACTIVITY_TITLE_MAX).toBe(80);
    expect(ACTIVITY_DESCRIPTION_MAX).toBe(300);
    expect(PARTICIPANT_ROLE_MAX).toBe(60);
    expect(PARTICIPANT_DESCRIPTION_MAX).toBe(300);
    expect(activityCountLine(3)).toBe("3 of 20");
  });

  it("reads an unknown period as the full year", () => {
    expect(readPeriod("sem2")).toBe("sem2");
    expect(readPeriod("nonsense")).toBe("full");
    expect(readPeriod(null)).toBe("full");
    expect(periodSuffix("sem1")).toBe(" (Sem 1)");
    expect(periodSuffix("sem2")).toBe(" (Sem 2)");
    expect(periodSuffix("full")).toBe("");
  });

  it("orders full year, then semester 1, then semester 2, then by title", () => {
    const rows = [
      { period: "sem2" as const, title: "A" },
      { period: "full" as const, title: "Z" },
      { period: "sem1" as const, title: "M" },
      { period: "full" as const, title: "B" },
    ];
    expect(
      [...rows].sort(compareActivities).map((r) => `${r.period}:${r.title}`),
    ).toEqual(["full:B", "full:Z", "sem1:M", "sem2:A"]);
  });
});

describe("activity input rules", () => {
  const scope = { ccaID: 7, academicYear: AY };

  it("accepts a valid activity and trims it", () => {
    const parsed = activityCreateInput.parse({
      ...scope,
      title: "  Annual concert ",
      description: "",
      period: "sem1",
    });
    expect(parsed.title).toBe("Annual concert");
    expect(parsed.description).toBe("");
  });

  it("refuses an empty, over-long or control-character title", () => {
    const base = { ...scope, description: "", period: "full" };
    expect(
      activityCreateInput.safeParse({ ...base, title: "   " }).success,
    ).toBe(false);
    expect(
      activityCreateInput.safeParse({ ...base, title: "x".repeat(81) }).success,
    ).toBe(false);
    expect(
      activityCreateInput.safeParse({ ...base, title: "x".repeat(80) }).success,
    ).toBe(true);
    expect(
      activityCreateInput.safeParse({ ...base, title: "a\u0000b" }).success,
    ).toBe(false);
  });

  it("limits the description to 300 characters and refuses invisible ones", () => {
    const base = { ...scope, title: "T", period: "full" };
    expect(
      activityCreateInput.safeParse({
        ...base,
        description: "x".repeat(301),
      }).success,
    ).toBe(false);
    expect(
      activityCreateInput.safeParse({
        ...base,
        description: "x".repeat(300),
      }).success,
    ).toBe(true);
    expect(
      activityCreateInput.safeParse({ ...base, description: "a‮b" }).success,
    ).toBe(false);
  });

  it("accepts only the three periods", () => {
    const base = { ...scope, title: "T", description: "" };
    for (const period of ["full", "sem1", "sem2"]) {
      expect(activityCreateInput.safeParse({ ...base, period }).success).toBe(
        true,
      );
    }
    expect(
      activityCreateInput.safeParse({ ...base, period: "sem3" }).success,
    ).toBe(false);
  });

  it("needs a real activity id to update", () => {
    const body = { ccaID: 7, title: "T", description: "", period: "full" };
    expect(activityUpdateInput.safeParse({ ...body, id: ID }).success).toBe(
      true,
    );
    expect(activityUpdateInput.safeParse({ ...body, id: "nope" }).success).toBe(
      false,
    );
  });

  it("limits a participant's role to 60 and description to 300", () => {
    const row = (role: string, description: string) =>
      participantsSetInput.safeParse({
        id: ID,
        ccaID: 7,
        participants: [{ userID: "e0000001", role, description }],
      }).success;
    expect(row("x".repeat(60), "")).toBe(true);
    expect(row("x".repeat(61), "")).toBe(false);
    expect(row("", "x".repeat(300))).toBe(true);
    expect(row("", "x".repeat(301))).toBe(false);
  });

  it("allows at most 200 participants", () => {
    const people = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        userID: `e${String(i).padStart(7, "0")}`,
        role: "",
        description: "",
      }));
    const parse = (n: number) =>
      participantsSetInput.safeParse({
        id: ID,
        ccaID: 7,
        participants: people(n),
      }).success;
    expect(parse(200)).toBe(true);
    expect(parse(201)).toBe(false);
    expect(parse(0)).toBe(true);
  });
});

describe("participantText and firstDuplicate", () => {
  it("prefers the person's description, then the activity's, then blank", () => {
    expect(
      participantText("General", { role: "Lead", description: "Mine" }),
    ).toEqual({ role: "Lead", description: "Mine" });
    expect(
      participantText("General", { role: null, description: "  " }),
    ).toEqual({ role: "", description: "General" });
    expect(participantText(null, { role: null, description: null })).toEqual({
      role: "",
      description: "",
    });
  });

  it("finds the first repeated key", () => {
    expect(firstDuplicate(["a", "b", "a"])).toBe("a");
    expect(firstDuplicate(["a", "b"])).toBeNull();
  });
});

describe("diffParticipants (participants.set)", () => {
  const existing = (
    userID: string,
    over: Partial<ExistingParticipant> = {},
  ): ExistingParticipant => ({
    id: `id-${userID}`,
    userID,
    role: null,
    description: null,
    removed: false,
    ...over,
  });
  const want = (userID: string, role = "", description = "") => ({
    userID,
    role,
    description,
  });

  it("adds new people, removes missing ones and leaves the rest alone", () => {
    const diff = diffParticipants(
      [existing("a"), existing("b")],
      [want("a"), want("c")],
    );
    expect(diff.add.map((d) => d.userID)).toEqual(["c"]);
    expect(diff.remove.map((d) => d.userID)).toEqual(["b"]);
    expect(diff.update).toEqual([]);
    expect(diff.restore).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("updates a person only when their role or description changed", () => {
    const diff = diffParticipants(
      [existing("a", { role: "Lead" }), existing("b", { role: "Lead" })],
      [want("a", "Lead"), want("b", "Deputy")],
    );
    expect(diff.update.map((d) => d.userID)).toEqual(["b"]);
    expect(diff.unchanged).toBe(1);
  });

  it("treats a blank and a missing value as the same", () => {
    const diff = diffParticipants(
      [existing("a", { role: null, description: "  " })],
      [want("a", "", "")],
    );
    expect(diff.update).toEqual([]);
    expect(diff.unchanged).toBe(1);
  });

  it("brings a removed person back on their old row", () => {
    const diff = diffParticipants(
      [existing("a", { removed: true })],
      [want("a", "Lead")],
    );
    expect(diff.restore).toEqual([
      { id: "id-a", userID: "a", role: "Lead", description: "" },
    ]);
    expect(diff.add).toEqual([]);
  });

  it("does not remove someone who is already removed", () => {
    const diff = diffParticipants([existing("a", { removed: true })], []);
    expect(diff.remove).toEqual([]);
  });

  it("an empty list removes everyone active", () => {
    const diff = diffParticipants([existing("a"), existing("b")], []);
    expect(diff.remove).toHaveLength(2);
  });
});

describe("assembleTranscript: activities", () => {
  it("nests a member's activities under the CCA, in full/sem1/sem2 then title order", () => {
    const vm = assembleTranscript(
      inputWith([
        activity({ title: "Retreat", period: "sem2" }),
        activity({ title: "Zeta" }),
        activity({ title: "Alpha" }),
        activity({ title: "Kickoff", period: "sem1" }),
      ]),
      AY,
    );
    const rows = section(vm, "involvements")!.rows;
    expect(rows[0]!.activities.map((a) => a.title)).toEqual([
      "Alpha",
      "Zeta",
      "Kickoff (Sem 1)",
      "Retreat (Sem 2)",
    ]);
  });

  it("falls back from the person's description to the activity's, then blank", () => {
    const vm = assembleTranscript(
      inputWith([
        activity({
          title: "A",
          description: "General",
          personDescription: "Mine",
          role: "Lead",
        }),
        activity({ title: "B", description: "General" }),
        activity({ title: "C" }),
      ]),
      AY,
    );
    const rows = section(vm, "involvements")!.rows[0]!.activities;
    expect(rows).toEqual([
      { title: "A", role: "Lead", description: "Mine" },
      { title: "B", role: "", description: "General" },
      { title: "C", role: "", description: "" },
    ]);
  });

  it("puts a non-member's activity under Other involvement, after the CCA section", () => {
    const vm = assembleTranscript(
      inputWith([
        activity({ title: "Own" }),
        activity({
          ccaName: "RH Welfare",
          title: "Care packs",
          role: "Packer",
          isMember: false,
        }),
      ]),
      AY,
    );
    const main = vm.pages[0] as Extract<TranscriptPage, { kind: "main" }>;
    expect(main.sections.map((s) => s.kind)).toEqual([
      "involvements",
      "otherInvolvement",
    ]);
    expect(section(vm, "otherInvolvement")!.rows).toEqual([
      {
        title: "Care packs",
        organiser: "RH Welfare",
        role: "Packer",
        description: "",
      },
    ]);
    expect(section(vm, "involvements")!.rows[0]!.activities).toHaveLength(1);
  });

  it("treats a member-flagged activity of a CCA with no row as other involvement", () => {
    const vm = assembleTranscript(
      inputWith([activity({ ccaName: "Missing CCA", isMember: true })]),
      AY,
    );
    expect(section(vm, "otherInvolvement")!.rows).toHaveLength(1);
  });

  it("omits Other involvement when there is none", () => {
    const vm = assembleTranscript(inputWith([activity()]), AY);
    expect(section(vm, "otherInvolvement")).toBeUndefined();
  });

  it("is not an empty year when the only record is Other involvement", () => {
    const vm = assembleTranscript(
      inputWith([activity({ isMember: false })], []),
      AY,
    );
    expect(vm.isEmpty).toBe(false);
  });

  it("ignores activities of another year", () => {
    const vm = assembleTranscript(
      inputWith([activity({ academicYear: "AY2027/28" })]),
      AY,
    );
    expect(section(vm, "involvements")!.rows[0]!.activities).toEqual([]);
    expect(section(vm, "otherInvolvement")).toBeUndefined();
  });

  it("writes 'Activity: general description' lines on the notes page", () => {
    const vm = assembleTranscript(
      inputWith([
        activity({ title: "Concert", description: "Annual concert." }),
        activity({ title: "Quiet" }),
        activity({
          ccaName: "RH Welfare",
          title: "Care packs",
          description: "Snack packs.",
          period: "sem1",
          isMember: false,
        }),
      ]),
      AY,
    );
    const notes = notesPage(vm);
    expect(notes.notes[0]!.activities).toEqual([
      { title: "Concert", text: "Annual concert." },
    ]);
    expect(notes.otherNotes).toEqual([
      { title: "Care packs (Sem 1)", text: "Snack packs." },
    ]);
  });

  it("explains Sem 1 / Sem 2 when an activity is part-year", () => {
    const vm = assembleTranscript(
      inputWith([activity({ period: "sem2" })]),
      AY,
    );
    expect(vm.hasPartYear).toBe(true);
    expect(assembleTranscript(inputWith([activity()]), AY).hasPartYear).toBe(
      false,
    );
  });

  it("does not mutate the input", () => {
    const input = inputWith([
      activity({ title: "Z" }),
      activity({ title: "A" }),
    ]);
    const before = JSON.parse(JSON.stringify(input));
    assembleTranscript(input, AY);
    expect(input).toEqual(before);
  });

  it("leaves a transcript with no activities as it was", () => {
    const input = inputWith([]);
    delete input.activities;
    const vm = assembleTranscript(input, AY);
    expect(section(vm, "involvements")!.rows[0]!.activities).toEqual([]);
    expect(notesPage(vm).otherNotes).toEqual([]);
    expect(notesPage(vm).notes[0]!.text).not.toBe(MISSING_DESCRIPTION_TEXT);
  });
});

describe("activity fixtures", () => {
  it("fixture 13 has a member with three activities (one sem 2), a contribution and one other involvement", () => {
    const f = getFixtureBySlug("member-with-activities")!;
    const vm = assembleTranscript(f.input, AY);
    const choir = section(vm, "involvements")!.rows.find(
      (r) => r.ccaName === "Hall Choir",
    )!;
    expect(choir.activities).toHaveLength(3);
    expect(choir.activities.some((a) => a.title.endsWith("(Sem 2)"))).toBe(
      true,
    );
    expect(choir.extraContribution).toBeTruthy();
    expect(section(vm, "otherInvolvement")!.rows).toHaveLength(1);
  });

  it("fixture 14 has only Other involvement", () => {
    const f = getFixtureBySlug("other-involvement-only")!;
    const vm = assembleTranscript(f.input, AY);
    expect(section(vm, "involvements")).toBeUndefined();
    expect(section(vm, "otherInvolvement")!.rows.length).toBeGreaterThan(0);
    expect(vm.isEmpty).toBe(false);
  });
});
