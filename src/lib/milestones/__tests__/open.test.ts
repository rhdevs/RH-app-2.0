import { describe, expect, it } from "vitest";

import {
  eventMilestoneEnd,
  hasEnded,
  milestoneKey,
  milestoneYear,
  proposalMilestoneEnd,
} from "../open";

const NOW = 2_000_000_000;
const PAST = NOW - 3600;
const FUTURE = NOW + 3600;
const ev = (o: Partial<Parameters<typeof eventMilestoneEnd>[0]> = {}) => ({
  status: "published",
  ccaID: 7,
  startTime: PAST - 3600,
  endTime: PAST,
  ...o,
});

describe("which events open a milestone (A53)", () => {
  it("a published CCA event whose end has passed opens one", () => {
    expect(hasEnded(eventMilestoneEnd(ev()), NOW)).toBe(true);
  });

  it.each(["draft", "submitted", "changes_requested", "declined", "canceled"])(
    "a %s event never opens one, whatever its dates",
    (status) => {
      expect(eventMilestoneEnd(ev({ status }))).toBeNull();
    },
  );

  it("a hall-wide event (no CCA) never opens one", () => {
    expect(eventMilestoneEnd(ev({ ccaID: null }))).toBeNull();
  });

  it("with no endTime the start time is the end", () => {
    expect(eventMilestoneEnd(ev({ endTime: null }))).toBe(PAST - 3600);
    expect(hasEnded(eventMilestoneEnd(ev({ endTime: null })), NOW)).toBe(true);
  });

  it("an event with neither time never opens one", () => {
    const end = eventMilestoneEnd(ev({ startTime: null, endTime: null }));
    expect(end).toBeNull();
    expect(hasEnded(end, NOW)).toBe(false);
  });

  it("a future end is not open yet, and the end instant itself is not past", () => {
    expect(hasEnded(eventMilestoneEnd(ev({ endTime: FUTURE })), NOW)).toBe(
      false,
    );
    expect(hasEnded(NOW, NOW)).toBe(false);
  });

  it("a bad time is a bad row, not a fallback", () => {
    expect(eventMilestoneEnd(ev({ endTime: -5 }))).toBeNull();
    expect(eventMilestoneEnd(ev({ endTime: 1.5 }))).toBeNull();
  });
});

describe("a finished proposal with no event", () => {
  const p = {
    status: "finished",
    ccaID: 3,
    eventID: null,
    plannedStart: PAST - 100,
    plannedEnd: PAST,
  };
  it("opens one when its planned end has passed", () => {
    expect(hasEnded(proposalMilestoneEnd(p), NOW)).toBe(true);
  });
  it("other statuses and event-linked proposals do not", () => {
    expect(proposalMilestoneEnd({ ...p, status: "approved" })).toBeNull();
    expect(proposalMilestoneEnd({ ...p, eventID: 9 })).toBeNull();
  });
});

describe("the year and the key", () => {
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  it("the year turns at midnight 1 August Singapore time", () => {
    expect(milestoneYear(sec("2026-07-31T15:59:59Z"))).toBe("AY2025/26");
    expect(milestoneYear(sec("2026-07-31T16:00:00Z"))).toBe("AY2026/27");
  });
  it("one key per event and per proposal, case folded", () => {
    expect(milestoneKey({ kind: "event", eventID: 4 })).toBe("event:4");
    expect(milestoneKey({ kind: "proposal", proposalID: "AB12" })).toBe(
      "proposal:ab12",
    );
  });
});
