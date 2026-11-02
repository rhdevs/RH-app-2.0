import { HEAD_EDITABLE, type DisposableStatus } from "./status";

/**
 * Which buttons a viewer may be shown on one request. The SERVER computes this
 * from the stored rows and sends the result with each request; the screen only
 * draws it. It is not what authorizes a write: every procedure re-checks.
 *
 *  - The Social director (the holder of the one `handlesDisposables` position)
 *    decides, edits and deletes any request, for any CCA.
 *  - A head edits their own CCA's request while it is pending or approved.
 *  - Everyone else, directors and JCRC members included, sees and acts on
 *    nothing (A9, A54).
 */
export type RequestActions = {
  approve: boolean;
  reject: boolean;
  edit: boolean;
  delete: boolean;
};

export function requestActions(input: {
  isSocialDirector: boolean;
  headsCca: boolean;
  status: DisposableStatus;
}): RequestActions {
  const { isSocialDirector, headsCca, status } = input;
  return {
    approve: isSocialDirector && status === "pending",
    reject: isSocialDirector && status === "pending",
    edit: isSocialDirector || (headsCca && HEAD_EDITABLE.includes(status)),
    delete: isSocialDirector,
  };
}
