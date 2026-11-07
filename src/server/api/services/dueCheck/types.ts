import type { PrismaClient } from "@prisma/client";

/** What a kind is handed: one person, the clock and that clock's Singapore day. */
export type DueContext = {
  db: PrismaClient;
  /** The one person whose notices are being worked out. */
  userID: string;
  now: Date;
  /** `sgtDayKey(now)`, for keys that mean "once per Singapore day". */
  dayKey: string;
};

/** One notice a kind says is due for this person. */
export type DueNotice = {
  /**
   * The notice key scope: the same string for the same occasion, so a second
   * run (another tab, device or cron) finds the row and writes nothing.
   * `notify` appends the person, so this names the occasion only, for example
   * "due.cca_no_director:<cca>:<Singapore day>". Letters, digits and `_.:-`.
   */
  key: string;
  title: string;
  body?: string;
  /** An in-app path starting with a single "/". */
  href?: string;
  /**
   * Higher is more urgent. Read only when the kind's `catchUp` is
   * "mostUrgent"; ties keep the order the kind returned them in.
   */
  urgency?: number;
};

/**
 * One timed notice. Adding a kind is adding one entry to the registry
 * (registry.ts); the runner is not touched.
 */
export type DueKind = {
  /** Machine name for logs, for example "cca_no_director". */
  name: string;
  /** The `Notification.kind` the rows carry, for example "cca.no_director". */
  noticeKind: string;
  /**
   * What happens when several notices of this kind are due at once, which is
   * what a long absence produces for a reminder:
   *  - "all": every one is written;
   *  - "mostUrgent": only the one with the highest `urgency` is written, so a
   *    person back after weeks gets one reminder, not a pile.
   */
  catchUp: "all" | "mostUrgent";
  /**
   * What is due for this person, from stored state only. Read strictly: a
   * read that throws propagates, and the runner then writes nothing for this
   * kind and logs the error name. Return [] when nothing is due.
   */
  due(ctx: DueContext): Promise<DueNotice[]>;
};

export type DueCheckResult = {
  /** Inbox rows this run wrote. */
  written: number;
  /** Names of kinds that failed (their errors are logged by name). */
  failedKinds: string[];
};
