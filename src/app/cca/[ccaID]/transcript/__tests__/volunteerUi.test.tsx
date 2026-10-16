import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  emptyVolunteerDraft,
  selectAll,
  addPerson,
} from "~/lib/transcript/volunteerEditor";
import {
  cellKey,
  tickColumn,
  type Cells,
  type GridSession,
} from "~/lib/transcript/volunteerGrid";
import {
  AttendanceView,
  type AttendanceViewProps,
} from "../_components/VolunteerAttendance";
import {
  VolunteerEditorView,
  type VolunteerEditorViewProps,
} from "../_components/VolunteerEditor";
import {
  VolunteerSectionView,
  type VolunteerListItem,
  type VolunteerSectionViewProps,
} from "../_components/VolunteerSection";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null }),
}));

const noop = () => undefined;

/* ---- the list --------------------------------------------------------- */

const item = (over: Partial<VolunteerListItem> = {}): VolunteerListItem => ({
  id: "0123456789abcdef01234567",
  title: "Weekly tuition",
  kind: "regular",
  description: "Tuition for neighbourhood children.",
  peopleCount: 3,
  totalHours: 42.5,
  removed: false,
  removedByName: null,
  removedAt: null,
  ...over,
});

const section = (over: Partial<VolunteerSectionViewProps> = {}) =>
  renderToStaticMarkup(
    <VolunteerSectionView
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
      openID={null}
      onOpen={noop}
      panel={null}
      busy={false}
      {...over}
    />,
  );

describe("volunteer activity list", () => {
  it("shows a plain count, Add, and per activity the type, people and total hours", () => {
    const html = section();

    expect(html).toContain("Volunteer hours");
    expect(html).toContain("1 volunteer activity");
    expect(html).not.toMatch(/\d+ of \d+/);
    expect(html).toContain("Add volunteer activity");
    expect(html).toContain("Weekly tuition");
    expect(html).toContain("Regular");
    expect(html).toContain("3 people");
    expect(html).toContain("42.5 hours in total");
    expect(html).toContain('aria-label="Edit Weekly tuition"');
    expect(html).toContain('aria-label="Remove Weekly tuition"');
    expect(html).toContain("Show removed");
  });

  it("labels a one-off and uses the singular", () => {
    const html = section({
      items: [item({ kind: "oneoff", peopleCount: 1, totalHours: 1 })],
    });
    expect(html).toContain("One-off");
    expect(html).toContain("1 person");
    expect(html).toContain("1 hour in total");
  });

  it("never disables Add or talks of a limit, however many there are", () => {
    for (const activeCount of [30, 31, 120]) {
      const html = section({ activeCount });
      expect(html).toContain(`${activeCount} volunteer activities`);
      expect(html).not.toMatch(
        /<button[^>]*disabled=""[^>]*>Add volunteer activity<\/button>/,
      );
      expect(html).not.toMatch(/limit|Remove one to add another|\d+ of \d+/i);
    }
  });

  it("shows a removed activity with Restore only", () => {
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
    expect(html).toContain('aria-label="Restore Weekly tuition"');
    expect(html).not.toContain('aria-label="Edit Weekly tuition"');
    expect(html).not.toContain("Attendance");
    expect(html).toContain("Removed by Seed Head on");
  });

  it("is read-only with the reason: no add, edit or remove, but attendance can be viewed", () => {
    const html = section({
      readOnly: true,
      readOnlyNote: "This member list is frozen. Ask the JCRC for changes.",
    });
    expect(html).toContain("This member list is frozen.");
    expect(html).not.toContain("Add volunteer activity");
    expect(html).not.toContain('aria-label="Edit Weekly tuition"');
    expect(html).not.toContain('aria-label="Remove Weekly tuition"');
    expect(html).toContain("Attendance");
  });

  it("opens the attendance panel under the chosen activity only", () => {
    const html = section({
      openID: "0123456789abcdef01234567",
      panel: <div data-panel="1">grid</div>,
    });
    expect(html).toContain('data-panel="1"');
    expect(html).toContain("Hide attendance");
    expect(section()).not.toContain("data-panel");
  });

  it("shows an action error inline and an empty list kindly", () => {
    expect(section({ actionError: "Nope." })).toContain('role="alert"');
    expect(section({ items: [], activeCount: 0 })).toContain(
      "No volunteer activities for AY2026/27 yet.",
    );
  });
});

/* ---- the editor ----------------------------------------------------------- */

const MEMBERS = [
  { userID: "a", displayName: "Alice Tan" },
  { userID: "b", displayName: "Bob Lim" },
];

const editor = (over: Partial<VolunteerEditorViewProps> = {}) =>
  renderToStaticMarkup(
    <VolunteerEditorView
      mode="add"
      draft={emptyVolunteerDraft()}
      onChange={noop}
      members={MEMBERS}
      filter=""
      onFilter={noop}
      picker={<div data-testid="picker">picker</div>}
      kindLocked={false}
      readOnly={false}
      saving={false}
      dirty={false}
      error={null}
      onSave={noop}
      onCancel={noop}
      {...over}
    />,
  );

