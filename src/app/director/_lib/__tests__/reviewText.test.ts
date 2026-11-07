import { describe, expect, it } from "vitest";

import { describeReviewFailure } from "../reviewText";

describe("describeReviewFailure", () => {
  it("tells 'not a director' apart from a failed read", () => {
    const refused = describeReviewFailure("NOT_DIRECTOR");
    expect(refused.notDirector).toBe(true);
    expect(refused.text).toMatch(/directors/);

    const failed = describeReviewFailure("PROPOSAL_ACCESS_CHECK_FAILED");
    expect(failed.notDirector).toBe(false);
    expect(failed.text).not.toBe("");
  });

  it("never reads as an empty queue", () => {
    for (const m of [undefined, "Something went wrong.", "PROPOSAL_CONFLICT"]) {
      expect(describeReviewFailure(m).text).not.toMatch(
        /nothing is waiting|nothing to review/i,
      );
    }
  });
});
