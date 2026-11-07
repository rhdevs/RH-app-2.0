import { type Metadata } from "next";
import { notFound } from "next/navigation";

import { LOAN_ID } from "~/lib/equipment/photo";
import LoanScreen from "../_components/LoanScreen";

export const metadata: Metadata = {
  title: "Equipment loan",
  robots: { index: false, follow: false },
};

export default function EquipmentLoanPage({
  params,
}: {
  params: { id: string };
}) {
  // The same shape the procedures accept; anything else is not a loan.
  if (!LOAN_ID.test(params.id)) notFound();
  return <LoanScreen loanID={params.id.toLowerCase()} />;
}
