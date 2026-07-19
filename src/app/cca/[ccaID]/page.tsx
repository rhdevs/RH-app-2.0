import { notFound } from "next/navigation";

import RosterPanel from "~/app/_components/RosterPanel";

/**
 * One CCA's roster.
 *
 * NO SERVER-SIDE PRE-GUARD, deliberately. cca.getRoster carries the
 * object-scoped check and is the one policy site; duplicating it here would be
 * a second place to keep in step for no additional protection, since a client
 * can call the procedure directly regardless (I-7).
 *
 * Next 14.2: `params` is a PLAIN OBJECT, not a Promise. Do not await it.
 */
export default function CcaRosterPage({
  params,
}: {
  params: { ccaID: string };
}) {
  // BOTH checks are required. z.coerce-style parsing accepts "12.0", " 12" and
  // "+12", and Number("") is 0 — and ccaID 0 is RESERVED (see cascade.ts), so a
  // permissive parse turns an empty segment into a real-looking lookup.
  if (!/^\d+$/.test(params.ccaID)) notFound();
  const ccaID = Number(params.ccaID);
  if (!Number.isSafeInteger(ccaID) || ccaID <= 0) notFound();

  return <RosterPanel ccaID={ccaID} />;
}
