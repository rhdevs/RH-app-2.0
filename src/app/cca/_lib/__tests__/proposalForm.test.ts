import { describe, expect, it } from "vitest";

import {
  describeProposalError,
  EMPTY_PROPOSAL_FORM,
  formFromProposal,
  missingFromForm,
  sameForm,
  saveFieldsFromForm,
  updateFieldsFromForm,
  docLinkIsInvalid,
} from "~/app/cca/_lib/proposalForm";

// 2027-03-01 10:00 in Singapore (UTC+8) is 02:00 UTC.
const START = Date.UTC(2027, 2, 1, 2, 0, 0) / 1000;

describe("the form to and from stored values", () => {
  it("round-trips a stored proposal through the form, in Singapore time", () => {
    const form = formFromProposal({
      category: "event",
      title: "Quiz night",
      description: "A quiz",
      blastMessage: "Come!",
      plannedStart: START,
      plannedEnd: START + 3600,
      posterUrl: "https://example.test/p.webp",
      docLink: "https://docs.example.com/plan",
    });
    expect(form.startLocal).toBe("2027-03-01T10:00");
    expect(form.endLocal).toBe("2027-03-01T11:00");
    expect(saveFieldsFromForm(form)).toEqual({
      category: "event",
      title: "Quiz night",
      description: "A quiz",
      blastMessage: "Come!",
      plannedStart: START,
      plannedEnd: START + 3600,
      docLink: "https://docs.example.com/plan",
    });
    expect(updateFieldsFromForm(form).posterUrl).toBe(
      "https://example.test/p.webp",
    );
  });

  it("turns blank times and a null blast message into empty fields and back to null", () => {
    const form = formFromProposal({
      category: "pubs",
      title: "t",
      description: "d",
      blastMessage: null,
      plannedStart: null,
      plannedEnd: null,
    });
    expect(form.blastMessage).toBe("");
    expect(form.startLocal).toBe("");
    const fields = saveFieldsFromForm(form);
    expect(fields.plannedStart).toBeNull();
    expect(fields.plannedEnd).toBeNull();
  });

  it("falls back to a known category when the stored one is unknown", () => {
    expect(
      formFromProposal({
        category: "mystery",
        title: "",
        description: "",
        blastMessage: null,
        plannedStart: null,
        plannedEnd: null,
      }).category,
    ).toBe("event");
  });

  it("compares forms field by field", () => {
    expect(sameForm(EMPTY_PROPOSAL_FORM, { ...EMPTY_PROPOSAL_FORM })).toBe(
      true,
    );
    expect(
      sameForm(EMPTY_PROPOSAL_FORM, { ...EMPTY_PROPOSAL_FORM, title: "x" }),
    ).toBe(false);
  });
});

describe("the checklist uses the shared category table", () => {
  it("lists what an event still needs, and nothing for a finished pubs proposal", () => {
    const empty = missingFromForm({
      ...EMPTY_PROPOSAL_FORM,
      category: "event",
    });
    expect(empty).toEqual([
      "A title",
      "A description",
      "A planned start date and time",
      "A blast message",
      "A poster",
      "A document link",
    ]);

    expect(
      missingFromForm({
        ...EMPTY_PROPOSAL_FORM,
        category: "pubs",
        title: "Pub night",
        description: "A night out",
      }),
    ).toEqual([]);
  });

  it("asks for an end that is after the start", () => {
    expect(
      missingFromForm({
        ...EMPTY_PROPOSAL_FORM,
        category: "pubs",
        title: "t",
        description: "d",
        startLocal: "2027-03-01T10:00",
        endLocal: "2027-03-01T09:00",
      }),
    ).toEqual(["An end that is after the start"]);
  });
});

describe("the document link box", () => {
  it("flags a link the server would refuse, and not a blank or a good one", () => {
    const link = (docLink: string) => ({ ...EMPTY_PROPOSAL_FORM, docLink });
    expect(docLinkIsInvalid(link(""))).toBe(false);
    expect(docLinkIsInvalid(link("  "))).toBe(false);
    expect(docLinkIsInvalid(link("https://docs.example.com/a"))).toBe(false);
    expect(docLinkIsInvalid(link("javascript:alert(1)"))).toBe(true);
    expect(docLinkIsInvalid(link("http://docs.example.com"))).toBe(true);
    expect(docLinkIsInvalid(link("https://u:p@docs.example.com"))).toBe(true);
  });

  it("sends a blank link as null and counts the poster and link in the checklist", () => {
    expect(saveFieldsFromForm(EMPTY_PROPOSAL_FORM).docLink).toBeNull();
    const done = {
      ...EMPTY_PROPOSAL_FORM,
      category: "merch" as const,
      title: "t",
      description: "d",
      posterUrl: "https://example.test/p.webp",
      docLink: "https://docs.example.com/a",
    };
    expect(missingFromForm(done)).toEqual([]);
    expect(
      missingFromForm({ ...done, docLink: "javascript:alert(1)" }),
    ).toEqual(["A document link"]);
    expect(sameForm(done, { ...done, posterUrl: null })).toBe(false);
  });
});

describe("describeProposalError", () => {
  it("splits an incomplete-proposal message into its items", () => {
    expect(
      describeProposalError(
        "PROPOSAL_INCOMPLETE:A planned start date and time; A blast message",
      ),
    ).toEqual({
      text: "This proposal is not ready to submit. It still needs:",
      items: ["A planned start date and time", "A blast message"],
    });
  });

  it("explains a conflict", () => {
    expect(describeProposalError("PROPOSAL_CONFLICT").text).toMatch(
      /changed somewhere else/,
    );
  });

  it("explains a rate limit without showing the seconds code", () => {
    const shown = describeProposalError("RATE_LIMITED:312");
    expect(shown.text).toMatch(/Wait a few minutes/);
    expect(shown.text).not.toMatch(/RATE_LIMITED|312/);
  });

  it("never shows an unknown message, such as a driver or validation dump", () => {
    const shown = describeProposalError('[{"code":"too_big","secret":"x"}]');
    expect(shown.text).toBe("Something went wrong. Try again shortly.");
    expect(shown.items).toEqual([]);
    expect(describeProposalError(undefined).text).toBe(shown.text);
  });
});
