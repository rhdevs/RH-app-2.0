import { type Metadata } from "next";
import { notFound } from "next/navigation";

import DisposableForm from "../_components/DisposableForm";

export const metadata: Metadata = {
  title: "Edit disposables request",
  robots: { index: false, follow: false },
};

export default function EditDisposablePage({
  params,
}: {
  params: { id: string };
}) {
  // The same shape the procedures accept; anything else is not a request.
  if (!/^[a-f\d]{24}$/i.test(params.id)) notFound();
  return <DisposableForm requestID={params.id} />;
}
