import { notFound } from "next/navigation";

import { isTranscriptEnabled } from "~/server/api/services/transcript/flag";
import { db } from "~/server/db";
import { TranscriptsOffPanel } from "../../../transcript/_components/TranscriptsOffPanel";
import { parseCcaID } from "../../_lib/ccaParam";
import TranscriptTab from "./_components/TranscriptTab";

export const dynamic = "force-dynamic";

/**
 * The CCA's transcript annotations: who was in for how long, roles, extra
 * contributions and, for a volunteering CCA, volunteer hours.
 *
 * No server-side guard here, matching the sibling sections: every procedure
 * behind it checks that the caller heads THIS CCA (or is a manager), so a head
 * of another CCA sees this shell and then a refusal inside it. While the
 * transcript kill switch is off, a calm note stands in for the tab.
 */
export default async function CcaTranscriptPage({
  params,
}: {
  params: { ccaID: string };
}) {
  const ccaID = parseCcaID(params.ccaID);
  if (ccaID === null) notFound();
  if (!(await isTranscriptEnabled(db))) {
    return <TranscriptsOffPanel forManagers={false} />;
  }

  return <TranscriptTab ccaID={ccaID} />;
}
