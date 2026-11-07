import { type Metadata } from "next";
import { notFound } from "next/navigation";

import BroadcastDetail from "../../_components/BroadcastDetail";

export const metadata: Metadata = {
  title: "Deadline reminder",
  robots: { index: false, follow: false },
};

export default function BroadcastPage({ params }: { params: { id: string } }) {
  // The same shape the procedures accept; anything else is not a reminder.
  if (!/^[a-f\d]{24}$/i.test(params.id)) notFound();
  return <BroadcastDetail id={params.id} />;
}
