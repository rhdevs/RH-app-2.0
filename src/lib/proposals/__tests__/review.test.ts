import { describe, expect, it } from "vitest";

import {
  PROPOSAL_STATUSES,
  REVIEW_MOVES,
  canTransition,
  reviewActionsFor,
} from "../status";
import { historyLine } from "../historyLine";
import {
  directorProposalHref,
  headProposalHref,
  DIRECTOR_HOME_HREF,
} from "../links";
import {
  proposalApproveInput,
  proposalFinishInput,
  proposalQueueInput,
  proposalReturnInput,
} from "~/lib/schemas/proposal";

const ID = "0123456789abcdef01234567";

describe("the director's three moves", () => {
  it("every move is in the transition table, so the table cannot disagree", () => {
    for (const move of Object.values(REVIEW_MOVES)) {
      expect(canTransition(move.from, move.to)).toBe(true);
    }
  });

  it("approve and return start in review; finish starts from cleared", () => {
    expect(REVIEW_MOVES.approve.from).toBe("in_review");
    expect(REVIEW_MOVES.return.from).toBe("in_review");
    expect(REVIEW_MOVES.finish.from).toBe("cleared");
  });

  it("offers the right actions per status, and none for a draft", () => {
    expect(reviewActionsFor("in_review")).toEqual(["approve", "return"]);
    expect(reviewActionsFor("cleared")).toEqual(["finish"]);
    for (const status of PROPOSAL_STATUSES) {
      if (status === "in_review" || status === "cleared") continue;
      expect(reviewActionsFor(status), status).toEqual([]);
    }
    expect(reviewActionsFor("nonsense")).toEqual([]);
  });
});

describe("the review inputs", () => {
  it("approve takes an optional note; blank is none", () => {
    expect(proposalApproveInput.parse({ id: ID, version: 1 })).toEqual({
      id: ID,
      version: 1,
    });
    expect(
      proposalApproveInput.parse({ id: ID, version: 1, note: "   " }).note,
    ).toBeNull();
    expect(
      proposalApproveInput.parse({ id: ID, version: 1, note: " Fine " }).note,
    ).toBe("Fine");
    expect(
      proposalApproveInput.safeParse({
        id: ID,
        version: 1,
        note: "x".repeat(501),
      }).success,
    ).toBe(false);
  });

  it("return needs a reason of 1 to 500 characters", () => {
    for (const reason of ["", "   ", "x".repeat(501)]) {
      expect(
        proposalReturnInput.safeParse({ id: ID, version: 1, reason }).success,
      ).toBe(false);
    }
    expect(
      proposalReturnInput.parse({ id: ID, version: 1, reason: " Add a date " })
        .reason,
    ).toBe("Add a date");
  });

  it("the moves carry a version and an id, and nothing else a browser could use", () => {
    for (const bad of [
      { id: "nope", version: 1 },
      { id: ID, version: -1 },
      { id: ID, version: 1.5 },
      { id: ID },
    ]) {
      expect(proposalFinishInput.safeParse(bad).success).toBe(false);
    }
    const parsed = proposalFinishInput.parse({
      id: ID,
      version: 2,
      ccaID: 1,
      status: "finished",
      selfApproved: true,
    });
    expect(parsed).toEqual({ id: ID, version: 2 });
  });

  it("the queue cursor is a position (time and id) or nothing", () => {
    expect(proposalQueueInput.parse({})).toEqual({});
    expect(proposalQueueInput.safeParse({ cursor: "x" }).success).toBe(false);
    // A bare id was the old cursor; it is no longer one.
    expect(proposalQueueInput.safeParse({ cursor: ID }).success).toBe(false);
    for (const cursor of [`1700000000000_${ID}`, `none_${ID}`]) {
      expect(proposalQueueInput.parse({ cursor }).cursor).toBe(cursor);
    }
    for (const cursor of [
      `-1_${ID}`,
      `1700000000000_${ID}0`,
      `1700000000000_zzzzzzzzzzzzzzzzzzzzzzzz`,
      `12345678901234567_${ID}`,
      `1700000000000${ID}`,
    ]) {
      expect(proposalQueueInput.safeParse({ cursor }).success, cursor).toBe(
        false,
      );
    }
  });
});

describe("where a notice sends each reader", () => {
  it("a director goes to /director, never under /cca (which admits heads only)", () => {
    expect(directorProposalHref(ID)).toBe(`/director/proposals/${ID}`);
    expect(directorProposalHref(ID).startsWith(DIRECTOR_HOME_HREF)).toBe(true);
    expect(directorProposalHref(ID)).not.toMatch(/^\/cca/);
    expect(headProposalHref(7, ID)).toBe(`/cca/7/proposals/${ID}`);
  });
});

describe("a history line", () => {
  const at = () => "1 Jan";
  const base = {
    at: new Date(0),
    selfApproved: false,
    approverName: null,
    note: null,
  };

  it("names the approver and labels a self-approval", () => {
    const line = historyLine(
      {
        ...base,
        fromStatus: "in_review",
        toStatus: "cleared",
        approverName: "Dana",
        selfApproved: true,
        note: "ok",
      },
      at,
    );
    expect(line).toContain("by Dana");
    expect(line).toContain("(self-approved)");
    expect(line).toMatch(/: ok$/);
  });

  it("says a former member when the approver has no name, and never an id", () => {
    const line = historyLine(
      {
        ...base,
        fromStatus: "in_review",
        toStatus: "cleared",
        selfApproved: true,
      },
      at,
    );
    expect(line).toContain("by a former member");
    expect(line).toContain("(self-approved)");
  });

  it("adds nothing to a return or a submit", () => {
    const line = historyLine(
      {
        ...base,
        fromStatus: "in_review",
        toStatus: "needs_action",
        note: "Add a date",
      },
      at,
    );
    expect(line).not.toMatch(/ by |self-approved/);
    expect(line).toMatch(/: Add a date$/);
  });

  it("reads an unknown status as unknown", () => {
    expect(historyLine({ ...base, fromStatus: "zz", toStatus: "yy" }, at)).toBe(
      "Unknown to Unknown, 1 Jan",
    );
  });
});
