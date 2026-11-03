import { describe, expect, it } from "vitest";

import { eventErrorMessage, eventIssueMessage } from "./eventErrors";

const err = (message: string) => new Error(message);

describe("eventErrorMessage", () => {
  it("lists missing fields in words", () => {
    expect(eventErrorMessage(err("INCOMPLETE:title,banner"))).toBe(
      "Please add: event name, banner image.",
    );
  });

  it("names the booking in a facility clash", () => {
    const clash = JSON.stringify({
      eventName: "Band practice",
      startTime: 1_786_000_000,
      endTime: 1_786_003_600,
    });
    expect(eventErrorMessage(err(`FACILITY_CLASH:${clash}`))).toMatch(
      /already booked for that time by Band practice \(/,
    );
  });

  it("survives a malformed clash payload", () => {
    expect(eventErrorMessage(err("FACILITY_CLASH:{oops"))).toBe(
      "The facility is already booked for that time.",
    );
  });

  it("explains a capacity below signups", () => {
    expect(eventErrorMessage(err("CAPACITY_BELOW_SIGNUPS:12"))).toMatch(
      /below 12/,
    );
  });

  it("names locked fields", () => {
    expect(eventErrorMessage(err("FIELD_LOCKED:title"))).toBe(
      "The event name can't change once the event is live.",
    );
  });

  it("maps a plain code", () => {
    expect(eventErrorMessage(err("EVENT_BUSY"))).toMatch(/Try again/);
  });

  it("never shows an unknown code", () => {
    expect(eventErrorMessage(err("SOMETHING_NEW"))).toBe(
      "That didn't save. Try again.",
    );
    expect(eventErrorMessage("not an error", "Nope.")).toBe("Nope.");
  });
});

describe("eventIssueMessage", () => {
  it("keeps the blob-url code friendly", () => {
    expect(
      eventIssueMessage({ message: "NOT_A_VALID_EVENT_BLOB_URL" }),
    ).toMatch(/Re-upload/);
  });

  it("hides zod's own wording", () => {
    expect(
      eventIssueMessage({
        message: "Number must be greater than 0",
        path: ["capacity"],
      }),
    ).toBe("Capacity must be a whole number above 0.");
    expect(
      eventIssueMessage({ message: "String must contain", path: ["title"] }),
    ).toBe("Check the event name.");
    expect(eventIssueMessage({ message: "x", path: ["weird"] })).toBe(
      "Please check the fields.",
    );
  });
});
