import type { PrismaClient } from "@prisma/client";

import { normalizeStatus, ownerLabel } from "~/lib/schemas/event";
import { directedCcasOrRefuse } from "~/server/api/services/proposals/access";
import { isProposalsEnabled } from "~/server/api/services/proposals/flag";
import { PUBLISHED_EVENTS_WHERE } from "~/server/api/services/events";

/**
 * What the calendar shows, read live every time. Nothing is copied: an Event
 * or proposal that changes changes the calendar on the next read.
 *
 * TWO LAYERS, read separately so one can fail without the other:
 *  - the EVENT layer: published Events, through the same filter the resident
 *    list uses (`PUBLISHED_EVENTS_WHERE`). Anyone signed in may see these.
 *  - the PROPOSAL layer: the proposals a person may already read, by the same
 *    strict rules as the proposal screens. The CCA's heads see every proposal
 *    that is not canceled (a draft is the heads' working space); its directors
 *    see submitted ones only; nobody else sees any. Off while
 *    `proposals.enabled` is off. A read that fails THROWS here, so the caller
 *    can show an error on the layer instead of an empty one.
 *
 * A proposal drops out of its layer once its linked Event is published or
 * canceled, so nothing appears twice. A linked Event that is still a draft, or
 * was deleted, leaves the proposal showing.
 */

/** A hard ceiling on one read, whatever the window. */
export const CALENDAR_ROW_MAX = 1000;

/** A read that hit the ceiling was cut short: say so, with the count. */
function warnIfCapped(layer: string, count: number): void {
  if (count >= CALENDAR_ROW_MAX) {
    console.warn(
      JSON.stringify({
        evt: "calendar_row_cap_hit",
        layer,
        count,
        cap: CALENDAR_ROW_MAX,
      }),
    );
  }
}

export type CalendarEventItem = {
  eventID: number;
  ccaID: number | null;
  owner: string;
  title: string;
  description: string | null;
  location: string | null;
  startTime: number;
  endTime: number | null;
  updatedAt: Date | null;
};

export type ProposalLayerItem = {
  id: string;
  ccaID: number;
  owner: string;
  title: string;
  status: string;
  /** How this reader may read it: decides which screen the link opens. */
  viewer: "head" | "director";
  plannedStart: number;
  plannedEnd: number | null;
  updatedAt: Date;
};

async function ccaNames(
  db: Pick<PrismaClient, "cCA">,
  ccaIDs: number[],
): Promise<Map<number, string | null>> {
  const byID = new Map<number, string | null>();
  const unique = [...new Set(ccaIDs)];
  if (unique.length === 0) return byID;
  const rows = await db.cCA.findMany({
    where: { ccaID: { in: unique } },
    select: { ccaID: true, ccaName: true },
  });
  for (const r of rows) byID.set(r.ccaID, r.ccaName);
  return byID;
}

/** Published Events that start in [from, to), epoch seconds, soonest first. */
export async function readPublishedEvents(
  db: Pick<PrismaClient, "event" | "cCA">,
  from: number,
  to: number,
): Promise<CalendarEventItem[]> {
  const rows = await db.event.findMany({
    where: { ...PUBLISHED_EVENTS_WHERE, startTime: { gte: from, lt: to } },
    orderBy: [{ startTime: "asc" }, { eventID: "asc" }],
    take: CALENDAR_ROW_MAX,
    select: {
      eventID: true,
      ccaID: true,
      title: true,
      publicDescription: true,
      location: true,
      startTime: true,
      endTime: true,
      updatedAt: true,
    },
  });
  warnIfCapped("events", rows.length);
  const names = await ccaNames(
    db,
    rows.flatMap((r) => (r.ccaID == null ? [] : [r.ccaID])),
  );
  return rows.flatMap((r) =>
    r.startTime == null
      ? []
      : [
          {
            eventID: r.eventID,
            ccaID: r.ccaID,
            owner: ownerLabel(
              r.ccaID,
              r.ccaID == null ? null : (names.get(r.ccaID) ?? null),
            ),
            title: r.title?.trim() ? r.title : "Untitled event",
            description: r.publicDescription,
            location: r.location,
            startTime: r.startTime,
            endTime: r.endTime,
            updatedAt: r.updatedAt,
          },
        ],
  );
}

/**
 * The proposals this person may read now that are planned to start in
 * [from, to). Returns null while `proposals.enabled` is off. Every read after
 * the flag is strict: no catch, so a failure reaches the caller.
 */
export async function readProposalLayer(
  db: PrismaClient,
  userID: string,
  from: number,
  to: number,
): Promise<ProposalLayerItem[] | null> {
  if (!(await isProposalsEnabled(db))) return null;

  const [headRows, directed] = await Promise.all([
    db.ccaHead.findMany({ where: { userID }, select: { ccaID: true } }),
    directedCcasOrRefuse(db, userID),
  ]);
  const headOf = [...new Set(headRows.map((h) => h.ccaID))];
  const headSet = new Set(headOf);
  // A person who is both head and director of a CCA is a head there.
  const directorOnly = directed.filter((id) => !headSet.has(id));
  if (headOf.length === 0 && directorOnly.length === 0) return [];

  const rows = await db.proposal.findMany({
    where: {
      plannedStart: { gte: from, lt: to },
      OR: [
        ...(headOf.length > 0
          ? [{ ccaID: { in: headOf }, status: { not: "canceled" } }]
          : []),
        ...(directorOnly.length > 0
          ? [
              {
                ccaID: { in: directorOnly },
                status: { notIn: ["draft", "canceled"] },
              },
            ]
          : []),
      ],
    },
    orderBy: [{ plannedStart: "asc" }, { id: "asc" }],
    take: CALENDAR_ROW_MAX,
    select: {
      id: true,
      ccaID: true,
      title: true,
      status: true,
      plannedStart: true,
      plannedEnd: true,
      eventID: true,
      updatedAt: true,
    },
  });

  warnIfCapped("proposals", rows.length);
  // Hide a proposal whose Event has gone live or been canceled. The Event is
  // looked up by id, not by the window: it may have moved to another month.
  const linked = [
    ...new Set(rows.flatMap((r) => (r.eventID == null ? [] : [r.eventID]))),
  ];
  const settled = new Set<number>();
  if (linked.length > 0) {
    const events = await db.event.findMany({
      where: { eventID: { in: linked } },
      select: { eventID: true, status: true },
    });
    for (const e of events) {
      const status = normalizeStatus(e.status);
      if (status === "published" || status === "canceled") {
        settled.add(e.eventID);
      }
    }
  }

  const shown = rows.filter(
    (r) => !(r.eventID != null && settled.has(r.eventID)),
  );
  const names = await ccaNames(
    db,
    shown.map((r) => r.ccaID),
  );
  return shown.flatMap((r) =>
    r.plannedStart == null
      ? []
      : [
          {
            id: r.id,
            ccaID: r.ccaID,
            owner: ownerLabel(r.ccaID, names.get(r.ccaID) ?? null),
            title: r.title,
            status: r.status,
            viewer: headSet.has(r.ccaID)
              ? ("head" as const)
              : ("director" as const),
            plannedStart: r.plannedStart,
            plannedEnd: r.plannedEnd,
            updatedAt: r.updatedAt,
          },
        ],
  );
}
