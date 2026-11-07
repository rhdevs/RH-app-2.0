import type { Event, PrismaClient } from "@prisma/client";

/**
 * Writing an Event row, taken out of `event.create` so another caller can make
 * a draft without copying the explicit-null list. `event.create` is the first
 * caller. Nothing here reads or authorises anything: the caller decides who may
 * make the draft, what it holds and which id it gets (`nextEventId`).
 */

/**
 * WHAT "BLANK" MEANS ON AN EVENT ROW — ONE DEFINITION, USED TWICE.
 *
 * D-30's reuse rule needs two things to agree exactly: the `where` that FINDS a
 * blank draft, and the `create` that MAKES one. While they were two hand-written
 * lists in two places they drifted immediately — `create` omitted
 * `publicDescription` and `bannerUrl` while the filter demanded both be null,
 * and because Prisma's null match is the strict one (T-12) a row created here
 * could never match the filter meant to find it. Reuse never fired once; every
 * press of "New event" allocated a new id, silently, with a green build.
 *
 * THE TWO LISTS ARE NOW THE SAME OBJECT, so that drift is no longer a matter of
 * discipline:
 *   - spread into the reuse `where`, it IS the blankness condition;
 *   - spread FIRST into `create`'s `data`, it guarantees every one of these keys
 *     is written explicitly — later keys in the same object literal override it
 *     with the caller's real values.
 * Add a field here and both sides move together. Add one to the create only and
 * the filter ignores it, which costs at worst one extra blank row. The dangerous
 * direction — a filter key that the create never writes — can no longer be
 * expressed at all.
 *
 * NOT the four inert Phase-2 fields (attendanceOpensAt, attendanceClosesAt,
 * scannerUserIDs, answersPurgedAt). `create` must write those for the same T-12
 * reason, but they are not part of BLANKNESS: nothing a head types sets them, so
 * requiring them in the filter would be noise. They stay spelled out at the
 * create site, with the comment that explains why.
 *
 * `satisfies Partial<Record<keyof Event, null>>` is the guard
 * SCRC_HIDDEN_EVENT_FIELDS uses above: a renamed or deleted column fails the
 * build here rather than quietly becoming a filter key that matches nothing.
 */
export const BLANK_EVENT_CONTENT = {
  title: null,
  description: null,
  publicDescription: null,
  bannerUrl: null,
  startTime: null,
  endTime: null,
  location: null,
  facilityID: null,
  capacity: null,
  // ADDED BY PART C (D-59a). Both are Int?, so `null` is a legal value and the
  // `satisfies` guard accepts them. Safe in the only direction that matters:
  // `create` and `duplicate` have written both explicitly as null since they
  // were added, so every row this filter is meant to find already carries the
  // keys and Prisma's strict null match (T-12) is satisfied. A row predating
  // that simply fails to match and the head gets one extra blank draft — the
  // benign direction, and the one this branch already commits to in writing.
  //
  // scannerUserIDs IS DELIBERATELY ABSENT AND CANNOT BE ADDED. It is
  // `String[] @default([])`, a non-nullable list whose absent value is `[]`,
  // not `null`, so it does not satisfy Partial<Record<keyof Event, null>> and
  // adding it does not compile. IF YOU HIT THAT BUILD ERROR, DO NOT LOOSEN THIS
  // `satisfies` CLAUSE TO ADMIT IT — the clause is what keeps this filter safe
  // against a renamed column, and loosening it IS the defect. It is checked in
  // JS below instead, beside the question count, for the same reason.
  attendanceOpensAt: null,
  attendanceClosesAt: null,
} as const satisfies Partial<Record<keyof Event, null>>;

export type NewEventRow = {
  eventID: number;
  /** null = hall-wide. Always written, even when null. */
  ccaID: number | null;
  createdBy: string;
  title: string | null;
  description: string | null;
  startTime: number | null;
  endTime: number | null;
  location: string | null;
  facilityID: number | null;
  capacity: number | null;
  publicDescription: string | null;
};

/** Create one unpublished draft row, every key written explicitly. */
export async function createEventRow(
  db: Pick<PrismaClient, "event">,
  row: NewEventRow,
): Promise<void> {
  const {
    eventID,
    ccaID,
    createdBy,
    title,
    description,
    startTime,
    endTime,
    location,
    facilityID,
    capacity,
    publicDescription,
  } = row;
  await db.event.create({
    data: {
      // FIRST, so every blankness key is written even if the explicit
      // assignments below stop naming one of them. The keys that follow
      // override these nulls with the caller's real values; any that stop
      // being named stay explicitly null, which is exactly what the reuse
      // filter above needs and what omitting them broke. See
      // BLANK_EVENT_CONTENT.
      ...BLANK_EVENT_CONTENT,
      eventID,
      // WRITTEN EXPLICITLY, EVEN WHEN NULL. `{ ccaID: null }` matches a
      // STORED null but NOT an absent field, and listForOwner's hall branch
      // queries exactly that. A row created without the key would be
      // invisible to the only list that can reach it — created successfully,
      // then unmanageable, with no error anywhere — while still reading back
      // fine via findUnique({ eventID }), so every single-event test passes.
      ccaID,
      createdBy,
      title,
      description,
      startTime,
      endTime,
      location,
      facilityID,
      capacity,
      // THE TWO PUBLIC-CONTENT FIELDS, EXPLICITLY NULL — same rule as
      // ccaID above, and omitting them was a REAL BUG found by pressing
      // "New event" twice in a browser. The D-30 reuse filter asks for
      // `publicDescription: null, bannerUrl: null` among its blankness
      // conditions. Prisma's null match is the strict one (that is the
      // whole premise of T-12), so a row created WITHOUT these keys does
      // not match a filter asking for them to be null — and this create is
      // the only thing that makes the rows the filter is meant to find.
      // Reuse could therefore never fire: every press of the button
      // allocated a new id, which is precisely the unbounded-blanks
      // outcome D-30 exists to prevent. Nothing errored; the cap was
      // simply never enforced.
      publicDescription,
      bannerUrl: null,
      status: "draft",
      // THE FOUR INERT PHASE-2 FIELDS, WRITTEN EXPLICITLY FOR THE SAME
      // REASON AS ccaID. Nothing reads them today, so omitting them is
      // harmless TODAY — and that is exactly what makes it a landmine.
      // D-17 lands them now so the attendance and purge phases need no
      // second schema pass, which means those phases will query these very
      // rows. `where: { answersPurgedAt: null }` — the obvious way to find
      // events whose answers still need purging — matches a STORED null and
      // NOT an absent key, so every event created in Phase 1 would be
      // invisible to the purge, silently and forever. Writing them costs
      // one line each; discovering the omission costs a data-retention
      // incident.
      attendanceOpensAt: null,
      attendanceClosesAt: null,
      scannerUserIDs: [],
      answersPurgedAt: null,
      createdAt: new Date(),
    },
  });
}
