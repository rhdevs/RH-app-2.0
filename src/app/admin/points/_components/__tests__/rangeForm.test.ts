import { describe, expect, it } from "vitest";

import { DEFAULT_RANGE } from "~/lib/points/constants";
import {
  hasSavedRanges,
  parseRangeForm,
  toFormValues,
} from "~/app/admin/points/_components/rangeForm";

const blank = { meanMin: "", meanMax: "", sdMin: "", sdMax: "" };
const filled = { meanMin: "10", meanMax: "14", sdMin: "2", sdMax: "5" };

describe("parseRangeForm (default ranges: every field required)", () => {
  const opts = { allowBlank: false, fallback: DEFAULT_RANGE };

  it("accepts four good numbers", () => {
    const r = parseRangeForm(filled, opts);
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({ meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 });
  });

  it("accepts decimals and surrounding spaces", () => {
    const r = parseRangeForm({ ...filled, meanMin: " 9.5 " }, opts);
    expect(r.ok).toBe(true);
    expect(r.values.meanMin).toBe(9.5);
  });

  it("flags a blank field as required", () => {
    const r = parseRangeForm({ ...filled, sdMax: "" }, opts);
    expect(r.ok).toBe(false);
    expect(r.fieldErrors.sdMax).toBe("Required");
  });

  it("flags text that is not a number", () => {
    const r = parseRangeForm({ ...filled, meanMax: "abc" }, opts);
    expect(r.fieldErrors.meanMax).toBe("Enter a number");
  });

  it("flags a negative number", () => {
    expect(
      parseRangeForm({ ...filled, sdMin: "-1" }, opts).fieldErrors.sdMin,
    ).toBe("Enter a number");
  });

  it("enforces 0-20 on the average and 0-10 on the spread", () => {
    const r = parseRangeForm({ ...filled, meanMax: "21", sdMax: "11" }, opts);
    expect(r.fieldErrors.meanMax).toBe("Between 0 and 20");
    expect(r.fieldErrors.sdMax).toBe("Between 0 and 10");
  });

  it("explains a minimum above its maximum", () => {
    const r = parseRangeForm({ ...filled, meanMin: "15" }, opts);
    expect(r.ok).toBe(false);
    expect(r.formError).toMatch(/average/i);
  });

  it("accepts a minimum equal to its maximum", () => {
    expect(parseRangeForm({ ...filled, meanMin: "14" }, opts).ok).toBe(true);
  });
});

describe("parseRangeForm (waiver: blank means use the default)", () => {
  const opts = { allowBlank: true, fallback: DEFAULT_RANGE };

  it("accepts a partly filled waiver", () => {
    const r = parseRangeForm({ ...blank, meanMax: "17" }, opts);
    expect(r.ok).toBe(true);
    expect(r.values).toEqual({
      meanMin: null,
      meanMax: 17,
      sdMin: null,
      sdMax: null,
    });
  });

  it("needs at least one field", () => {
    const r = parseRangeForm(blank, opts);
    expect(r.ok).toBe(false);
    expect(r.formError).toMatch(/at least one/i);
  });

  it("checks min against max AFTER falling back to the default", () => {
    // meanMin 15 alone sits above the default meanMax of 14.
    const r = parseRangeForm({ ...blank, meanMin: "15" }, opts);
    expect(r.ok).toBe(false);
    expect(r.formError).toMatch(/average/i);
  });

  it("uses the fallback it is given", () => {
    const wide = { meanMin: 0, meanMax: 20, sdMin: 0, sdMax: 10 };
    expect(
      parseRangeForm(
        { ...blank, meanMin: "15" },
        { allowBlank: true, fallback: wide },
      ).ok,
    ).toBe(true);
  });
});

describe("toFormValues", () => {
  it("turns blanks into empty strings", () => {
    expect(toFormValues({ meanMin: 9, meanMax: null })).toEqual({
      meanMin: "9",
      meanMax: "",
      sdMin: "",
      sdMax: "",
    });
  });
});

describe("hasSavedRanges", () => {
  it("is false when there is no default row", () => {
    expect(hasSavedRanges(null)).toBe(false);
  });

  it("is false for a row that only carries the entry switch", () => {
    expect(
      hasSavedRanges({
        meanMin: null,
        meanMax: null,
        sdMin: null,
        sdMax: null,
      }),
    ).toBe(false);
  });

  it("is true once any range field is stored", () => {
    expect(
      hasSavedRanges({ meanMin: null, meanMax: 15, sdMin: null, sdMax: null }),
    ).toBe(true);
  });
});
