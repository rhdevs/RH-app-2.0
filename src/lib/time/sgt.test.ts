import { describe, expect, it } from "vitest";

import { sgtDayKey, sgtWeekStartKey } from "./sgt";

describe("sgtDayKey", () => {
  it("puts 07:59 SGT on its own Singapore day, not the UTC one", () => {
    // 2026-08-06 07:59 SGT is 2026-08-05 23:59 UTC.
    expect(sgtDayKey(new Date(Date.UTC(2026, 7, 5, 23, 59)))).toBe(
      "2026-08-06",
    );
  });

  it("keeps late evening on the same day", () => {
    expect(sgtDayKey(new Date(Date.UTC(2026, 7, 6, 15, 30)))).toBe(
      "2026-08-06",
    );
  });
});

describe("sgtWeekStartKey", () => {
  it("returns the Singapore Monday", () => {
    // Monday 2026-08-03 00:30 SGT is Sunday 2026-08-02 16:30 UTC.
    expect(sgtWeekStartKey(new Date(Date.UTC(2026, 7, 2, 16, 30)))).toBe(
      "2026-08-03",
    );
  });

  it("maps a Sunday to the Monday before it", () => {
    expect(sgtWeekStartKey(new Date(Date.UTC(2026, 7, 9, 4, 0)))).toBe(
      "2026-08-03",
    );
  });
});
