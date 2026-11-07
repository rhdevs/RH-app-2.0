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
    });
    expect(requestActions({ ...social, status: "approved" })).toEqual({
      approve: false,
      reject: false,
      edit: true,
      delete: true,
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
      });
    }
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