describe("volunteer activity editor", () => {
  it("has title, type, description, default hours and the member tick list", () => {
    const html = editor();
    expect(html).toContain("Title");
    expect(html).toContain("Regular");
    expect(html).toContain("One-off");
    expect(html).toContain("Default hours per session");
    expect(html).toContain("Alice Tan");
    expect(html).toContain("Filter members by name");
    expect(html).toContain("Select all");
    expect(html).toContain("Clear all");
    expect(html).toContain("Add someone outside the CCA");
    expect(html).toContain('data-testid="picker"');
    expect(html).toContain("0 people selected");
  });

  it("asks for a date and hours for a one-off, instead of default hours", () => {
    const html = editor({
      draft: { ...emptyVolunteerDraft(), kind: "oneoff" },
    });
    expect(html).toContain('id="vol-date"');
    expect(html).toContain('id="vol-hours"');
    expect(html).not.toContain("Default hours per session");
  });

  it("locks the type of an existing activity", () => {
    expect(editor({ kindLocked: true })).toMatch(
      /<select[^>]*id="vol-kind"[^>]*disabled=""|<select[^>]*disabled=""[^>]*id="vol-kind"/,
    );
  });

  it("ticks people and shows outsiders as removable chips", () => {
    const draft = addPerson(selectAll(emptyVolunteerDraft(), MEMBERS), {
      userID: "z",
      displayName: "Zed Ong",
    });
    const html = editor({ draft });
    expect(html).toContain("3 people selected");
    expect(html).toContain('aria-label="Remove Zed Ong"');
    expect((html.match(/type="checkbox"[^>]*checked=""/g) ?? []).length).toBe(
      2,
    );
  });

  it("filters the members by name", () => {
    const html = editor({ filter: "bob" });
    expect(html).toContain("Bob Lim");
    expect(html).not.toContain("Alice Tan");
  });

  it("saves only when changed and valid, and is read-only without Save", () => {
    const filled = { ...emptyVolunteerDraft(), title: "Tuition" };
    expect(editor({ draft: filled, dirty: false })).toMatch(
      /<button[^>]*disabled=""[^>]*>Add volunteer activity<\/button>/,
    );
    expect(editor({ draft: filled, dirty: true })).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Add volunteer activity<\/button>/,
    );
    const ro = editor({ readOnly: true });
    expect(ro).not.toContain(">Add volunteer activity<");
    expect(ro).toContain(">Close<");
  });
});

/* ---- the attendance grid ----------------------------------------------------- */

