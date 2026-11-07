import { isDisposableStatus } from "./status";

/** The CCA filter's value for requests for hall-wide events (no CCA). */
export const HALL_WIDE_FILTER = "hall";

export type DisposableFilters = {
  status: string;
  /** A CCA id, `HALL_WIDE_FILTER`, or blank for all. */
  ccaID: string;
  eventID: string;
  from: string;
  to: string;
};

export const NO_FILTERS: DisposableFilters = {
  status: "",
  ccaID: "",
  eventID: "",
  from: "",
  to: "",
};

/** The list input for the filter boxes; blank boxes are left out. */
export function filtersToInput(f: DisposableFilters, fixedCcaID?: number) {
  const hallWide = fixedCcaID === undefined && f.ccaID === HALL_WIDE_FILTER;
  const cca =
    fixedCcaID ?? (f.ccaID === "" || hallWide ? undefined : Number(f.ccaID));
  const event = f.eventID === "" ? undefined : Number(f.eventID);
  return {
    ...(hallWide && { hallWide: true as const }),
    ...(event !== undefined &&
      Number.isInteger(event) &&
      event > 0 && { eventID: event }),
    ...(isDisposableStatus(f.status) && { status: f.status }),
    ...(cca !== undefined &&
      Number.isInteger(cca) &&
      cca > 0 && { ccaID: cca }),
    ...(f.from !== "" && { from: f.from }),
    ...(f.to !== "" && { to: f.to }),
  };
}
