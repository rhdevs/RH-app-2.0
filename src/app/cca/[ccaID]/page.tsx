import CcaOverview from "../_components/CcaOverview";
import { parseCcaID } from "../_lib/ccaParam";
import { notFound } from "next/navigation";

/**
 * Overview — the dashboard's index section.
 *
 * No server-side guard: cca.getRoster carries the object-scoped check and is
 * the one policy site (I-7). The layout has already validated the id's shape.
 */
export default function CcaOverviewPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <CcaOverview ccaID={ccaID} />;
}
