import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { draftOf } from "~/lib/transcript/headView";
import { HistoryView } from "../residents/_components/HistoryTab";
import {
  MembershipFormView,
  type MembershipFormViewProps,
} from "../residents/_components/MembershipForm";
import {
  PanelHeaderView,
  type PanelData,
} from "../residents/_components/ResidentPanel";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const panel = (over: Partial<PanelData> = {}): PanelData => ({
  userID: "SEED-R12",
  displayName: "Seed Resident 12",
  academicYear: "AY2026/27",
  status: "published",
  state: "published",
  withheld: false,
  unlocked: false,
  isJcrcMember: false,
  unlock: null,
  withhold: null,
  ...over,
});

const header = (over: Partial<PanelData> = {}) =>
  renderToStaticMarkup(
    <PanelHeaderView
      panel={panel(over)}
      previewUrl="/admin/transcripts/preview/SEED-R12?ay=2026-27"
      onDialog={noop}
    />,
  );

describe("the resident panel header", () => {
  it("shows the name, year, status line and the way to preview", () => {
    const html = header();
    expect(html).toContain("Seed Resident 12");
    expect(html).toContain("AY2026/27");
    expect(html).toContain(">Published<");
    expect(html).toContain("Preview transcript");
    expect(html).toContain(
      'href="/admin/transcripts/preview/SEED-R12?ay=2026-27"',
    );
  });

  it("offers Unlock and Withhold for a locked, open resident, and explains why it is read-only", () => {
    const html = header();
    expect(html).toContain(">Unlock<");
    expect(html).toContain(">Withhold<");
    expect(html).not.toContain(">Relock<");
    expect(html).not.toContain(">Release<");
    expect(html).toContain(
      "Published. Unlock this resident to make corrections.",
    );
  });

  it("offers Relock instead of Unlock once unlocked, with the badge and the reason", () => {
    const html = header({
      unlocked: true,
      unlock: {
        reason: "Role was wrong",
        byName: "Seed Resident 02",
        at: null,
      },
    });
    expect(html).toContain(">Relock<");
    expect(html).not.toContain(">Unlock<");
    expect(html).toContain(">Unlocked<");
    expect(html).toContain("Reason: Role was wrong");
    expect(html).not.toContain("Unlock this resident to make corrections");
  });

  it("offers Release while withheld, and says so in the status line", () => {
    const html = header({
      withheld: true,
      withhold: { reason: "Fees", byName: null, at: null },
    });
    expect(html).toContain(">Release<");
    expect(html).not.toContain(">Withhold<");
    expect(html).toContain("Published, withheld from the resident");
    expect(html).toContain(">Withheld<");
  });

  it("does not offer Unlock while the year is still collecting", () => {
    const html = header({ status: "collecting", state: "collecting" });
    expect(html).not.toContain(">Unlock<");
    expect(html).toContain(">Collecting<");
    expect(html).not.toContain("Unlock this resident to make corrections");
  });
});

const form = (over: Partial<MembershipFormViewProps> = {}) => {
  const saved = draftOf({
    duration: null,
    roleLabel: "Captain",
    roleDuration: null,
    extraContribution: "Led the squad.",
  });
  return renderToStaticMarkup(
    <ul>
      <MembershipFormView
        idKey="roster-9005"
        title="Soccer (MALE)"
        draft={saved}
        saved={saved}
        defaultRoleLabel={null}
        canReset
        editable
        onDraft={noop}
        onReset={noop}
        onSave={noop}
        saving={false}
        savedNow={false}
        error={null}
        roleNote={null}
        {...over}
      />
    </ul>,
  );
};

describe("a membership form", () => {
  it("has explicit Clear role, Clear contribution and Reset to default", () => {
    const html = form();
    expect(html).toContain("Clear role");
    expect(html).toContain("Clear contribution");
    expect(html).toContain("Reset to default");
    expect(html).toContain('aria-label="Clear role for Soccer (MALE)"');
  });

  it("offers Reset only where there is a default, and only with something to clear", () => {
    expect(form({ canReset: false })).not.toContain("Reset to default");
    const blank = draftOf({
      duration: null,
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
    const html = form({ draft: blank, saved: blank });
    expect(html).not.toContain("Reset to default");
    expect(html).not.toContain("Clear role");
    expect(html).not.toContain("Clear contribution");
  });

  it("is plain read-only text when not editable", () => {
    const html = form({ editable: false });
    expect(html).not.toContain("Clear role");
    expect(html).not.toContain("Reset to default");
    expect(html).not.toMatch(/>Save</);
    expect(html).toMatch(/id="role-roster-9005"[^>]*disabled=""/);
  });

  it("marks a manual entry with its tag and shows the shadow note", () => {
    const html = form({
      tags: <span>Manual</span>,
      note: "also in the membership data",
    });
    expect(html).toContain("Manual");
    expect(html).toContain("also in the membership data");
  });

  it("shows the server's error and refuses a too-long role", () => {
    expect(form({ error: "That did not save." })).toContain(
      "That did not save.",
    );
    const long = draftOf({
      duration: null,
      roleLabel: "x".repeat(61),
      roleDuration: null,
      extraContribution: null,
    });
    expect(form({ draft: long })).toContain("Use at most 60 characters");
  });
});

describe("the history timeline", () => {
  const items = [
    {
      id: "2",
      action: "correction",
      reason: null,
      summary: "Roster: Soccer (MALE) role set to Captain",
      byName: "Seed Resident 02",
      at: new Date("2026-10-16T04:30:00Z"),
    },
    {
      id: "1",
      action: "unlock",
      reason: "Role was wrong",
      summary: null,
      byName: "Seed Resident 02",
      at: new Date("2026-10-16T04:00:00Z"),
    },
  ];

  it("lists each event with its words, reason or summary, who and when", () => {
    const html = renderToStaticMarkup(<HistoryView items={items} />);
    expect(html).toContain(">Correction<");
    expect(html).toContain(">Unlocked<");
    expect(html).toContain("Roster: Soccer (MALE) role set to Captain");
    expect(html).toContain("Role was wrong");
    expect(html).toContain("by Seed Resident 02");
    expect(html).toContain("16 Oct 2026, 12:30");
    expect(html.indexOf("Correction")).toBeLessThan(html.indexOf("Unlocked"));
  });

  it("says when there is nothing", () => {
    expect(renderToStaticMarkup(<HistoryView items={[]} />)).toContain(
      "Nothing has been changed for this resident and year.",
    );
  });
});
