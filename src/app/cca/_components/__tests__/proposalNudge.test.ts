import { describe, expect, it } from "vitest";

import { nudgeMessage } from "../ProposalNudge";

describe("nudgeMessage", () => {
  it("says how many directors were nudged", () => {
    expect(nudgeMessage({ status: "sent", sent: 2, alreadySent: 0 })).toBe(
      "Nudged 2 director(s).",
    );
  });

  it("says the others were nudged already when only some are new", () => {
    expect(nudgeMessage({ status: "sent", sent: 1, alreadySent: 2 })).toMatch(
      /already nudged today/,
    );
  });

  it("says a repeat was already sent", () => {
    expect(
      nudgeMessage({ status: "already_sent", sent: 0, alreadySent: 2 }),
    ).toMatch(/already nudged/);
  });

  it("says plainly when there is no director", () => {
    expect(
      nudgeMessage({ status: "no_director", sent: 0, alreadySent: 0 }),
    ).toMatch(/no director/);
  });
});
