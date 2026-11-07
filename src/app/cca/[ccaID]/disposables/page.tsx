import { notFound } from "next/navigation";
import SurfaceTheme from "~/app/_components/theme/SurfaceTheme";

import DisposablesScreen from "~/app/disposables/_components/DisposablesScreen";
import { parseCcaID } from "../../_lib/ccaParam";

/**
 * The CCA's disposables requests. No server guard: every disposable procedure
 * checks the flag and that the caller heads THIS CCA (or may read all).
 */
export default function CcaDisposablesPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return (
    <SurfaceTheme className="dark:rounded-lg dark:p-4">
      <DisposablesScreen ccaID={ccaID} />
    </SurfaceTheme>
  );
}
