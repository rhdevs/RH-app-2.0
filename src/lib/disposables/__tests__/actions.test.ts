import { describe, expect, it } from "vitest";

import { requestActions } from "../actions";
import { canMove, DISPOSABLE_STATUSES } from "../status";

const social = { isSocialDirector: true };
const other = { isSocialDirector: false };

describe("requestActions", () => {
  it("the Social director decides a pending request and edits or deletes any", () => {
    expect(requestActions({ ...social, status: "pending" })).toEqual({
      approve: true,
      reject: true,
      edit: true,
      delete: true,
      nudge: false,
    });
    expect(requestActions({ ...social, status: "approved" })).toEqual({
      approve: false,
      reject: false,
      edit: true,
      delete: true,
      nudge: false,
    });
    expect(requestActions({ ...social, status: "rejected" }).edit).toBe(true);
  });

  it("anyone else, a CCA's own head, directors and JCRC included, can do nothing", () => {
    for (const status of DISPOSABLE_STATUSES) {
      expect(requestActions({ ...other, status })).toEqual({
        approve: false,
        reject: false,
        edit: false,
        delete: false,
        nudge: false,
      });
    }
  });

  it("only a head of the CCA nudges, only while pending, and never the Social director", () => {
    const head = { isSocialDirector: false, isHeadOfCca: true };
    expect(requestActions({ ...head, status: "pending" }).nudge).toBe(true);
    expect(requestActions({ ...head, status: "approved" }).nudge).toBe(false);
    expect(requestActions({ ...head, status: "rejected" }).nudge).toBe(false);
    expect(requestActions({ ...other, status: "pending" }).nudge).toBe(false);
    expect(
      requestActions({
        isSocialDirector: true,
        isHeadOfCca: true,
        status: "pending",
      }).nudge,
    ).toBe(false);
    // A head gets nothing else.
    expect(requestActions({ ...head, status: "pending" })).toMatchObject({
      approve: false,
      reject: false,
      edit: false,
      delete: false,
    });
  });
});

describe("canMove", () => {
  it("allows a decision from pending, the way back from approved, and nothing from rejected", () => {
    expect(canMove("pending", "approved")).toBe(true);
    expect(canMove("pending", "rejected")).toBe(true);
    expect(canMove("approved", "pending")).toBe(true);
    expect(canMove("approved", "rejected")).toBe(false);
    expect(canMove("rejected", "pending")).toBe(false);
    expect(canMove("rejected", "approved")).toBe(false);
  });
});
