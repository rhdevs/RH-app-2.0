import { describe, expect, it } from "vitest";

import { equipmentErrorMessage } from "~/lib/equipment/errors";
import {
  equipmentPhotoFolder,
  equipmentPhotoPathFromUrl,
  equipmentPhotoUploadPath,
  parseEquipmentPhotoPath,
} from "~/lib/equipment/photo";
import {
  LOAN_STATUSES,
  canMove,
  holdsStock,
  holdsStockFor,
  isOverdue,
  LOAN_WINDOW_MAX_SECONDS,
} from "~/lib/equipment/status";
import {
  findShortfall,
  parseShortMessage,
  shortMessage,
  SHORT_DETAIL_LOANS_MAX,
  type ShortDetail,
} from "~/lib/equipment/stock";
import {
  loanCreateInput,
  DIRECTOR_NOTE_MAX,
  loanListInput,
  loanNoteInput,
  loanRejectInput,
} from "~/lib/schemas/equipment";

const ID = "a1".repeat(12);
const HOST = "teststore.private.blob.vercel-storage.com";

describe("loan status moves", () => {
  it("allows exactly the moves in the table", () => {
    const allowed = new Set([
      "requested>approved",
      "requested>rejected",
      "requested>canceled",
      "approved>collected",
      "approved>canceled",
      "collected>returned",
    ]);
    for (const from of LOAN_STATUSES) {
      for (const to of LOAN_STATUSES) {
        expect([from, to, canMove(from, to)]).toEqual([
          from,
          to,
          allowed.has(`${from}>${to}`),
        ]);
      }
    }
  });

  it("holds stock only while approved or collected", () => {
    expect(LOAN_STATUSES.filter(holdsStock)).toEqual(["approved", "collected"]);
  });

  it("holds stock by status and event: collected always, approved only while the event is open", () => {
    const states = ["ok", "canceled", "declined", "gone"] as const;
    for (const state of states) {
      expect([state, holdsStockFor("collected", state)]).toEqual([state, true]);
      expect([state, holdsStockFor("approved", state)]).toEqual([
        state,
        state === "ok" || state === "gone",
      ]);
      for (const status of [
        "requested",
        "rejected",
        "returned",
        "canceled",
      ] as const) {
        expect(holdsStockFor(status, state)).toBe(false);
      }
    }
  });

  it("caps a loan window at 60 days", () => {
    expect(LOAN_WINDOW_MAX_SECONDS).toBe(60 * 86_400);
  });

  it("is overdue only when holding stock past the return time", () => {
    const at = (status: (typeof LOAN_STATUSES)[number], returnAt: number) =>
      isOverdue({ status, returnAt }, 1000);
    expect(at("approved", 999)).toBe(true);
    expect(at("collected", 999)).toBe(true);
    expect(at("approved", 1000)).toBe(false);
    expect(at("requested", 1)).toBe(false);
    expect(at("returned", 1)).toBe(false);
    expect(at("canceled", 1)).toBe(false);
    expect(at("rejected", 1)).toBe(false);
  });
});

describe("findShortfall", () => {
  const held = (
    id: string,
    collectAt: number,
    returnAt: number,
    quantity: number,
  ) => ({
    id,
    collectAt,
    returnAt,
    quantity,
  });

  it("refuses 2 of 4 owned when 3 overlap", () => {
    const out = findShortfall({
      owned: 4,
      wanted: 2,
      window: { collectAt: 10, returnAt: 20 },
      holders: [held("x", 0, 15, 3)],
    });
    expect(out).toMatchObject({ at: 10, owned: 4, heldAtPeak: 3, wanted: 2 });
    expect(out?.holders.map((h) => h.id)).toEqual(["x"]);
  });

  it("allows it when the holders do not overlap the window", () => {
    const out = findShortfall({
      owned: 4,
      wanted: 2,
      window: { collectAt: 10, returnAt: 20 },
      holders: [held("x", 0, 10, 4), held("y", 20, 30, 4)],
    });
    expect(out).toBeNull();
  });

  it("looks at the busiest instant, not the sum of every overlapping loan", () => {
    // Two loans of 2 that never overlap each other: 4 owned, wanted 2 is fine.
    expect(
      findShortfall({
        owned: 4,
        wanted: 2,
        window: { collectAt: 0, returnAt: 100 },
        holders: [held("a", 0, 40, 2), held("b", 50, 90, 2)],
      }),
    ).toBeNull();
    // The same two overlapping each other at 4 held: refused where they meet.
    const out = findShortfall({
      owned: 5,
      wanted: 2,
      window: { collectAt: 0, returnAt: 100 },
      holders: [held("a", 0, 60, 2), held("b", 50, 90, 2)],
    });
    expect(out).toMatchObject({ at: 50, heldAtPeak: 4 });
  });

  it("catches a peak that starts inside the window", () => {
    const out = findShortfall({
      owned: 3,
      wanted: 2,
      window: { collectAt: 0, returnAt: 100 },
      holders: [held("late", 60, 80, 2)],
    });
    expect(out).toMatchObject({ at: 60, heldAtPeak: 2 });
  });
});

