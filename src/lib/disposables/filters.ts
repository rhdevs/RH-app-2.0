import { isDisposableStatus } from "./status";

export type DisposableFilters = {
  status: string;
  ccaID: string;
  from: string;
  to: string;
};

export const NO_FILTERS: DisposableFilters = {
  status: "",
  ccaID: "",
  from: "",
  to: "",
};

/** The list input for the filter boxes; blank boxes are left out. */
export function filtersToInput(f: DisposableFilters, fixedCcaID?: number) {
  const cca = fixedCcaID ?? (f.ccaID === "" ? undefined : Number(f.ccaID));
  return {
    ...(isDisposableStatus(f.status) && { status: f.status }),
    ...(cca !== undefined &&
      Number.isInteger(cca) &&
      cca > 0 && { ccaID: cca }),
    ...(f.from !== "" && { from: f.from }),
    ...(f.to !== "" && { to: f.to }),
  };
}
