import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  emptyEditor,
  selectAll,
  addPerson,
  patchPerson,
} from "~/lib/transcript/activityEditor";
import {
  ActivityEditorView,
  type ActivityEditorViewProps,
} from "../_components/ActivityEditor";
import {
  ActivitiesSectionView,
  type ActivitiesSectionViewProps,
  type ActivityListItem,
} from "../_components/ActivitiesSection";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const item = (over: Partial<ActivityListItem> = {}): ActivityListItem => ({
  id: "0123456789abcdef01234567",
  title: "Annual concert",
  description: "The yearly concert.",
  period: "full",
  participants: [],
  removed: false,
  removedByName: null,
  removedAt: null,
  ...over,
});

const section = (over: Partial<ActivitiesSectionViewProps> = {}) =>
  renderToStaticMarkup(
    <ActivitiesSectionView
      academicYear="AY2026/27"
      activeCount={1}
      items={[item()]}
      showRemoved={false}
      onShowRemoved={noop}
      readOnlyNote={null}
      readOnly={false}
      loadError={null}
      actionError={null}
      removing={null}
      onRemoving={noop}
      onRemove={noop}
      onRestore={noop}
      onAdd={noop}
      onEdit={noop}
      busy={false}
      {...over}
    />,
  );

const disabledButtons = (html: string) =>
  (html.match(/<button\b[^>]*>/g) ?? []).filter((t) => /\sdisabled=""/.test(t));

