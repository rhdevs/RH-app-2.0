import { del } from "@vercel/blob";

import { isOwnProposalPosterUrl } from "~/lib/schemas/proposalFiles";

/**
 * Remove a replaced or removed poster's blob. Kept out of services/proposals/
 * on purpose: that folder's code catches nothing (proposalSourceScans), and
 * this one catch is the whole point here.
 *
 * Non-fatal, as for Events (routers/event.ts): a failed delete is logged (the
 * address and the error name only, never the message) and leaves an orphan
 * blob, but never undoes or fails the write that already succeeded. An address
 * that is not this proposal's own is never passed to the store.
 */
export async function deleteReplacedPoster(
  proposalID: string,
  url: string,
): Promise<void> {
  if (!isOwnProposalPosterUrl(url, proposalID)) return;
  try {
    await del(url);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "proposal_blob_delete_failed",
        proposalID,
        url,
        error: err instanceof Error ? err.name : "unknown",
      }),
    );
  }
}
