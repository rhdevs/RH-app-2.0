import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  RosterRowView,
  RosterTableView,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";
import * as tab from "../_components/TranscriptTab";
import { TranscriptNotes } from "../_components/TranscriptTab";
import { rosterNotice } from "~/lib/transcript/headView";
import { draftOf } from "~/lib/transcript/headView";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/services/transcript/flag", () => ({
  isTranscriptEnabled: async () => flag.on,
}));

const noop = () => undefined;

const member = (over: Partial<RosterRowData> = {}): RosterRowData => ({
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
  it("shows the name, a full-year default with no Default entry, and the blank-role placeholder", () => {
    const html = renderRow({}, member());

    expect(html).toContain("Seed Twelve");
    expect(html).toContain(">Full year<");
    expect(html).toContain("Semester 1 only");
    expect(html).toContain("Semester 2 only");
    expect(html).not.toContain("Default (");
    expect(html).toContain("Leave blank for member");
  });

  it("hides the role period until a role is typed", () => {
    expect(renderRow()).not.toContain("Role period for");

    const typed = member({ roleLabel: "Treasurer" });
    expect(renderRow({}, typed)).toContain("Role period for");
  });

  it("shows the role period, with the full-year choice first, for a current head", () => {
    const head = member({
      isHead: true,
      defaultRoleLabel: "Head",
    });
    const html = renderRow({}, head);

    expect(html).toContain("Role period for");
    expect(html).not.toContain("Default (");
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
      "Additional Contributions",
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
        descriptionEmpty={false}
        detailsHref="/cca/9005/details"
        {...over}
      />,
    );

  it("says nothing when the year is collecting and set up", () => {
    expect(notes()).not.toContain("published");
    expect(notes()).not.toContain("Default durations");
    expect(notes()).not.toContain("semester 2 start");
    expect(notes()).not.toContain("no description");
  });

  it("states what the notice says, as given", () => {
    expect(
      notes({
        stateNote: rosterNotice({ ...NOTICE, refusal: "PERIOD_PUBLISHED" }),
      }),
    ).toContain(
      "Transcripts for AY2026/27 are open. Editing is closed. Ask the JCRC to fix individual residents.",
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
      await expect(Page({ params: { ccaID: bad } }), bad).rejects.toThrow(
        "NOT_FOUND",
      );
    }
  });

  it("renders for a real id", async () => {
    const { default: Page } = await import("../page");
    const element = await Page({ params: { ccaID: "9005" } });
    // It draws the Transcript tab for exactly the CCA in the address.
    expect(element.type).toBe(tab.default);
    expect(element.props).toEqual({ ccaID: 9005 });
  });

  it("shows a calm note instead of the tab while transcripts are switched off", async () => {
    const { default: Page } = await import("../page");
    flag.on = false;
    try {
      const html = renderToStaticMarkup(
        await Page({ params: { ccaID: "9005" } }),
      );
      expect(html).toContain("Transcripts are not available yet.");
      expect(html).not.toContain("transcript.enabled");
    } finally {
      flag.on = true;
    }
  });
});

describe("the CCA transcript tab: the handover note (P6)", () => {
  it("tells heads to set their own role before a handover, while the year is editable", () => {
    const shown = renderToStaticMarkup(
      <TranscriptNotes
        stateNote={null}
        descriptionEmpty={false}
        detailsHref="/cca/9005/details"
        showHandoverNote
      />,
    );
    expect(shown).toContain(
      "Handing over during the year? Before you do, set your own role for this year in the Transcript tab",
    );
    const hidden = renderToStaticMarkup(
      <TranscriptNotes
        stateNote={null}
        descriptionEmpty={false}
        detailsHref="/cca/9005/details"
      />,
    );
    expect(hidden).not.toContain("Handing over");
  });
});

describe("the CCA transcript tab: no lock, a deadline line", () => {
  it("tells heads to finish before transcripts open", () => {
    expect(tab.OPEN_DEADLINE_NOTE).toBe(
      "Finish this year's records before the JCRC opens transcripts at the end of the year.",
    );
  });

  it("has no Lock member list button any more", () => {
    expect(Object.keys(tab)).not.toContain("LockRoster");
    expect(Object.keys(tab)).not.toContain("showLock");
  });
});
