import { type Metadata } from "next";

import { parseCcaID } from "~/app/cca/_lib/ccaParam";
import DisposableForm from "../_components/DisposableForm";

export const metadata: Metadata = {
  title: "New disposables request",
  robots: { index: false, follow: false },
};

/** `?event=<id>` opens the form with that event chosen (the event page's link). */
const parseEventID = (raw: unknown): number | undefined => {
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
};

/** `?cca=<id>` narrows the event choices when the link came from a CCA's tab. */
export default function NewDisposablePage({
  searchParams,
}: {
  searchParams: { cca?: string; event?: string };
}) {
  const ccaID =
    typeof searchParams.cca === "string" ? parseCcaID(searchParams.cca) : null;
  return (
    <DisposableForm
      initialCcaID={ccaID ?? undefined}
      initialEventID={parseEventID(searchParams.event)}
    />
  );
}
