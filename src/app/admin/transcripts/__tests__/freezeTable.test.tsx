import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FreezeTableView,
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
