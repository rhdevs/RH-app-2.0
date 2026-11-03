import { notFound } from "next/navigation";
import SurfaceTheme from "~/app/_components/theme/SurfaceTheme";

import YearView from "~/app/milestones/_components/YearView";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's milestones by year. No server guard: the procedures check the flag
 * and that the caller is a head or director of THIS CCA.
 */
export default function CcaMilestonesTabPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  return (
    <SurfaceTheme className="dark:rounded-lg dark:p-4">
      <YearView ccaID={ccaID} />
    </SurfaceTheme>
  );
}
