/** Where the disposable screens live, for notices and navigation. */
export const DISPOSABLES_HREF = "/disposables";
export const NEW_DISPOSABLE_HREF = "/disposables/new";
export const disposableHref = (id: string) => `/disposables/${id}`;
/** The new-request form with this event already chosen. */
export const newDisposableForEventHref = (eventID: number) =>
  `${NEW_DISPOSABLE_HREF}?event=${eventID}`;
