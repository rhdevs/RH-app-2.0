import { notFound } from "next/navigation";
import SurfaceTheme from "~/app/_components/theme/SurfaceTheme";

import ProposalEditor from "../../../_components/ProposalEditor";
import { parseCcaID } from "../../../_lib/ccaParam";

export default function NewProposalPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <SurfaceTheme className="dark:rounded-lg dark:p-4">
      <ProposalEditor ccaID={ccaID} />
    </SurfaceTheme>
  );
}