describe("activities section", () => {
  it("shows a plain count with Add activity, Edit and Remove", () => {
    const html = section();

    expect(html).toContain("1 activity");
    expect(html).not.toMatch(/\d+ of \d+/);
    expect(html).toContain("Add activity");
    expect(html).toContain('aria-label="Edit Annual concert"');
    expect(html).toContain('aria-label="Remove Annual concert"');
    expect(html).toContain("Show removed");
  });

  it("never disables Add activity or talks of a limit, however many there are", () => {
    for (const activeCount of [20, 25, 300]) {
      const html = section({ activeCount });

      expect(html).toContain(`${activeCount} activities`);
      expect(html).not.toMatch(
        /<button[^>]*disabled=""[^>]*>Add activity<\/button>/,
      );
      expect(html).not.toMatch(/limit|Remove one to add another|\d+ of \d+/i);
    }
  });

  it("shows a removed activity with Restore only, and who removed it", () => {
    const html = section({
      showRemoved: true,
      items: [
        item({
          removed: true,
          removedByName: "Seed Head",
          removedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    });

    expect(html).toContain('aria-label="Restore Annual concert"');
    expect(html).not.toContain('aria-label="Edit Annual concert"');
    expect(html).toContain("Removed by Seed Head on");
    expect(html).toContain("line-through");
  });

  it("is read-only with the reason and no actions when editing is refused", () => {
    const html = section({
      readOnly: true,
      readOnlyNote: "This member list is frozen. Ask the JCRC for changes.",
    });

    expect(html).toContain("This member list is frozen.");
    expect(html).not.toContain("Add activity");
    expect(html).not.toContain('aria-label="Edit Annual concert"');
    expect(html).not.toContain('aria-label="Remove Annual concert"');
    expect(html).toContain("Annual concert");
  });

  it("asks before removing and says it can be restored", () => {
    const html = section({
      removing: { id: "x", title: "Annual concert" },
    });

    // The dialog is portalled, so only the closed trigger-less markup is here;
    // the wording itself is a tested constant.
    expect(html).toContain("Annual concert");
    expect(disabledButtons(html)).toHaveLength(0);
  });

  it("shows an error from the last action inline", () => {
    const html = section({
      actionError: "This CCA already has 20 activities for the year.",
    });

    expect(html).toContain('role="alert"');
    expect(html).toContain("already has 20 activities");
  });

  it("says when there are none yet", () => {
    expect(section({ items: [], activeCount: 0 })).toContain(
      "No activities for AY2026/27 yet.",
    );
  });
});

const MEMBERS = [
  { userID: "a", displayName: "Alice Tan" },
  { userID: "b", displayName: "Bob Lim" },
];

const editor = (over: Partial<ActivityEditorViewProps> = {}) =>
  renderToStaticMarkup(
    <ActivityEditorView
      mode="add"
      state={emptyEditor()}
      onChange={noop}
      members={MEMBERS}
      filter=""
      onFilter={noop}
      customising={false}
      onCustomising={noop}
      picker={<div data-testid="picker">picker</div>}
      readOnly={false}
      saving={false}
      dirty={false}
      error={null}
      onSave={noop}
      onCancel={noop}
      {...over}
    />,
  );

describe("activity editor", () => {
  it("has the title, period, description with counters, and the member tick list", () => {
    const html = editor();

    expect(html).toContain("Title");
    expect(html).toContain("Semester 1");
    expect(html).toContain("80 characters left");
    expect(html).toContain("300 characters left");
    expect(html).toContain("Alice Tan");
    expect(html).toContain("Filter members by name");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear all");
    expect(html).toContain("0 people selected");
  });

  it("ticks the people selected and counts them", () => {
    const html = editor({ state: selectAll(emptyEditor(), MEMBERS) });

    expect(html).toContain("2 people selected");
    expect((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(
      2,
    );
  });

  it("shows only the members the filter matches", () => {
    const html = editor({ filter: "bob" });

    expect(html).toContain("Bob Lim");
    expect(html).not.toContain("Alice Tan");
  });

  it("lists people from outside the CCA as removable chips", () => {
    const html = editor({
      state: addPerson(emptyEditor(), { userID: "z", displayName: "Zed Ong" }),
    });

    expect(html).toContain("Zed Ong");
    expect(html).toContain('aria-label="Remove Zed Ong"');
    expect(html).toContain("picker");
  });

  it("opens Customise each person with the two placeholders", () => {
    const state = patchPerson(selectAll(emptyEditor(), MEMBERS), "a", {
      role: "Lead",
    });
    const closed = editor({ state });
    const open = editor({ state, customising: true });

    expect(closed).toContain("Customise each person");
    expect(closed).not.toContain("Leave empty if no role");
    expect(open).toContain('placeholder="Leave empty if no role"');
    expect(open).toContain(
      'placeholder="What they did; leave empty to use the general description"',
    );
    expect(open).toContain('value="Lead"');
  });

  it("disables Customise until someone is selected", () => {
    expect(editor()).toMatch(
      /<button[^>]*disabled=""[^>]*>Customise each person<\/button>/,
    );
  });

  it("enables Save only when something changed and the form is valid", () => {
    const filled = {
      ...emptyEditor(),
      activity: { title: "Concert", description: "", period: "full" as const },
    };

    expect(editor({ state: filled, dirty: false })).toMatch(
      /<button[^>]*disabled=""[^>]*>Add activity<\/button>/,
    );
    expect(editor({ state: filled, dirty: true })).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Add activity<\/button>/,
    );
    expect(editor({ state: emptyEditor(), dirty: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Add activity<\/button>/,
    );
  });

  it("is read-only: fields disabled, no Save, no picker", () => {
    const html = editor({
      readOnly: true,
      state: selectAll(emptyEditor(), MEMBERS),
    });

    expect(html).not.toContain(">Add activity<");
    expect(html).toContain(">Close<");
    expect(html).not.toContain('data-testid="picker"');
    expect(html).toMatch(/<input[^>]*id="activity-title"[^>]*disabled=""/);
  });

  it("shows a save error inline and says Save activity when editing", () => {
    const html = editor({
      mode: "edit",
      error: "The member list changed. Reload and try again.",
    });

    expect(html).toContain("Save activity");
    expect(html).toContain('role="alert"');
  });
});

/* ---- roster: cards, Save all bar ---------------------------------------- */

import {
  RosterCardView,
  RosterTableView,
  SaveAllBar,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";
import { draftOf } from "~/lib/transcript/headView";

const rosterRow = (over: Partial<RosterRowData> = {}): RosterRowData => ({
  userID: "SEED-R12",
  displayName: "Seed Twelve",
  isHead: false,
  defaultDuration: "full",
  duration: null,
  defaultRoleLabel: null,
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
  ...over,
});

const cardProps = (
  over: Partial<RosterRowViewProps> = {},
  row: RosterRowData = rosterRow(),
): RosterRowViewProps => ({
  row,
  draft: draftOf(row),
  onDraft: noop,
  onSave: noop,
  saving: false,
  saved: false,
  error: null,
  readOnly: false,
  ...over,
});

describe("roster cards (below the md breakpoint)", () => {
  it("shows the same fields as the table row, with ids that never clash", () => {
    const html = renderToStaticMarkup(
      <ul>
        <RosterCardView {...cardProps()} />
      </ul>,
    );

    expect(html).toContain("Seed Twelve");
    expect(html).toContain('id="duration-m-SEED-R12"');
    expect(html).toContain('id="role-m-SEED-R12"');
    expect(html).toContain('id="extra-m-SEED-R12"');
    expect(html).toContain(">Full year<");
    expect(html).not.toContain("Default (");
    expect(html).toContain("500 characters left");
    expect(html).not.toContain('id="duration-SEED-R12"');
  });

  it("shows the role period only when there is a role", () => {
    const plain = renderToStaticMarkup(
      <ul>
        <RosterCardView {...cardProps()} />
      </ul>,
    );
    const head = renderToStaticMarkup(
      <ul>
        <RosterCardView
          {...cardProps(
            {},
            rosterRow({ isHead: true, defaultRoleLabel: "Head" }),
          )}
        />
      </ul>,
    );

    expect(plain).not.toContain("roleDuration-m-");
    expect(head).toContain("roleDuration-m-");
  });

  it("keeps Save on the card, disabled until something changed", () => {
    const row = rosterRow();
    const html = renderToStaticMarkup(
      <ul>
        <RosterCardView {...cardProps({}, row)} />
      </ul>,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);

    const dirty = renderToStaticMarkup(
      <ul>
        <RosterCardView
          {...cardProps({ draft: { ...draftOf(row), roleLabel: "Head" } }, row)}
        />
      </ul>,
    );
    expect(dirty).not.toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/);
  });

  it("is read-only without Save", () => {
    const html = renderToStaticMarkup(
      <ul>
        <RosterCardView {...cardProps({ readOnly: true })} />
      </ul>,
    );
    expect(html).not.toContain(">Save<");
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });

  it("shows cards on phones and the table from md up", () => {
    const html = renderToStaticMarkup(
      <RosterTableView
        count={1}
        rows={<tr />}
        cards={<li data-card="1">card</li>}
      />,
    );

    expect(html).toMatch(/<ul class="[^"]*md:hidden[^"]*"><li data-card="1">/);
    expect(html).toMatch(/<div class="[^"]*hidden[^"]*md:block[^"]*">/);
    expect(html).toContain("<table");
  });
});

describe("Save all bar", () => {
  const bar = (over: Partial<Parameters<typeof SaveAllBar>[0]> = {}) =>
    renderToStaticMarkup(
      <SaveAllBar
        count={2}
        busy={false}
        failureLine={null}
        onSaveAll={noop}
        onDiscard={noop}
        {...over}
      />,
    );

  it("says how many changes are unsaved, with Save all and Discard", () => {
    const html = bar();

    expect(html).toContain("2 unsaved changes");
    expect(html).toContain("Save all");
    expect(html).toContain("Discard");
    expect(html).toContain("sticky bottom-0");
  });

  it("uses the singular for one change", () => {
    expect(bar({ count: 1 })).toContain("1 unsaved change<");
  });

  it("is not there when nothing is unsaved", () => {
    expect(bar({ count: 0 })).toBe("");
  });

  it("disables both buttons while saving", () => {
    const html = bar({ busy: true });
    expect(disabledButtons(html)).toHaveLength(2);
    expect(html).toContain("Saving");
  });

  it("lists how many rows failed, as an alert", () => {
    const html = bar({
      count: 1,
      failureLine: "1 row could not be saved. See the message on each.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("1 row could not be saved");
  });
});
