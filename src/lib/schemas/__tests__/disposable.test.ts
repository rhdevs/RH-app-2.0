import { describe, expect, it } from "vitest";

import {
  disposableCanFileInput,
  disposableCreateInput,
  disposableListInput,
  disposableUpdateInput,
} from "../disposable";

const OID = "a".repeat(24);

const content = {
  title: "Choir supper",
  plates: 10,
  cups: 0,
  bowls: 0,
  forks: 0,
  spoons: 0,
  collectionDay: "2027-03-12",
  collectionTime: "18:30",
};

describe("disposableCreateInput", () => {
  it("takes an event alone, and defaults the proposal and notes", () => {
    const res = disposableCreateInput.safeParse({ eventID: 5, ...content });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      eventID: 5,
      proposalID: null,
      description: "",
    });
  });

  it("takes a proposal alone", () => {
    const res = disposableCreateInput.safeParse({
      proposalID: OID,
      ...content,
    });
    expect(res.success).toBe(true);
    expect(res.data?.eventID).toBeNull();
  });

  it("takes both, so the server can check they belong together", () => {
    expect(
      disposableCreateInput.safeParse({
        eventID: 5,
        proposalID: OID,
        ...content,
      }).success,
    ).toBe(true);
  });

  it("refuses neither an event nor a proposal", () => {
    const res = disposableCreateInput.safeParse(content);
    expect(res.success).toBe(false);
    expect(res.error?.issues.map((i) => i.message)).toContain(
      "Choose the event this is for, or a proposal",
    );
  });

  it("refuses an event id that is not a positive whole number", () => {
    for (const bad of [0, -1, 1.5, "5", NaN]) {
      expect(
        disposableCreateInput.safeParse({ eventID: bad, ...content }).success,
        String(bad),
      ).toBe(false);
    }
  });

  it("has no CCA: whatever the browser sends is dropped, never used", () => {
    const res = disposableCreateInput.safeParse({
      eventID: 5,
      ccaID: 9,
      ...content,
    });
    expect(res.success).toBe(true);
    expect(res.data).not.toHaveProperty("ccaID");
  });

  it("still needs one item", () => {
    expect(
      disposableCreateInput.safeParse({
        eventID: 5,
        ...content,
        plates: 0,
      }).success,
    ).toBe(false);
  });
});

describe("disposableUpdateInput", () => {
  it("drops an event, a proposal or a CCA: what a request is for cannot be edited", () => {
    const res = disposableUpdateInput.safeParse({
      id: OID,
      version: 0,
      eventID: 9,
      proposalID: OID,
      ccaID: 3,
      ...content,
    });
    expect(res.success).toBe(true);
    expect(res.data).not.toHaveProperty("eventID");
    expect(res.data).not.toHaveProperty("proposalID");
    expect(res.data).not.toHaveProperty("ccaID");
  });
});

describe("disposableListInput", () => {
  it("accepts an event, or hall-wide, or a CCA", () => {
    expect(disposableListInput.safeParse({ eventID: 4 }).success).toBe(true);
    expect(disposableListInput.safeParse({ hallWide: true }).success).toBe(
      true,
    );
    expect(disposableListInput.safeParse({ ccaID: 2 }).success).toBe(true);
    expect(disposableListInput.safeParse(undefined).success).toBe(true);
  });

  it("refuses a CCA together with hall-wide, and hallWide: false", () => {
    expect(
      disposableListInput.safeParse({ ccaID: 2, hallWide: true }).success,
    ).toBe(false);
    expect(disposableListInput.safeParse({ hallWide: false }).success).toBe(
      false,
    );
  });
});

describe("disposableCanFileInput", () => {
  it("needs an event id", () => {
    expect(disposableCanFileInput.safeParse({ eventID: 3 }).success).toBe(true);
    expect(disposableCanFileInput.safeParse({}).success).toBe(false);
    expect(disposableCanFileInput.safeParse({ eventID: 0 }).success).toBe(
      false,
    );
  });
});
