import { notFound } from "next/navigation";
import SurfaceTheme from "~/app/_components/theme/SurfaceTheme";

import ProposalsPanel from "../../_components/ProposalsPanel";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's proposals. No server guard: every proposal procedure checks the
 * flag and that the caller heads (or directs) THIS CCA, the same policy as the
 * events section.
 */
export default function CcaProposalsPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <SurfaceTheme className="dark:rounded-lg dark:p-4">
      <ProposalsPanel ccaID={ccaID} />
    </SurfaceTheme>
  );
}
