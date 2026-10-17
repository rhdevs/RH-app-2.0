import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { errorText } from "~/lib/transcript/adminView";
import { latestOnly } from "~/lib/transcript/awardImport";
import {
  EMPTY_SELECTION,
  SELF_RECORDED_TAG,
  awardActiveKey,
  batchStatusLabel,
  removedAwardKey,
} from "~/lib/transcript/awards";
import { SELF_MADE_TAG } from "~/lib/transcript/residentView";
import {
  AwardHistoryView,
  type BatchItem,
} from "../awards/_components/AwardHistory";
import {
  AwardsListView,
  type AwardItem,
} from "../awards/_components/AwardsList";
import { HistoryView } from "../residents/_components/HistoryTab";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

describe("the unique key of an active award (F20)", () => {
  it("is year, person and catalogue entry", () => {
    expect(
      awardActiveKey({
        academicYear: "AY2026/27",
        userID: "SEED-R04",
        awardTypeID: "t1",
        title: "Full Colours",
      }),
    ).toBe("AY2026/27|SEED-R04|t1");
  });

  it("uses the normalised title when there is no catalogue entry", () => {
    const key = (title: string) =>
      awardActiveKey({
        academicYear: "AY2026/27",
        userID: "SEED-R04",
        awardTypeID: null,
        title,
      });
    expect(key("  full   COLOURS ")).toBe(
      "AY2026/27|SEED-R04|title:full colours",
    );
    expect(key("Full Colours")).toBe(key("full colours"));
  });

  it("gives a removed award its own key, which frees the active one", () => {
    expect(removedAwardKey("AY2026/27|SEED-R04|t1", "abc")).toBe(
      "AY2026/27|SEED-R04|t1|removed|abc",
    );
  });

  it("says in words that a restore found the person already has it", () => {
    expect(errorText("ALREADY_HAS_AWARD")).toMatch(/already has this award/);
  });
});

describe("upload status labels (F16)", () => {
  it("reads Importing, Partly imported and Imported", () => {
    expect(batchStatusLabel("importing")).toBe("Importing");
    expect(batchStatusLabel("partial")).toBe("Partly imported");
    expect(batchStatusLabel("complete")).toBe("Imported");
    expect(batchStatusLabel(undefined)).toBe("Imported");
  });

  const batch = (over: Partial<BatchItem>): BatchItem => ({
    id: "b1",
    fileName: "awards.csv",
    rowCount: 12,
    importedCount: 10,
    skippedCount: 2,
    createdByName: "Seed Resident 02",
    createdAt: "2026-10-10T00:00:00.000Z",
    undone: false,
    undoneAt: null,
    undoneByName: null,
    activeCount: 10,
    ...over,
  });
  const history = (items: BatchItem[]) =>
    renderToStaticMarkup(
      <AwardHistoryView
        items={items}
        loading={false}
        loadError={null}
        readOnly={false}
        undoing={null}
        onUndoing={noop}
        onUndo={noop}
        busy={false}
        actionError={null}
        doneLine={null}
      />,
    );

  it("shows each status in History, with Undo for all three", () => {
    const html = history([
      batch({ id: "a", status: "importing" }),
      batch({ id: "b", status: "partial" }),
      batch({ id: "c", status: "complete" }),
    ]);
    expect(html).toContain("Importing, 10 active");
    expect(html).toContain("Partly imported, 10 active");
    expect(html).toContain("Imported, 10 active");
    expect(html.match(/>Undo</g)).toHaveLength(3);
  });

  it("tags an upload whose uploader is one of its recipients (F25a)", () => {
    const html = history([batch({ selfRecorded: true })]);
    expect(html).toContain(SELF_RECORDED_TAG);
    expect(history([batch({})])).not.toContain(SELF_RECORDED_TAG);
  });
});

