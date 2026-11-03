import { describe, expect, it } from "vitest";

import { disposableErrorMessage, proposalEventIdIn } from "../errors";
import { defaultCollectionDay, tagProblem } from "../events";
import { filtersToInput, HALL_WIDE_FILTER, NO_FILTERS } from "../filters";
import {
  chooseEvent,
  chooseProposal,
  emptyForm,
  formFromRequest,
  parseCreate,
  parseUpdate,
} from "../form";

const TODAY = "2027-03-10";
const OID = "a".repeat(24);

const filled = () => ({
  ...emptyForm(31),
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
        eventID: 31,
        proposalID: null,
        title: "Hall dinner",
        description: "",
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
      quantities: emptyForm(31).quantities,
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

  it("sends no CCA: the form never says whose request it is", () => {
    const res = parseCreate(filled(), TODAY);
    expect(res.ok && "ccaID" in res.input).toBe(false);
  });

  it("refuses a request with neither an event nor a proposal", () => {
    expect(parseCreate({ ...filled(), eventID: null }, TODAY)).toEqual({
      ok: false,
      errors: ["Choose the event this is for, or a proposal"],
    });
  });

  it("refuses a blank title and a bad date or time", () => {
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

  it("files for a proposal alone", () => {
    const res = parseCreate(
      { ...filled(), eventID: null, proposalID: OID },
      TODAY,
    );
    expect(res.ok && res.input.proposalID).toBe(OID);
    expect(res.ok && res.input.eventID).toBe(null);
  });
});

describe("choosing an event or a proposal", () => {
  const start = Date.UTC(2027, 2, 20, 16, 30) / 1000; // 21 March 00:30 in Singapore

  it("fills the collection day with the event start day in Singapore", () => {
    const next = chooseEvent(
      emptyForm(),
      { eventID: 5, startTime: start },
      TODAY,
    );
    expect(next.eventID).toBe(5);
    expect(next.collectionDay).toBe("2027-03-21");
  });

  it("leaves a day the person typed alone", () => {
    const typed = {
      ...emptyForm(),
      collectionDay: "2027-03-25",
      collectionDayEdited: true,
    };
    const next = chooseEvent(typed, { eventID: 5, startTime: start }, TODAY);
    expect(next.collectionDay).toBe("2027-03-25");
  });

  it("uses today when the event started earlier, and nothing without a start", () => {
    expect(defaultCollectionDay(start, "2027-04-01")).toBe("2027-04-01");
    expect(defaultCollectionDay(null, TODAY)).toBe("");
  });

  it("an event and a proposal replace each other", () => {
    const withProposal = chooseProposal(emptyForm(5), OID);
    expect(withProposal).toMatchObject({ eventID: null, proposalID: OID });
    const back = chooseEvent(
      withProposal,
      { eventID: 6, startTime: null },
      TODAY,
    );
    expect(back).toMatchObject({ eventID: 6, proposalID: "" });
  });
});

describe("which events can be tagged", () => {
  const NOW = 1_800_000_000;
  const ok = { status: "published", endTime: NOW + 60, title: "Night" };

  it("allows every status but canceled and declined, and an event not yet ended", () => {
    for (const status of [
      "draft",
      "submitted",
      "published",
      "changes_requested",
      null,
      "nonsense",
    ]) {
      expect(tagProblem({ ...ok, status }, NOW), String(status)).toBeNull();
    }
    expect(tagProblem({ ...ok, status: "canceled" }, NOW)).toBe("canceled");
    expect(tagProblem({ ...ok, status: "declined" }, NOW)).toBe("declined");
  });

  it("refuses an event that has ended (epoch seconds), at the very second too", () => {
    expect(tagProblem({ ...ok, endTime: NOW - 1 }, NOW)).toBe("ended");
    expect(tagProblem({ ...ok, endTime: NOW }, NOW)).toBe("ended");
    expect(tagProblem({ ...ok, endTime: null }, NOW)).toBeNull();
  });

  it("refuses an event with no title", () => {
    expect(tagProblem({ ...ok, title: "  " }, NOW)).toBe("untitled");
    expect(tagProblem({ ...ok, title: null }, NOW)).toBe("untitled");
  });
});

describe("parseUpdate and formFromRequest", () => {
  it("round-trips a loaded request into an update input", () => {
    const state = formFromRequest({
      event: { eventID: 31 },
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
      input: { id: OID, version: 3, plates: 5, spoons: 1 },
    });
    // What the request is for is not part of an edit.
    expect(res.ok && "proposalID" in res.input).toBe(false);
    expect(res.ok && "eventID" in res.input).toBe(false);
    expect(res.ok && "ccaID" in res.input).toBe(false);
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
      eventID: "",
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

  it("asks for hall-wide requests, and for one event", () => {
    expect(
      filtersToInput({ ...NO_FILTERS, ccaID: HALL_WIDE_FILTER, eventID: "31" }),
    ).toEqual({ hallWide: true, eventID: 31 });
    // A CCA tab stays on its CCA.
    expect(
      filtersToInput({ ...NO_FILTERS, ccaID: HALL_WIDE_FILTER }, 4),
    ).toEqual({ ccaID: 4 });
    expect(filtersToInput({ ...NO_FILTERS, eventID: "abc" })).toEqual({});
  });

  it("drops a status that is not one", () => {
    expect(filtersToInput({ ...NO_FILTERS, status: "draft" })).toEqual({});
  });
});

describe("disposableErrorMessage", () => {
  it("maps the known codes and hides everything else", () => {
    expect(disposableErrorMessage("DISPOSABLE_CONFLICT")).toMatch(/changed/);
    expect(disposableErrorMessage("RATE_LIMITED:120")).toMatch(/later/);
    expect(disposableErrorMessage("DISPOSABLE_EVENT_CANCELED")).toMatch(
      /canceled/,
    );
    expect(disposableErrorMessage("DISPOSABLE_EVENT_ENDED")).toMatch(/ended/);
    expect(disposableErrorMessage("NOT_CCA_HEAD")).toMatch(/head/);
    expect(disposableErrorMessage("NOT_HALL_FILER")).toMatch(/hall-wide/);
    expect(disposableErrorMessage("DISPOSABLE_PROPOSAL_HAS_EVENT:12")).toMatch(
      /already has an event/,
    );
    expect(disposableErrorMessage("PrismaClientKnownRequestError boom")).toBe(
      "Something went wrong. Try again shortly.",
    );
  });
});

describe("proposalEventIdIn", () => {
  it("reads the event a proposal already has from the refusal", () => {
    expect(proposalEventIdIn("DISPOSABLE_PROPOSAL_HAS_EVENT:12")).toBe(12);
    expect(proposalEventIdIn("DISPOSABLE_PROPOSAL_TAKEN")).toBeNull();
  });
});
