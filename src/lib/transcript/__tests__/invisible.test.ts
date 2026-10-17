import { describe, expect, it } from "vitest";
import { errorText } from "../adminView";
import {
  awardUpdateInput,
  block,
  jcrcSaveMineInput,
  line,
  rosterUpsertInput,
  volunteerActivityCreateInput,
} from "../manageInput";

const RANGES: Array<[string, number, number]> = [
  ["zero-width and marks", 0x200b, 0x200f],
  ["bidirectional embeddings and overrides", 0x202a, 0x202e],
  ["word joiner and invisible operators", 0x2060, 0x2064],
  ["bidirectional isolates", 0x2066, 0x2069],
  ["byte order mark", 0xfeff, 0xfeff],
];

const ONE_CODE_POINT_PER_RANGE_END = RANGES.flatMap(([name, from, to]) => [
  [name, from],
  [name, to],
]) as Array<[string, number]>;

const ISSUE = "INVISIBLE_CHARACTERS_NOT_ALLOWED";
const messages = (r: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) => (r.success ? [] : r.error!.issues.map((i) => i.message));

/** An award's text rules, through the update input (the same title and citation fields). */
const awardCreateInput = {
  parse: (v: object) =>
    awardUpdateInput.parse({ id: "0123456789abcdef01234567", ...v }),
  safeParse: (v: object) =>
    awardUpdateInput.safeParse({ id: "0123456789abcdef01234567", ...v }),
};

describe("invisible and direction-changing characters", () => {
  it.each(ONE_CODE_POINT_PER_RANGE_END)(
    "are refused in a single-line field (%s, U+%i)",
    (_name, code) => {
      const text = `Treas${String.fromCodePoint(code)}urer`;
      expect(messages(line(1, 60).safeParse(text))).toContain(ISSUE);
    },
  );

  it.each(ONE_CODE_POINT_PER_RANGE_END)(
    "are refused in a multi-line field (%s, U+%i)",
    (_name, code) => {
      const text = `Line one\nLine ${String.fromCodePoint(code)}two`;
      expect(messages(block(0, 500).safeParse(text))).toContain(ISSUE);
    },
  );

  it("covers every code point in every range", () => {
    for (const [, from, to] of RANGES) {
      for (let c = from; c <= to; c += 1) {
        expect(
          line(1, 60).safeParse(`a${String.fromCodePoint(c)}b`).success,
          c.toString(16),
        ).toBe(false);
      }
    }
  });

  it("makes an 'empty' title of only zero-width spaces fail instead of passing min(1)", () => {
    expect(line(1, 120).safeParse("​​").success).toBe(false);
  });

  it("leaves ordinary text, newlines, accents and emoji alone", () => {
    for (const ok of [
      "Head of Soccer",
      "Café société",
      "Run \u{1F3C3} club",
      "名前",
    ]) {
      expect(line(1, 60).safeParse(ok).success, ok).toBe(true);
    }
    expect(block(0, 500).safeParse("one\ntwo\r\nthree").success).toBe(true);
    // Just outside the ranges.
    for (const c of [
      0x200a, 0x2029, 0x202f, 0x205f, 0x2065, 0x206a, 0xfefe, 0xff00,
    ]) {
      expect(
        line(1, 60).safeParse(`a${String.fromCodePoint(c)}b`).success,
        c.toString(16),
      ).toBe(true);
    }
  });

  it("applies to every free-text field the screens accept", () => {
    const bad = "x‮y";
    const base = { ccaID: 9005, academicYear: "AY2026/27", userID: "SEED-R12" };

    expect(
      rosterUpsertInput.safeParse({ ...base, roleLabel: bad }).success,
    ).toBe(false);
    expect(
      rosterUpsertInput.safeParse({ ...base, extraContribution: bad }).success,
    ).toBe(false);
    expect(
      volunteerActivityCreateInput.safeParse({
        ccaID: base.ccaID,
        academicYear: base.academicYear,
        kind: "regular",
        title: bad,
        description: "",
      }).success,
    ).toBe(false);
    expect(
      awardCreateInput.safeParse({
        academicYear: "AY2026/27",
        userID: "SEED-R12",
        title: bad,
      }).success,
    ).toBe(false);
    expect(
      awardCreateInput.safeParse({
        academicYear: "AY2026/27",
        userID: "SEED-R12",
        title: "Fine",
        citation: bad,
      }).success,
    ).toBe(false);

    const jcrc = {
      academicYear: "AY2026/27",
      portfolio: "Sports",
      position: "Secretary",
      description: "Runs sport",
      contributions: [
        { activity: "Ran orientation", role: "Lead", description: "Ran it." },
      ],
      testimonial: "Good year",
    };
    expect(jcrcSaveMineInput.safeParse(jcrc).success).toBe(true);
    for (const field of [
      "portfolio",
      "position",
      "description",
      "testimonial",
    ] as const) {
      expect(
        jcrcSaveMineInput.safeParse({ ...jcrc, [field]: bad }).success,
        field,
      ).toBe(false);
    }
    expect(
      jcrcSaveMineInput.safeParse({
        ...jcrc,
        contributions: [{ activity: "Fine", role: "", description: "" }],
      }).success,
    ).toBe(true);
    for (const field of ["activity", "role", "description"] as const) {
      expect(
        jcrcSaveMineInput.safeParse({
          ...jcrc,
          contributions: [
            { activity: "Fine", role: "", description: "", [field]: bad },
          ],
        }).success,
        field,
      ).toBe(false);
    }
    expect(
      jcrcSaveMineInput.safeParse({ ...jcrc, contributions: [bad as never] })
        .success,
    ).toBe(false);
  });

  it("explains itself in plain words", () => {
    expect(errorText(ISSUE)).toBe(
      "Remove any invisible or direction-changing characters.",
    );
  });
});
