import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { toggleMany, EMPTY_SELECTION } from "~/lib/transcript/awards";
import {
  AssignAwardView,
  NEW_AWARD,
  canAssign,
  type AssignAwardViewProps,
} from "../awards/_components/AssignAward";
import {
  AwardCatalogueView,
  type AwardCatalogueViewProps,
  type CatalogueItem,
} from "../awards/_components/AwardCatalogue";
import {
  AwardHistoryView,
  type AwardHistoryViewProps,
  type BatchItem,
} from "../awards/_components/AwardHistory";
import {
  AwardsListView,
  type AwardItem,
  type AwardsListViewProps,
} from "../awards/_components/AwardsList";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

/* ---- the awards list ------------------------------------------------------ */

const award = (over: Partial<AwardItem> = {}): AwardItem => ({
  id: "a1",
  userID: "SEED-R04",
  displayName: "Seed Resident 04",
  title: "Full Colours",
  citation: "For leading the team.",
  awardTypeID: "t1",
  removed: false,
  recordedByName: "Seed Resident 02",
  recordedAt: "2026-10-01T00:00:00.000Z",
  updatedByName: null,
  removedByName: null,
  removedAt: null,
  ...over,
});

const list = (over: Partial<AwardsListViewProps> = {}) =>
  renderToStaticMarkup(
    <AwardsListView
      items={[
        award(),
        award({
          id: "a2",
          userID: "SEED-R12",
          displayName: "Seed Resident 12",
        }),
        award({
          id: "a3",
          title: "Best Newcomer",
          awardTypeID: "t2",
          citation: "",
        }),
      ]}
      loading={false}
      loadError={null}
      groupBy
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
      {...over}
    />,
  );

describe("awards list", () => {
  it("groups by award with a count, collapsed until opened", () => {
    const html = list();

    expect(html).toContain("Full Colours: 2 residents");
    expect(html).toContain("Best Newcomer: 1 resident");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Seed Resident 04");
  });

  it("shows the people and their citations in an open group", () => {
    const html = list({ expanded: new Set(["t1"]) });

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Seed Resident 04");
    expect(html).toContain("For leading the team.");
    expect(html).toContain('aria-label="Edit Seed Resident 04, Full Colours"');
    expect(html).toContain(
      'aria-label="Remove Seed Resident 04, Full Colours"',
    );
  });

  it("is a flat list when grouping is off, naming the award on each row", () => {
    const html = list({ groupBy: false });

    expect(html).not.toContain("Full Colours: 2 residents");
    expect(html).toContain("Seed Resident 04");
    expect(html).toContain("Best Newcomer");
  });

  it("opens every group while a search is typed", () => {
    expect(list({ search: "colours" })).toContain("Seed Resident 12");
  });

  it("shows removed awards struck through with Restore, and who removed them", () => {
    const html = list({
      groupBy: false,
      showRemoved: true,
      items: [
        award({
          removed: true,
          removedByName: "Seed Resident 01",
          removedAt: "2026-10-05T00:00:00.000Z",
        }),
      ],
    });

    expect(html).toContain("line-through");
    expect(html).toContain(
      'aria-label="Restore Seed Resident 04, Full Colours"',
    );
    expect(html).not.toContain('aria-label="Edit Seed Resident 04');
    expect(html).toContain("Removed by Seed Resident 01 on");
  });

  it("offers selection with Remove selected and Restore selected", () => {
    const items = [award(), award({ id: "a2", removed: true })];
    const selection = toggleMany(EMPTY_SELECTION, ["a1", "a2"]);
    const html = list({ groupBy: false, items, selection });

    expect(html).toContain("2 selected");
    expect(html).toContain("Remove selected");
    expect(html).toContain("Restore selected");
    expect(html).toContain('aria-label="Selected awards"');
    expect(list({ groupBy: false })).not.toContain("Remove selected");
  });

  it("disables a bulk action that has nothing to act on", () => {
    const html = list({
      groupBy: false,
      items: [award()],
      selection: new Set(["a1"]),
    });
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Restore selected<\/button>/,
    );
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Remove selected<\/button>/,
    );
  });

  it("edits title and citation inline, with counters", () => {
    const html = list({
      groupBy: false,
      editing: { id: "a1", title: "Full Colours", citation: "x" },
    });

    expect(html).toContain('id="edit-title-a1"');
    expect(html).toContain('id="edit-citation-a1"');
    expect(html).toContain("68 characters left");
    expect(html).toContain("299 characters left");
    expect(html).toContain(">Save<");
  });

  it("is read-only: no selection boxes, edit, remove or bulk actions", () => {
    const html = list({ groupBy: false, readOnly: true });

    expect(html).not.toContain('type="checkbox" class="mt-1');
    expect(html).not.toContain(">Edit<");
    expect(html).not.toContain(">Remove<");
    expect(html).toContain("Seed Resident 04");
  });

  it("says when nothing matches, and shows errors and notices", () => {
    expect(list({ items: [], search: "zzz" })).toContain(
      "No awards match that search.",
    );
    expect(list({ items: [] })).toContain("No awards for this year yet.");
    expect(list({ actionError: "Nope." })).toContain('role="alert"');
    expect(list({ notice: "1 restored." })).toContain("1 restored.");
  });
});

