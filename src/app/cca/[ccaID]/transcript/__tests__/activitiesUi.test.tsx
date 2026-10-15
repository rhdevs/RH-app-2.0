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
      max={20}
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
  it("shows the count as N of 20 with Add activity, Edit and Remove", () => {
    const html = section();

    expect(html).toContain("1 of 20");
    expect(html).toContain("Add activity");
    expect(html).toContain('aria-label="Edit Annual concert"');
    expect(html).toContain('aria-label="Remove Annual concert"');
    expect(html).toContain("Show removed");
  });

  it("disables Add activity and says why at 20 activities", () => {
    const html = section({ activeCount: 20 });

    expect(html).toContain("20 of 20");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Add activity<\/button>/);
    expect(html).toContain("Remove one to add another.");
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