describe("short messages", () => {
  const detail: ShortDetail = {
    itemID: ID,
    name: "Tent",
    owned: 4,
    wanted: 2,
    heldAtPeak: 3,
    at: 10,
    loans: [
      { id: "l1", eventTitle: "Fair", collectAt: 1, returnAt: 2, quantity: 3 },
    ],
  };

  it("round-trips", () => {
    expect(parseShortMessage(shortMessage(detail))).toEqual(detail);
  });

  it("caps the holders named", () => {
    const many = {
      ...detail,
      loans: Array.from({ length: SHORT_DETAIL_LOANS_MAX + 5 }, (_, i) => ({
        id: `l${i}`,
        eventTitle: null,
        collectAt: 1,
        returnAt: 2,
        quantity: 1,
      })),
    };
    expect(parseShortMessage(shortMessage(many))?.loans).toHaveLength(
      SHORT_DETAIL_LOANS_MAX,
    );
  });

  it("returns null for anything else", () => {
    expect(parseShortMessage("EQUIPMENT_CONFLICT")).toBeNull();
    expect(parseShortMessage("EQUIPMENT_SHORT:{not json")).toBeNull();
    expect(parseShortMessage('EQUIPMENT_SHORT:{"a":1}')).toBeNull();
  });
});

describe("return photo paths", () => {
  it("builds the folder and upload path from the loan id, lower-cased", () => {
    expect(equipmentPhotoFolder(ID.toUpperCase())).toBe(
      `equipment-return/${ID}/`,
    );
    expect(equipmentPhotoUploadPath(ID, "webp")).toBe(
      `equipment-return/${ID}/photo.webp`,
    );
  });

  it("parses only exact return-photo pathnames", () => {
    expect(
      parseEquipmentPhotoPath(`equipment-return/${ID}/photo-x1.png`),
    ).toMatchObject({ loanID: ID, ext: "png", contentType: "image/png" });
    for (const bad of [
      `equipment-return/${ID}/photo.svg`,
      `equipment-return/${ID}/../x/photo.webp`,
      `equipment-return/${ID}/a/b.webp`,
      `milestone-evidence/9803/evidence.webp`,
      `equipment-return/short/photo.webp`,
      `/equipment-return/${ID}/photo.webp`,
    ]) {
      expect([bad, parseEquipmentPhotoPath(bad)]).toEqual([bad, null]);
    }
  });

  it("takes only an exact https address in this store", () => {
    const good = `https://${HOST}/equipment-return/${ID}/photo-ab12cd.webp`;
    expect(equipmentPhotoPathFromUrl(good, HOST)).toBe(
      `equipment-return/${ID}/photo-ab12cd.webp`,
    );
    for (const bad of [
      good.replace("https", "http"),
      `${good}?x=1`,
      `${good}#x`,
      `https://other.example/equipment-return/${ID}/photo-ab12cd.webp`,
      `https://u:p@${HOST}/equipment-return/${ID}/photo-ab12cd.webp`,
      `https://${HOST}:8443/equipment-return/${ID}/photo-ab12cd.webp`,
      `https://${HOST}/equipment-return/${ID}/photo%2Dab.webp`,
      `https://${HOST}/equipment-return/${ID}/photo ab.webp`,
      `https://${HOST}/equipment-return/${ID}/../${ID}/photo.webp`,
      "not a url",
      `https://${HOST}/${"a".repeat(3000)}`,
    ]) {
      expect([bad, equipmentPhotoPathFromUrl(bad, HOST)]).toEqual([bad, null]);
    }
  });
});

