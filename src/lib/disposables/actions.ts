import type { DisposableStatus } from "./status";

/**
 * Which buttons a viewer may be shown on one request. The SERVER computes this
 * from the stored rows and sends the result with each request; the screen only
 * draws it. It is not what authorizes a write: every procedure re-checks.
 *
 *  - The Social director (the holder of the one `handlesDisposables` position)
 *    decides, edits and deletes any request, for any CCA.
 *  - Everyone else, a CCA's own head included, directors and JCRC members
 *    too, can act on nothing (A9, 4.9: a head creates and reads only).
 */
export type RequestActions = {
  approve: boolean;
  reject: boolean;
  edit: boolean;
  delete: boolean;
};

export function requestActions(input: {
  isSocialDirector: boolean;
  status: DisposableStatus;
}): RequestActions {
  const { isSocialDirector, status } = input;
  return {
    approve: isSocialDirector && status === "pending",
    reject: isSocialDirector && status === "pending",
    edit: isSocialDirector,
    delete: isSocialDirector,
  };
}
