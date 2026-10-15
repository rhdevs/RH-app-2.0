import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RosterRowView,
  RosterTableView,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";
import { TranscriptNotes } from "../_components/TranscriptTab";
import {
  VolunteerSectionView,
  type VolunteerSectionViewProps,
} from "../_components/VolunteerSection";
import { draftOf } from "~/lib/transcript/headView";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const member = (over: Partial<RosterRowData> = {}): RosterRowData => ({
  userID: "SEED-R12",
  displayName: "Seed Twelve",
  isHead: false,
  defaultDuration: "full",
  duration: null,
  defaultRoleLabel: null,
  roleLabel: null,
  defaultRoleDuration: null,
  roleDuration: null,
  extraContribution: null,
  ...over,
});

const rowProps = (
  over: Partial<RosterRowViewProps> = {},
  row: RosterRowData = member(),
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

const renderRow = (
  over: Partial<RosterRowViewProps> = {},
  row: RosterRowData = member(),
) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <RosterRowView {...rowProps(over, row)} />
      </tbody>
    </table>,
  );

/** Opening tags that really carry the attribute (not a Tailwind `disabled:` class). */
const disabledTags = (html: string, tag: string) =>
  (html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? []).filter((t) =>
    /\sdisabled=""/.test(t),
  );

/* ---- roster editor ------------------------------------------------------ */

