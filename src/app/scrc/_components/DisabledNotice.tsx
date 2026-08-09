"use client";

import { PowerOff } from "lucide-react";

/**
 * THE FIRST THING ANYONE WILL SEE ON THIS PAGE.
 *
 * `scrc` ships with its kill switch OFF (scrcFlag.ts fails closed: no row, or an
 * unreachable Atlas, both mean disabled), so every procedure this surface calls
 * refuses with SCRC_DISABLED until an admin writes `scrc.enabled = "on"`. That
 * is a CONFIGURATION STATE, not a failure — a red "something went wrong" box
 * here would send the first hall-office member to open the page straight to the
 * dev team for a system behaving exactly as designed.
 *
 * So it renders calm and grey, in the shape of the empty states elsewhere in the
 * app, and says what has to happen next. It is NOT an error alert, and it must
 * not become one.
 *
 * EVENTS_DISABLED gets the same treatment for the same reason: the events kill
 * switch is independent, so the Events panel can legitimately be dark while the
 * other two work.
 *
 * CCA_MANAGEMENT_DISABLED is handled here even though no procedure this surface
 * calls throws it today (`cca.listAllForOversight` and `cca.getRoster` are both
 * behind `scrc.enabled`, not `cca.management.enabled`). Kept so that if a future
 * guard is added to either, it degrades into this calm state rather than into a
 * red crash — which is exactly the regression this component exists to prevent.
 */
const DISABLED_COPY: Record<string, { title: string; hint: string }> = {
  SCRC_DISABLED: {
    title: "Hall Office tools aren’t switched on yet",
    hint: "The role exists and you can reach this page, but the tools behind it are still turned off. An admin switches them on with the scrc.enabled setting; it takes effect within about fifteen seconds, with no redeploy.",
  },
  EVENTS_DISABLED: {
    title: "Events aren’t switched on yet",
    hint: "The Events feature is turned off for the whole hall, so there is nothing to look in on. An admin switches it on with the events.enabled setting.",
  },
  CCA_MANAGEMENT_DISABLED: {
    title: "CCA management isn’t switched on yet",
    hint: "The CCA machinery is turned off for the whole hall. An admin switches it on with the cca.management.enabled setting.",
  },
};

/**
 * Is this tRPC error message a kill switch rather than a fault? Returns the copy
 * to render, or null to let the caller fall through to its normal error state.
 *
 * Matches on the message STRING because that is the contract these procedures
 * publish (every one of them throws FORBIDDEN with one of these as the message).
 * Deliberately exact-match, never `includes()`: a substring test would swallow a
 * future, genuinely different error whose message happened to mention one of
 * these, and render it as "not switched on yet" — which would be a lie that
 * looks intentional.
 */
export function disabledCopy(message: string | null | undefined) {
  if (!message) return null;
  return DISABLED_COPY[message] ?? null;
}

export default function DisabledNotice({ message }: { message: string }) {
  const copy = disabledCopy(message);
  if (!copy) return null;
  return (
    <div className="rounded-xl bg-white p-10 text-center shadow-lg">
      <PowerOff className="mx-auto h-8 w-8 text-gray-300" />
      <p className="mt-2 text-sm font-medium text-gray-900">{copy.title}</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-gray-500">{copy.hint}</p>
    </div>
  );
}