/* ---- assigning ---------------------------------------------------------------- */

const assign = (
  over: Partial<AssignAwardViewProps> = {},
): AssignAwardViewProps => ({
  types: [
    { id: "t1", name: "Full Colours", defaultCitation: "For service." },
    { id: "t2", name: "Best Newcomer", defaultCitation: "" },
  ],
  choice: "t1",
  onChoice: noop,
  newName: "",
  onNewName: noop,
  newCitation: "",
  onNewCitation: noop,
  recipients: [
    { userID: "SEED-R12", displayName: "Seed Resident 12", citation: "" },
  ],
  onCitation: noop,
  onRemoveRecipient: noop,
  picker: <div data-testid="picker">picker</div>,
  readOnly: false,
  assigning: false,
  error: null,
  nameError: null,
  result: null,
  onAssign: noop,
  ...over,
});
const renderAssign = (over?: Partial<AssignAwardViewProps>) =>
  renderToStaticMarkup(<AssignAwardView {...assign(over)} />);

describe("assign an award", () => {
  it("picks a catalogue award or a new one, and adds residents as chips", () => {
    const html = renderAssign();

    expect(html).toContain("Choose an award");
    expect(html).toContain("Full Colours");
    expect(html).toContain("New award");
    expect(html).toContain('data-testid="picker"');
    expect(html).toContain("Seed Resident 12");
    expect(html).toContain('aria-label="Remove Seed Resident 12"');
    expect(html).toContain("1 selected (at most 300)");
  });

  it("prefills each person's citation hint with the award's default", () => {
    expect(renderAssign()).toContain('placeholder="For service."');
    expect(renderAssign({ choice: "t2" })).toContain(
      'placeholder="Citation (optional)"',
    );
  });

  it("asks for a name and default citation for a new award", () => {
    const html = renderAssign({
      choice: NEW_AWARD,
      newCitation: "Default one.",
    });
    expect(html).toContain('id="new-award-name"');
    expect(html).toContain('id="new-award-citation"');
    expect(html).toContain('placeholder="Default one."');
  });

  it("can be assigned only with an award and at least one person", () => {
    expect(canAssign(assign())).toBe(true);
    expect(canAssign(assign({ choice: "" }))).toBe(false);
    expect(canAssign(assign({ recipients: [] }))).toBe(false);
    expect(canAssign(assign({ choice: NEW_AWARD }))).toBe(false);
    expect(canAssign(assign({ choice: NEW_AWARD, newName: "Fresh" }))).toBe(
      true,
    );
    expect(canAssign(assign({ assigning: true }))).toBe(false);
    expect(canAssign(assign({ readOnly: true }))).toBe(false);
  });

  it("shows the result line and errors", () => {
    const html = renderAssign({
      result: "12 assigned. Skipped (already have it): A, B.",
      error: "Nope.",
      choice: NEW_AWARD,
      nameError: "An award with that name already exists.",
    });
    expect(html).toContain("12 assigned. Skipped (already have it): A, B.");
    expect(html).toContain("An award with that name already exists.");
    expect(html).toContain('role="alert"');
  });

  it("is read-only when the year is published: no picker, disabled Assign", () => {
    const html = renderAssign({ readOnly: true });
    expect(html).not.toContain('data-testid="picker"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Assign<\/button>/);
  });
});

/* ---- the catalogue ----------------------------------------------------------------- */

const entry = (over: Partial<CatalogueItem> = {}): CatalogueItem => ({
  id: "t1",
  name: "Full Colours",
  defaultCitation: "For service.",
  archived: false,
  archivedAt: null,
  archivedByName: null,
  updatedByName: null,
  awardCount: 14,
  ...over,
});
const catalogue = (over: Partial<AwardCatalogueViewProps> = {}) =>
  renderToStaticMarkup(
    <AwardCatalogueView
      items={[
        entry(),
        entry({
          id: "t2",
          name: "Old Award",
          archived: true,
          awardCount: 1,
          archivedAt: "2026-10-01T00:00:00.000Z",
          archivedByName: "Seed Resident 02",
        }),
      ]}
      loading={false}
      loadError={null}
      showArchived
      onShowArchived={noop}
      draft={{ name: "", defaultCitation: "" }}
      onDraft={noop}
      onAdd={noop}
      adding={false}
      addError={null}
      editing={null}
      onEdit={noop}
      onEditChange={noop}
      onSaveEdit={noop}
      savingEdit={false}
      editError={null}
      onArchive={noop}
      onRestore={noop}
      busy={false}
      actionError={null}
      {...over}
    />,
  );

describe("award catalogue", () => {
  it("lists awards with their default citation and how many were given", () => {
    const html = catalogue();
    expect(html).toContain("Full Colours");
    expect(html).toContain("For service.");
    expect(html).toContain("14 awards given");
    expect(html).toContain("1 award given");
    expect(html).toContain("Show archived");
  });

  it("archives a live entry and restores an archived one; never deletes", () => {
    const html = catalogue();
    expect(html).toContain('aria-label="Archive Full Colours"');
    expect(html).toContain('aria-label="Restore Old Award"');
    expect(html).toContain("Archived by Seed Resident 02 on");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain('aria-label="Edit Old Award"');
  });

  it("adds with a name and default citation, disabled until named", () => {
    const html = catalogue();
    expect(html).toContain('id="catalogue-name"');
    expect(html).toContain('id="catalogue-citation"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add award<\/button>/);
    expect(
      catalogue({ draft: { name: "New one", defaultCitation: "" } }),
    ).not.toMatch(/<button[^>]*disabled=""[^>]*>Add award<\/button>/);
  });

  it("explains that a rename leaves past awards alone", () => {
    const html = catalogue({
      editing: { id: "t1", name: "Full Colours", defaultCitation: "x" },
    });
    expect(html).toContain("Renaming does not change awards already given");
    expect(html).toContain('id="cat-name-t1"');
  });

  it("shows a name clash inline", () => {
    expect(
      catalogue({ addError: "An award with that name already exists." }),
    ).toContain("An award with that name already exists.");
  });
});

/* ---- history ------------------------------------------------------------------------- */

const batch = (over: Partial<BatchItem> = {}): BatchItem => ({
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
const history = (over: Partial<AwardHistoryViewProps> = {}) =>
  renderToStaticMarkup(
    <AwardHistoryView
      items={[
        batch(),
        batch({
          id: "b2",
          fileName: "old.csv",
          undone: true,
          undoneByName: "Seed Resident 01",
          undoneAt: "2026-10-11T00:00:00.000Z",
          activeCount: 0,
        }),
      ]}
      loading={false}
      loadError={null}
      readOnly={false}
      undoing={null}
      onUndoing={noop}
      onUndo={noop}
      busy={false}
      actionError={null}
      doneLine={null}
      {...over}
    />,
  );

describe("award upload history", () => {
  it("lists each upload with who, when, imported and skipped counts", () => {
    const html = history();
    expect(html).toContain("awards.csv");
    expect(html).toContain("Seed Resident 02, 10 Oct 2026");
    expect(html).toContain(">10<");
    expect(html).toContain(">2<");
    expect(html).toContain("10 active");
  });

  it("offers Undo only while the upload is not undone", () => {
    const html = history();
    expect(html).toContain('aria-label="Undo awards.csv"');
    expect(html).not.toContain('aria-label="Undo old.csv"');
    expect(html).toContain("Undone by Seed Resident 01 on 11 Oct 2026");
  });

  it("is read-only in a published year: no Undo", () => {
    expect(history({ readOnly: true })).not.toContain("Undo awards.csv");
  });

  it("says when there are no uploads, and shows what an undo did", () => {
    expect(history({ items: [] })).toContain("No uploads for this year yet.");
    expect(history({ doneLine: "10 awards removed." })).toContain(
      "10 awards removed.",
    );
  });
});