describe("roster row", () => {
  it("shows the name, the computed default and the blank-role placeholder", () => {
    const html = renderRow({}, member({ defaultDuration: "sem2" }));

    expect(html).toContain("Seed Twelve");
    expect(html).toContain("Default (Semester 2 only)");
    expect(html).toContain("Leave blank for member");
  });

  it("hides the role period until a role is typed", () => {
    expect(renderRow()).not.toContain("Role period for");

    const typed = member({ roleLabel: "Treasurer" });
    expect(renderRow({}, typed)).toContain("Role period for");
  });

  it("shows the role period, with its default, for a current head", () => {
    const head = member({
      isHead: true,
      defaultRoleLabel: "Head",
      defaultRoleDuration: "sem2",
    });
    const html = renderRow({}, head);

    expect(html).toContain("Role period for");
    expect(html).toContain("Default (Semester 2 only)");
    expect(html).toContain("Default: Head");
  });

  it("counts characters left on the contribution field", () => {
    const html = renderRow({}, member({ extraContribution: "x".repeat(120) }));

    expect(html).toContain("380 characters left");
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('maxLength="60"');
  });

  it("keeps Save disabled until the row has a change", () => {
    const clean = renderRow();
    expect(disabledTags(clean, "button")).toHaveLength(1);

    const edited = renderRow({
      draft: { ...draftOf(member()), extra: "Ran the fair" },
    });
    expect(disabledTags(edited, "button")).toHaveLength(0);
  });

  it("shows the saved indicator only for a clean, just-saved row", () => {
    expect(renderRow({ saved: true })).toContain("Saved");
    expect(renderRow({ saved: false })).not.toContain(">Saved<");
    const dirtyAfterSave = renderRow({
      saved: true,
      draft: { ...draftOf(member()), extra: "More" },
    });
    expect(dirtyAfterSave).not.toContain(">Saved<");
  });

  it("shows the API's message inline and the saving state", () => {
    const html = renderRow({
      error: "That person is no longer a member of this CCA.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("no longer a member");
    expect(renderRow({ saving: true })).toContain("Saving");
  });

  it("is read-only once the year is published: no Save, every field disabled", () => {
    const html = renderRow(
      { readOnly: true },
      member({ roleLabel: "Treasurer" }),
    );

    expect(html).not.toContain(">Save<");
    expect(disabledTags(html, "select")).toHaveLength(2);
    expect(disabledTags(html, "input")).toHaveLength(1);
    expect(disabledTags(html, "textarea")).toHaveLength(1);
  });

  it("never prints a matric", () => {
    const html = renderRow({}, {
      ...member(),
      matric: "A1234567B",
    } as RosterRowData);
    expect(html).not.toContain("A1234567B");
  });
});

describe("roster table", () => {
  it("lists the five columns", () => {
    const html = renderToStaticMarkup(
      <RosterTableView count={1} rows={<tr />} />,
    );
    for (const h of [
      "Name",
      "Duration",
      "Role",
      "Role period",
      "Additional contribution",
    ]) {
      expect(html).toContain(`>${h}<`);
    }

    // A header cell must not be display:block, or the row stacks instead of aligning.
    const cells = html.match(/<th[^>]*>/g) ?? [];
    expect(cells).toHaveLength(6);
    for (const cell of cells) expect(cell).not.toMatch(/block/);
  });

  it("says so when there are no members", () => {
    const html = renderToStaticMarkup(
      <RosterTableView count={0} rows={null} />,
    );
    expect(html).toContain("no members to list");
    expect(html).not.toContain("<table");
  });
});

describe("notes above the roster", () => {
  const notes = (over: Partial<Parameters<typeof TranscriptNotes>[0]> = {}) =>
    renderToStaticMarkup(
      <TranscriptNotes
        academicYear="AY2026/27"
        published={false}
        sem2Unset={false}
        descriptionEmpty={false}
        detailsHref="/cca/9005/details"
        {...over}
      />,
    );

  it("says nothing when the year is collecting and set up", () => {
    expect(notes()).not.toContain("published");
    expect(notes()).not.toContain("Default durations");
    expect(notes()).not.toContain("no description");
  });

  it("states that a published year is closed", () => {
    expect(notes({ published: true })).toContain(
      "Transcripts for AY2026/27 are published. Editing is closed. Ask the JCRC to reopen it.",
    );
  });

  it("explains default durations while semester 2 start is unset", () => {
    expect(notes({ sem2Unset: true })).toContain(
      "Default durations assume the full year until the JCRC sets the semester 2 start date.",
    );
  });

  it("does not show the defaults note on a published year", () => {
    expect(notes({ published: true, sem2Unset: true })).not.toContain(
      "Default durations",
    );
  });

  it("links to the CCA details form when the description is empty", () => {
    const html = notes({ descriptionEmpty: true });
    expect(html).toContain("This CCA has no description yet.");
    expect(html).toContain('href="/cca/9005/details"');
  });

  it("stays quiet about the description while it is unknown", () => {
    expect(notes({ descriptionEmpty: null })).not.toContain("no description");
  });

  it("has no exclamation marks and no 'successfully'", () => {
    const all = notes({
      published: true,
      sem2Unset: true,
      descriptionEmpty: true,
    });
    expect(all).not.toContain("!");
    expect(all).not.toMatch(/successfully/i);
  });
});

/* ---- volunteer section -------------------------------------------------- */

const record = {
  id: "a".repeat(24),
  userID: "SEED-R12",
  residentName: "Seed Twelve",
  kind: "oneoff",
  activity: "Beach clean-up",
  activityDate: "2026-11-02",
  hours: 2.5,
  recordedBy: "Seed Six",
};

const volunteer = (
  over: Partial<VolunteerSectionViewProps> = {},
): VolunteerSectionViewProps => ({
  academicYear: "AY2026/27",
  readOnly: false,
  picker: <div data-testid="picker">picker</div>,
  hasResident: true,
  kind: "regular",
  onKind: noop,
  activity: "",
  onActivity: noop,
  date: "",
  onDate: noop,
  hours: "",
  onHours: noop,
  onAdd: noop,
  adding: false,
  addError: null,
  fieldErrors: { activity: null, date: null },
  records: [],
  loading: false,
  listError: null,
  confirmVoidId: null,
  onConfirmVoid: noop,
  onVoid: noop,
  voiding: false,
  voidError: null,
  ...over,
});
const renderVolunteer = (over?: Partial<VolunteerSectionViewProps>) =>
  renderToStaticMarkup(<VolunteerSectionView {...volunteer(over)} />);

describe("volunteer hours section", () => {
  it("shows the form with Add disabled until it is complete", () => {
    const html = renderVolunteer();
    expect(html).toContain("Volunteer hours");
    expect(html).toContain('id="volunteer-activity"');
    expect(html).toContain('maxLength="120"');
    expect(disabledTags(html, "button").length).toBeGreaterThan(0);

    const ready = renderVolunteer({ activity: "Tutoring", hours: "2" });
    expect(
      disabledTags(ready, "button").some((t) => t.includes('type="submit"')),
    ).toBe(false);
  });

  it("asks for a date, bounded by the year, only for a one-off", () => {
    expect(renderVolunteer()).not.toContain('id="volunteer-date"');

    const html = renderVolunteer({ kind: "oneoff" });
    expect(html).toContain('id="volunteer-date"');
    expect(html).toContain('min="2026-08-01"');
    expect(html).toContain('max="2027-07-31"');
  });

  it("keeps Add disabled for a one-off with no date", () => {
    const html = renderVolunteer({
      kind: "oneoff",
      activity: "Beach clean-up",
      hours: "2",
    });
    expect(
      disabledTags(html, "button").some((t) => t.includes('type="submit"')),
    ).toBe(true);
  });

  it("limits hours to quarter hours between 0.25 and 200, and says why", () => {
    const html = renderVolunteer({ hours: "1.3" });
    expect(html).toContain('step="0.25"');
    expect(html).toContain('min="0.25"');
    expect(html).toContain('max="200"');
    expect(html).toContain("Hours go up in steps of 0.25.");
  });

  it("lists the records with who recorded them, and totals per resident", () => {
    const html = renderVolunteer({
      records: [record, { ...record, id: "b".repeat(24), hours: 1.5 }],
    });

    expect(html).toContain("Beach clean-up");
    expect(html).toContain("Recorded by Seed Six");
    expect(html).toContain("Total hours per resident");
    expect(html).toContain("4 hours");
    expect(html.match(/>Void</g)).toHaveLength(2);
  });

  it("says so when there are no records", () => {
    expect(renderVolunteer()).toContain(
      "No volunteer hours recorded for this year.",
    );
  });

  it("is read-only once published: no Void, no Add, fields disabled", () => {
    const html = renderVolunteer({
      readOnly: true,
      kind: "oneoff",
      records: [record],
    });

    expect(html).not.toContain(">Void<");
    expect(disabledTags(html, "input").length).toBeGreaterThanOrEqual(4);
    expect(
      disabledTags(html, "button").some((t) => t.includes('type="submit"')),
    ).toBe(true);
  });

  it("shows API errors inline", () => {
    const html = renderVolunteer({
      addError: "This CCA does not record volunteer hours.",
      fieldErrors: { activity: "Use at most 120 characters.", date: null },
    });
    expect(html).toContain("does not record volunteer hours");
    expect(html).toContain("Use at most 120 characters.");
    expect(html).toContain('role="alert"');
  });

  it("never prints a matric in the list", () => {
    const html = renderVolunteer({
      records: [{ ...record, matric: "A7654321Z" } as typeof record],
    });
    expect(html).not.toContain("A7654321Z");
  });
});

/* ---- the page's own guard ------------------------------------------------ */

describe("transcript page route", () => {
  it("404s a malformed CCA id, like its sibling sections", async () => {
    const { default: Page } = await import("../page");
    for (const bad of ["0", "abc", "12.5", ""]) {
      expect(() => Page({ params: { ccaID: bad } }), bad).toThrow("NOT_FOUND");
    }
  });

  it("renders for a real id", async () => {
    const { default: Page } = await import("../page");
    expect(() => Page({ params: { ccaID: "9005" } })).not.toThrow();
  });
});
