import { notFound } from "next/navigation";

import CcaDashboardShell from "../_components/CcaDashboardShell";
import { parseCcaID } from "../_lib/ccaParam";

/**
 * The dashboard shell for one CCA. Wraps every section, so the sidebar and CCA
 * heading persist across navigation instead of being re-rendered per page.
 *
 * NOT a security boundary — see the note in CcaDashboardShell. The parent
 * /cca/layout.tsx establishes "this surface is for you"; each section's
 * procedure establishes "this CCA is yours".
 *
 * Next 14.2: `params` is a plain object, not a Promise. Do not await it.
 */
export default function CcaIdLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();

  return <CcaDashboardShell ccaID={ccaID}>{children}</CcaDashboardShell>;
}