const sessions = (n: number): GridSession[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${String(i).padStart(3, "0")}`,
    date: new Date(Date.UTC(2026, 9, 1 + i * 7)).toISOString().slice(0, 10),
    hours: 1.5,
  }));

const PEOPLE = [
  { userID: "a", displayName: "Alice Tan" },
  { userID: "b", displayName: "Bob Lim" },
];

const attendance = (over: Partial<AttendanceViewProps> = {}) =>
  renderToStaticMarkup(
    <AttendanceView
      kind="regular"
      sessions={sessions(3)}
      people={PEOPLE}
      cells={{}}
      onCells={noop}
      readOnly={false}
      windowStart={null}
      onWindowStart={noop}
      phoneIndex={2}
      onPhoneIndex={noop}
      editingCell={null}
      onEditingCell={noop}
      onAddSession={noop}
      addingSession={false}
      onEditSession={noop}
      error={null}
      {...over}
    />,
  );

const desktop = (html: string) =>
  html.slice(
    html.indexOf('<div class="hidden md:block">'),
    html.indexOf('<div class="md:hidden">'),
  );
const phone = (html: string) =>
  html.slice(html.indexOf('<div class="md:hidden">'));

describe("attendance grid (desktop)", () => {
  it("has people as rows with a sticky name column, and sessions as columns", () => {
    const html = desktop(attendance());
    expect(html).toContain("sticky left-0");
    expect(html).toContain("Alice Tan");
    expect(html).toContain("Bob Lim");
    expect((html.match(/<th[^>]*scope="col"[^>]*>\s*<div/g) ?? []).length).toBe(
      3,
    );
    expect(html).toContain("1.5 h");
    expect(html).toContain(">Total<");
  });

  it("gives each column Tick all, Clear all and Copy previous (not on the first)", () => {
    const html = desktop(attendance());
    expect((html.match(/>Tick all</g) ?? []).length).toBe(3);
    expect((html.match(/>Clear all</g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((html.match(/>Copy previous</g) ?? []).length).toBe(2);
  });

  it("gives each person Tick all sessions and Clear all", () => {
    const html = desktop(attendance());
    expect((html.match(/>Tick all sessions</g) ?? []).length).toBe(2);
  });

  it("draws only the 8 most recent of 20 sessions, with paging", () => {
    const html = desktop(attendance({ sessions: sessions(20) }));
    expect((html.match(/<th[^>]*scope="col"[^>]*>\s*<div/g) ?? []).length).toBe(
      8,
    );
    expect(html).toContain("Sessions 13 to 20 of 20");
    expect(html).toContain("Earlier sessions");
    expect(html).toContain("Later sessions");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Later sessions<\/button>/,
    );
    expect(html).not.toMatch(
      /<button[^>]*disabled=""[^>]*>Earlier sessions<\/button>/,
    );
  });

  it("starts the window where asked", () => {
    const html = desktop(
      attendance({ sessions: sessions(20), windowStart: 0 }),
    );
    expect(html).toContain("Sessions 1 to 8 of 20");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Earlier sessions<\/button>/,
    );
  });

  it("marks ticked cells, shows an override as a number and live totals", () => {
    const list = sessions(3);
    let cells: Cells = tickColumn({}, list[0]!.id, ["a", "b"]);
    cells = tickColumn(cells, list[1]!.id, ["a"]);
    cells = { ...cells, [cellKey(list[0]!.id, "b")]: 0.5 };
    const html = desktop(attendance({ sessions: list, cells }));

    expect((html.match(/aria-checked="true"/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-label="Alice Tan, 1 Oct"');
    expect(html).toContain(">0.5<");
    // Alice: two sessions of 1.5 hours; Bob: one 0.5-hour override.
    expect(html).toMatch(/>3<\/td>/);
    expect(html).toMatch(/>0.5<\/td>/);
  });

  it("offers a per-cell hours action only for ticked cells", () => {
    const list = sessions(1);
    const none = desktop(attendance({ sessions: list }));
    expect(none).not.toContain("Set hours for");
    const some = desktop(
      attendance({ sessions: list, cells: tickColumn({}, list[0]!.id, ["a"]) }),
    );
    expect(some).toContain('aria-label="Set hours for Alice Tan, 1 Oct"');
    expect(some).not.toContain('aria-label="Set hours for Bob Lim, 1 Oct"');
  });

  it("has Add session, and none for a one-off", () => {
    expect(attendance()).toContain("Add session");
    const oneoff = attendance({ kind: "oneoff", sessions: sessions(1) });
    expect(oneoff).not.toContain("Add session");
    expect(oneoff).not.toContain("Earlier sessions");
    expect(oneoff).not.toContain("Tick all sessions");
  });

  it("is read-only: no buttons that change anything", () => {
    const html = desktop(attendance({ readOnly: true }));
    expect(html).not.toContain(">Tick all<");
    expect(html).not.toContain(">Copy previous<");
    expect(attendance({ readOnly: true })).not.toContain("Add session");
    expect(html).toMatch(/role="checkbox"[^>]*disabled=""/);
  });

  it("says what to do when there are no sessions or no people", () => {
    expect(attendance({ sessions: [] })).toContain("No sessions yet");
    expect(attendance({ people: [] })).toContain("No people yet");
  });
});

describe("attendance (phone)", () => {
  it("shows one session at a time with a date selector and arrows", () => {
    const html = phone(attendance({ sessions: sessions(5), phoneIndex: 4 }));
    expect(html).toContain('aria-label="Previous session"');
    expect(html).toContain('aria-label="Next session"');
    expect(html).toContain('id="phone-session"');
    expect((html.match(/<option/g) ?? []).length).toBe(5);
    // The Next arrow is disabled on the last session.
    expect(
      html.slice(html.indexOf('aria-label="Next session"')).slice(0, 60),
    ).toContain('disabled=""');
    // The whole list of people is drawn once, for that session.
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });

  it("has Tick all, Clear all and Copy previous session", () => {
    const html = phone(attendance({ phoneIndex: 1 }));
    expect(html).toContain(">Tick all<");
    expect(html).toContain(">Clear all<");
    expect(html).toContain(">Copy previous session<");
    expect(phone(attendance({ phoneIndex: 0 }))).not.toContain(
      "Copy previous session",
    );
  });

  it("shows an hours input only for ticked people, and each person's total", () => {
    const list = sessions(2);
    const cells = tickColumn({}, list[1]!.id, ["a"]);
    const html = phone(attendance({ sessions: list, cells, phoneIndex: 1 }));
    expect(html).toContain("Hours for Alice Tan");
    expect(html).not.toContain("Hours for Bob Lim");
    expect(html).toContain("Total 1.5");
    expect(html).toContain("Total 0");
  });

  it("shows no session picker for a one-off", () => {
    const html = phone(
      attendance({ kind: "oneoff", sessions: sessions(1), phoneIndex: 0 }),
    );
    expect(html).not.toContain('id="phone-session"');
    expect(html).not.toContain("Previous session");
  });
});

/* keep the helper imported for the type check above */
export type _GridSession = GridSession;