describe("schemas", () => {
  const base = {
    eventID: 5,
    lines: [{ itemID: ID, quantity: 1 }],
    collectAt: 1000,
    returnAt: 2000,
  };

  it("requires both times and a return after the collection", () => {
    expect(loanCreateInput.safeParse(base).success).toBe(true);
    expect(
      loanCreateInput.safeParse({ ...base, returnAt: undefined }).success,
    ).toBe(false);
    expect(
      loanCreateInput.safeParse({ ...base, collectAt: undefined }).success,
    ).toBe(false);
    expect(loanCreateInput.safeParse({ ...base, returnAt: 1000 }).success).toBe(
      false,
    );
    expect(loanCreateInput.safeParse({ ...base, returnAt: 5 }).success).toBe(
      false,
    );
  });

  it("has no CCA field, and drops one sent by the browser", () => {
    const parsed = loanCreateInput.parse({ ...base, ccaID: 7 });
    expect(parsed).not.toHaveProperty("ccaID");
  });

  it("refuses empty, repeated and non-positive lines", () => {
    expect(loanCreateInput.safeParse({ ...base, lines: [] }).success).toBe(
      false,
    );
    expect(
      loanCreateInput.safeParse({
        ...base,
        lines: [
          { itemID: ID, quantity: 1 },
          { itemID: ID.toUpperCase(), quantity: 2 },
        ],
      }).success,
    ).toBe(false);
    expect(
      loanCreateInput.safeParse({
        ...base,
        lines: [{ itemID: ID, quantity: 0 }],
      }).success,
    ).toBe(false);
  });

  it("needs a reason to reject, and defaults the list filters", () => {
    expect(
      loanRejectInput.safeParse({ id: ID, version: 0, reason: "  " }).success,
    ).toBe(false);
    expect(
      loanRejectInput.parse({ id: ID, version: 0, reason: " No " }).reason,
    ).toBe("No");
    expect(loanListInput.parse({})).toEqual({
      status: null,
      cca: null,
      overdueOnly: false,
    });
  });
});

describe("the director note after a return", () => {
  it("needs a version and a note of 1 to 500 characters, cleaned", () => {
    expect(
      loanNoteInput.safeParse({ id: ID, version: 3, directorNote: "  Bent  " }),
    ).toMatchObject({ success: true, data: { directorNote: "Bent" } });
    for (const bad of ["", "   ", "x".repeat(DIRECTOR_NOTE_MAX + 1)]) {
      expect(
        loanNoteInput.safeParse({ id: ID, version: 3, directorNote: bad })
          .success,
      ).toBe(false);
    }
    expect(
      loanNoteInput.safeParse({ id: ID, directorNote: "Hi" }).success,
    ).toBe(false);
    expect(
      loanNoteInput.safeParse({
        id: ID,
        version: 0,
        directorNote: "x".repeat(DIRECTOR_NOTE_MAX),
      }).success,
    ).toBe(true);
  });
});

describe("equipmentErrorMessage", () => {
  it("explains the new refusals", () => {
    expect(equipmentErrorMessage("EQUIPMENT_WINDOW_TOO_LONG")).toMatch(
      /60 days/,
    );
    expect(equipmentErrorMessage("EQUIPMENT_NOT_RETURNED")).toMatch(/returned/);
    expect(equipmentErrorMessage("EQUIPMENT_EVENT_CLOSED")).toMatch(
      /collected/,
    );
  });

  it("names the item for a stock refusal", () => {
    const msg = shortMessage({
      itemID: ID,
      name: "Tent",
      owned: 4,
      wanted: 2,
      heldAtPeak: 3,
      at: 1,
      loans: [],
    });
    expect(equipmentErrorMessage(msg)).toBe(
      "Not enough Tent: 4 owned, 3 already held, 2 wanted.",
    );
  });

  it("maps known codes, the rate limit, and falls back safely", () => {
    expect(equipmentErrorMessage("NOT_SOCIAL_DIRECTOR")).toMatch(
      /Social director/,
    );
    expect(equipmentErrorMessage("RATE_LIMITED:30")).toMatch(/try again later/);
    expect(equipmentErrorMessage("mongodb://secret")).toBe(
      "Something went wrong. Try again shortly.",
    );
  });
});
