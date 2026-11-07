import { notFound } from "next/navigation";
import SurfaceTheme from "~/app/_components/theme/SurfaceTheme";

import EvidencePanel from "../../_components/EvidencePanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's milestone evidence photos. No server guard: every evidence
 * procedure checks the flag and that the caller heads THIS CCA, and the photos
 * themselves are served by an access-checked route.
 */
export default function CcaEvidencePage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <SurfaceTheme className="dark:rounded-lg dark:p-4">
      <EvidencePanel ccaID={ccaID} />
    </SurfaceTheme>
  );
}
