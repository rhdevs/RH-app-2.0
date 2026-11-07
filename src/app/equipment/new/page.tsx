import { type Metadata } from "next";

import LoanForm from "../_components/LoanForm";

export const metadata: Metadata = {
  title: "Borrow equipment",
  robots: { index: false, follow: false },
};

/** `?eventID=<id>` is the event the loan is for (the event page's link). */
const parseEventID = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
};

export default function NewEquipmentLoanPage({
  searchParams,
}: {
  searchParams: { eventID?: string };
}) {
  return <LoanForm eventID={parseEventID(searchParams.eventID)} />;
}
