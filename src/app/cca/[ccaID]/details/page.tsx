import { notFound } from "next/navigation";

import CcaDetailsForm from "../../_components/CcaDetailsForm";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * CCA details — the only section that writes anything.
 *
 * No server-side guard: cca.updateProfile carries the object-scoped check and
 * is the one policy site (I-7). A pre-check here would be a second place to
 * keep in step while buying nothing, since the mutation is callable directly.
 */
export default function CcaDetailsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <CcaDetailsForm ccaID={ccaID} />;
}
