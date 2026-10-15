import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RosterRowView,
  RosterTableView,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";
import { TranscriptNotes } from "../_components/TranscriptTab";
import { rosterNotice } from "~/lib/transcript/headView";
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
    const cells = html
      .split("<th ")
      .slice(1)
      .map((c) => c.split(">")[0]!);
    expect(cells).toHaveLength(6);
    for (const cell of cells) expect(cell.split(" ")).not.toContain("block");
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
        stateNote={null}
        showDefaultsNote={false}
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

  it("states what the notice says, as given", () => {
    expect(
      notes({
        stateNote: rosterNotice({ ...NOTICE, refusal: "PERIOD_PUBLISHED" }),
      }),
    ).toContain(
      "Transcripts for AY2026/27 are published. Editing is closed. Ask the JCRC to reopen it.",
    );
  });

  it("explains default durations while semester 2 start is unset", () => {
    expect(notes({ showDefaultsNote: true })).toContain(
      "Default durations assume the full year until the JCRC sets the semester 2 start date.",
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
      stateNote: rosterNotice({ ...NOTICE, refusal: "PERIOD_PUBLISHED" }),
      showDefaultsNote: true,
      descriptionEmpty: true,
    });
    expect(all).not.toContain("!");
    expect(all).not.toMatch(/successfully/i);
  });
});

const NOTICE = {
  academicYear: "AY2026/27",
  mode: "live" as const,
  refusal: null,
  freezeReason: null,
  frozenOn: null,
};

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
