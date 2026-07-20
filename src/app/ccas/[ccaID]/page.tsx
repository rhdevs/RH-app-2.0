import { notFound } from "next/navigation";

import { parseCcaID } from "~/app/cca/_lib/ccaParam";
import CcaApplyPanel from "../_components/CcaApplyPanel";

export const dynamic = "force-dynamic";

/** One CCA's page: details + apply + interview scheduling. The param is parsed
 *  with the SAME helper the head dashboard uses so "what is a valid ccaID"
 *  cannot drift; all real authorization is in the procedures. */
export default function CcaDetailPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return <CcaApplyPanel ccaID={ccaID} />;
}
