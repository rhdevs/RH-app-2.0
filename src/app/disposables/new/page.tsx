import { type Metadata } from "next";

import { parseCcaID } from "~/app/cca/_lib/ccaParam";
import DisposableForm from "../_components/DisposableForm";

export const metadata: Metadata = {
  title: "New disposables request",
  robots: { index: false, follow: false },
};

/** `?cca=<id>` pre-selects the CCA when the link came from its dashboard tab. */
export default function NewDisposablePage({
  searchParams,
}: {
  searchParams: { cca?: string };
}) {
  const ccaID =
    typeof searchParams.cca === "string" ? parseCcaID(searchParams.cca) : null;
  return <DisposableForm initialCcaID={ccaID ?? undefined} />;
}
