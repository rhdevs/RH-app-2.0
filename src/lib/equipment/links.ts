/** In-app paths for equipment loans. Safe as notice links: no photo address in any of them. */
export const EQUIPMENT_HREF = "/equipment";
export const EQUIPMENT_ITEMS_HREF = "/equipment/items";

export const equipmentLoanHref = (id: string) => `/equipment/${id}`;
export const equipmentNewHref = (eventID: number) =>
  `/equipment/new?eventID=${eventID}`;
