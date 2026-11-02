import { describe, expect, it } from "vitest";

import { disposableErrorMessage } from "../errors";
import { filtersToInput, NO_FILTERS } from "../filters";
import { emptyForm, formFromRequest, parseCreate, parseUpdate } from "../form";

const TODAY = "2027-03-10";
const OID = "a".repeat(24);

const filled = () => ({
  ...emptyForm(7),
  title: "  Hall dinner  ",
  quantities: { plates: "50", cups: "", bowls: "0", forks: "20", spoons: "20" },
  collectionDay: "2027-03-12",
  collectionTime: "18:30",
});

describe("parseCreate", () => {
  it("reads blank boxes as 0, trims the title and builds the input", () => {
    const res = parseCreate(filled(), TODAY);

    expect(res).toEqual({
      ok: true,
      input: {
        ccaID: 7,
        title: "Hall dinner",
        description: "",
        proposalID: null,
        plates: 50,
        cups: 0,
        bowls: 0,
        forks: 20,
        spoons: 20,
        collectionDay: "2027-03-12",
        collectionTime: "18:30",
      },
    });
  });

  it("refuses a request for nothing", () => {
    const state = {
      ...filled(),
      quantities: emptyForm(7).quantities,
    };

    const res = parseCreate(state, TODAY);

    expect(res).toEqual({ ok: false, errors: ["Ask for at least one item"] });
  });

  it("refuses a quantity over the cap, a fraction and a negative", () => {
    for (const bad of ["501", "2.5", "-1", "abc"]) {
      const res = parseCreate(
        { ...filled(), quantities: { ...filled().quantities, cups: bad } },
        TODAY,
      );
      expect(res.ok, bad).toBe(false);
    }
  });

  it("refuses a missing CCA, a blank title and a bad date or time", () => {
    expect(parseCreate({ ...filled(), ccaID: null }, TODAY).ok).toBe(false);
    expect(parseCreate({ ...filled(), title: "   " }, TODAY).ok).toBe(false);
    expect(
      parseCreate({ ...filled(), collectionDay: "2027-02-30" }, TODAY).ok,
    ).toBe(false);
    expect(
      parseCreate({ ...filled(), collectionTime: "25:00" }, TODAY).ok,
    ).toBe(false);
    expect(parseCreate({ ...filled(), collectionTime: "" }, TODAY).ok).toBe(
      false,
    );
  });

  it("refuses a collection day before today but allows today", () => {
    expect(
      parseCreate({ ...filled(), collectionDay: "2027-03-09" }, TODAY),
    ).toEqual({
      ok: false,
      errors: ["Choose today or a later collection date"],
    });
    expect(parseCreate({ ...filled(), collectionDay: TODAY }, TODAY).ok).toBe(
      true,
    );
  });

  it("refuses over-long text", () => {
    expect(parseCreate({ ...filled(), title: "x".repeat(121) }, TODAY).ok).toBe(
      false,
    );
    expect(
      parseCreate({ ...filled(), description: "x".repeat(1001) }, TODAY).ok,
    ).toBe(false);
  });

  it("passes a linked proposal through", () => {
    const res = parseCreate({ ...filled(), proposalID: OID }, TODAY);
    expect(res.ok && res.input.proposalID).toBe(OID);
  });
});

describe("parseUpdate and formFromRequest", () => {
  it("round-trips a loaded request into an update input", () => {
    const state = formFromRequest({
      ccaID: 7,
      title: "Hall dinner",
      description: "notes",
      proposalID: OID,
      plates: 5,
      cups: 0,
      bowls: 0,
      forks: 0,
      spoons: 1,
      collectionDay: "2027-03-12",
      collectionTime: "09:00",
    });

    const res = parseUpdate(state, OID, 3, TODAY);

    expect(res).toMatchObject({
      ok: true,
      input: { id: OID, version: 3, plates: 5, spoons: 1, proposalID: OID },
    });
  });

  it("refuses an id that is not a request id", () => {
    expect(parseUpdate(filled(), "nope", 0, TODAY).ok).toBe(false);
  });
});

describe("filtersToInput", () => {
  it("leaves blank boxes out", () => {
    expect(filtersToInput(NO_FILTERS)).toEqual({});
  });

  it("builds the list input and lets a fixed CCA win", () => {
    const f = {
      status: "pending",
      ccaID: "9",
      from: "2027-03-01",
      to: "2027-03-31",
    };
    expect(filtersToInput(f)).toEqual({
      status: "pending",
      ccaID: 9,
      from: "2027-03-01",
      to: "2027-03-31",
    });
    expect(filtersToInput(f, 4).ccaID).toBe(4);
  });

  it("drops a status that is not one", () => {
    expect(filtersToInput({ ...NO_FILTERS, status: "draft" })).toEqual({});
  });
});

describe("disposableErrorMessage", () => {
  it("maps the known codes and hides everything else", () => {
    expect(disposableErrorMessage("DISPOSABLE_CONFLICT")).toMatch(/changed/);
    expect(disposableErrorMessage("RATE_LIMITED:120")).toMatch(/later/);
    expect(disposableErrorMessage("PrismaClientKnownRequestError boom")).toBe(
      "Something went wrong. Try again shortly.",
    );
  });
});
