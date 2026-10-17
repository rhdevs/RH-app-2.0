import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FreezeTableView,
  showFreezeTable,
  type FreezeRowView,
  type FreezeTableViewProps,
} from "../_components/FreezeTable";

vi.mock("~/trpc/react", () => ({ api: {} }));

const ROWS: FreezeRowView[] = [
  {
    ccaID: 9014,
    ccaName: "Raffles Hall Dance",
    category: "Performing Arts",
    state: "Saved when transcripts opened",
    locked: true,
    frozenAt: "2027-04-14T20:00:00Z",
    frozenByName: "Seed Resident 02",
    memberCount: 6,
    unresolvedCount: 2,
  },
  {
    ccaID: 9013,
    ccaName: "Hall Choir",
    category: "Performing Arts",
    state: "Saved when transcripts opened",
    locked: true,
    frozenAt: "2027-04-14T20:00:00Z",
    frozenByName: "Seed Resident 02",
    memberCount: 9,
    unresolvedCount: 0,
  },
];

const render = (over: Partial<FreezeTableViewProps> = {}) =>
  renderToStaticMarkup(
    <FreezeTableView rows={ROWS} loadError={null} {...over} />,
  );

describe("CCA member lists after transcripts open", () => {
  it("shows each CCA's saved list: state, date (Singapore), members", () => {
    const html = render();

    expect(html).toContain("CCA member lists");
    expect(html).toContain("Saved when transcripts opened");
    // 2027-04-14T20:00Z is 15 April in Singapore
    expect(html).toContain("15 Apr 2027");
    expect(html).toContain(">6<");
    expect(html).toContain(">9<");
  });

  it("says how many members could not be matched, only where there were some", () => {
    const html = render();
    expect(html).toContain("2 members could not be matched");
    expect(html.match(/could not be matched/g)).toHaveLength(1);
  });

  it("tells a collecting year with some lists saved to press Open again (F30)", () => {
    const partly = render({ partlySaved: true });
    expect(partly).toContain(
      "Some CCAs are saved; press Open transcripts again to finish.",
    );
    expect(partly).toContain("Hall Choir");
    expect(render()).not.toContain("press Open transcripts again");
  });

  it("is read-only: no Unfreeze, no buttons at all", () => {
    const html = render();
    expect(html).not.toContain("Unfreeze");
    expect(html).not.toContain("<button");
  });

  it("says so when there are no CCAs, and shows a load error inline", () => {
    expect(render({ rows: [] })).toContain("No CCAs.");
    expect(render({ loadError: "Something went wrong. Try again." })).toContain(
      'role="alert"',
    );
  });
});

describe("when the member-list table is shown (F34)", () => {
  it("shows a load error even when no CCA is locked yet", () => {
    expect(
      showFreezeTable({ published: false, hasError: true, rows: [] }),
    ).toBe(true);
    expect(
      renderToStaticMarkup(
        <FreezeTableView
          rows={[]}
          loadError="Something went wrong. Try again."
          partlySaved
        />,
      ),
    ).toContain("Something went wrong");
  });

  it("stays hidden for a collecting year with nothing saved and no error", () => {
    expect(
      showFreezeTable({
        published: false,
        hasError: false,
        rows: [{ locked: false }],
      }),
    ).toBe(false);
  });

  it("is shown once any list is saved, and always for an open year", () => {
    expect(
      showFreezeTable({
        published: false,
        hasError: false,
        rows: [{ locked: true }],
      }),
    ).toBe(true);
    expect(
      showFreezeTable({ published: true, hasError: false, rows: [] }),
    ).toBe(true);
  });
});
