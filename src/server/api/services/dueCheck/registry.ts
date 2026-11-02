import { broadcastNudgeKind } from "./broadcastNudge";
import { ccaNoDirectorKind } from "./ccaNoDirector";
import { collectionDigestKind } from "./collectionDigest";
import { disposablesNoDirectorKind } from "./disposablesNoDirector";
import { milestoneRemindersKind } from "./milestoneReminders";
import type { DueKind } from "./types";

/**
 * Every timed notice the due check knows. TO ADD ONE, add its entry here and
 * nothing else: the runner reads this list and is not touched. A kind that
 * needs a new index must have its script run before its flag goes on.
 *
 * PR 13 registered the no-Social-director notice. PR 14 registered the
 * collection digest and the broadcast deadline nudges; PR 16 registers the milestone
 * reminders. The nudge kind needs the ReminderTarget indexes,
 * so its script must run before `reminders.enabled` goes on.
 */
export const DUE_KINDS: readonly DueKind[] = [
  ccaNoDirectorKind,
  disposablesNoDirectorKind,
  collectionDigestKind,
  broadcastNudgeKind,
  milestoneRemindersKind,
];