describe("self-recorded awards and self-made changes (F25a)", () => {
  const award = (over: Partial<AwardItem>): AwardItem => ({
    id: "a1",
    userID: "SEED-R04",
    displayName: "Seed Resident 04",
    title: "Full Colours",
    citation: "",
    awardTypeID: "t1",
    removed: false,
    recordedByName: "Seed Resident 04",
    recordedAt: "2026-10-01T00:00:00.000Z",
    updatedByName: null,
    removedByName: null,
    removedAt: null,
    ...over,
  });

  it("tags the manager's own award in the list, and no one else's", () => {
    const html = renderToStaticMarkup(
      <AwardsListView
        items={[
          award({ id: "a1", selfRecorded: true }),
          award({ id: "a2", userID: "SEED-R05", selfRecorded: false }),
        ]}
        loading={false}
        loadError={null}
        groupBy={false}
        onGroupBy={noop}
        showRemoved={false}
        onShowRemoved={noop}
        search=""
        onSearch={noop}
        readOnly={false}
        selection={EMPTY_SELECTION}
        onToggle={noop}
        onToggleMany={noop}
        expanded={new Set()}
        onExpand={noop}
        editing={null}
        onEdit={noop}
        onEditChange={noop}
        onSaveEdit={noop}
        savingEdit={false}
        editError={null}
        titleError={null}
        onRemove={noop}
        onRestore={noop}
        confirm={null}
        onConfirm={noop}
        onConfirmed={noop}
        busy={false}
        actionError={null}
        notice={null}
      />,
    );
    expect(html.split(SELF_RECORDED_TAG).length - 1).toBe(1);
  });

  it("marks a resident history line the resident made themself", () => {
    const html = renderToStaticMarkup(
      <HistoryView
        items={[
          {
            id: "e1",
            action: "correction",
            reason: null,
            summary: "Awards: Full Colours assigned",
            byName: "Seed Resident 02",
            selfMade: true,
            at: "2026-10-16T04:00:00.000Z",
          },
          {
            id: "e2",
            action: "unlock",
            reason: "Wrong role",
            summary: null,
            byName: "Seed Resident 01",
            selfMade: false,
            at: "2026-10-16T03:00:00.000Z",
          },
        ]}
      />,
    );
    expect(SELF_MADE_TAG).toBe("Self-made change");
    expect(html.split(SELF_MADE_TAG).length - 1).toBe(1);
  });
});

describe("picking a second file (F25)", () => {
  it("ignores the read of an earlier pick once a newer one was made", () => {
    const picks = latestOnly();
    const first = picks.start();
    const second = picks.start();
    expect(picks.isCurrent(first)).toBe(false);
    expect(picks.isCurrent(second)).toBe(true);
  });

  it("the import tab reads a file in try/catch with the plain error", () => {
    const source = readFileSync(
      "src/app/admin/transcripts/awards/_components/AwardImport.tsx",
      "utf8",
    );
    expect(source).toContain("This file could not be read.");
    expect(source).toContain("picks.current.isCurrent(token)");
    expect(source).not.toMatch(/void file\.text\(\)\.then/);
  });
});

describe("changing the year discards unsaved awards work (F6)", () => {
  const source = readFileSync(
    "src/app/admin/transcripts/awards/_components/AwardsAdmin.tsx",
    "utf8",
  );

  it("keys the assign form, the list and the import by year, so a confirmed change remounts them", () => {
    for (const name of ["AssignAward", "AwardsList", "AwardImport"]) {
      expect(source).toMatch(new RegExp(`<${name}\\s+key=\\{year\\}`));
    }
  });

  it("does not wipe the dirty map itself: each part clears its own flag on unmount", () => {
    expect(source).not.toContain("setDirty({})");
    for (const name of [
      "AssignAward",
      "AwardsList",
      "AwardCatalogue",
      "AwardImport",
    ]) {
      const part = readFileSync(
        `src/app/admin/transcripts/awards/_components/${name}.tsx`,
        "utf8",
      );
      expect(part, name).toContain("onDirtyRef.current(false)");
    }
  });
});
