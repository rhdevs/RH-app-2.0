import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FreezeTableView,
  visibleFreezeRows,
  type FreezeRowView,
  type FreezeTableViewProps,
} from "../_components/FreezeTable";

vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const ROWS: FreezeRowView[] = [
  {
    ccaID: 9005,
    ccaName: "Soccer (MALE)",
    category: "Sports Activities",
    state: "Not frozen",
    frozen: false,
    frozenAt: null,
    frozenByName: null,
    memberCount: null,
  },
  {
    ccaID: 9014,
    ccaName: "Raffles Hall Dance",
    category: "Performing Arts",
    state: "Frozen at handover",
    frozen: true,
    frozenAt: "2026-09-19T20:00:00Z",
    frozenByName: "Seed Resident 01",
    memberCount: 6,
  },
  {
    ccaID: 9013,
    ccaName: "Hall Choir",
    category: "Performing Arts",
    state: "Locked by head",
    frozen: true,
    frozenAt: "2026-10-04T20:00:00Z",
    frozenByName: "Seed Resident 02",
    memberCount: 9,
  },
];

const props = (
  over: Partial<FreezeTableViewProps> = {},
): FreezeTableViewProps => ({
  academicYear: "AY2026/27",
  status: "collecting",
  rows: ROWS,
  onlyUnfrozen: false,
  onOnlyUnfrozen: noop,
  warning: null,
  loadError: null,
  unfreezing: null,
  onUnfreezing: noop,
  reason: "",
  onReason: noop,
  onUnfreeze: noop,
  pending: false,
  unfreezeError: null,
  ...over,
});
const render = (over?: Partial<FreezeTableViewProps>) =>
  renderToStaticMarkup(<FreezeTableView {...props(over)} />);

describe("CCA member lists table", () => {
  it("shows each CCA's state, date (Singapore), who, and the member count", () => {
    const html = render();

    expect(html).toContain("CCA member lists");
    expect(html).toContain("Not frozen");
    expect(html).toContain("Frozen at handover");
    expect(html).toContain("Locked by head");
    // 2026-09-19T20:00Z is 20 September in Singapore
    expect(html).toContain("20 Sep 2026");
    expect(html).toContain("5 Oct 2026");
    expect(html).toContain("Seed Resident 01");
    expect(html).toContain(">6<");
  });

  it("offers Unfreeze only on frozen CCAs", () => {
    const html = render();

    expect(html.match(/>Unfreeze</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Unfreeze Raffles Hall Dance"');
    expect(html).not.toContain('aria-label="Unfreeze Soccer (MALE)"');
  });

  it("offers no Unfreeze once the year is published", () => {
    expect(render({ status: "published" })).not.toContain(">Unfreeze<");
    expect(render({ status: "closed" })).toContain(">Unfreeze<");
  });

  it("filters to the CCAs that are not frozen", () => {
    expect(visibleFreezeRows(ROWS, true).map((r) => r.ccaID)).toEqual([9005]);
    expect(visibleFreezeRows(ROWS, false)).toHaveLength(3);

    const html = render({ onlyUnfrozen: true });
    expect(html).toContain("Soccer (MALE)");
    expect(html).not.toContain("Raffles Hall Dance");
    expect(html).toContain("Not frozen only");
  });

  it("says so when every CCA is frozen", () => {
    expect(render({ rows: [ROWS[1]!], onlyUnfrozen: true })).toContain(
      "Every CCA is frozen.",
    );
  });

  it("shows the 1 June warning when given", () => {
    const html = render({
      warning:
        "3 CCAs are not frozen for AY2026/27 yet. Close the year before memberships change.",
    });

    expect(html).toContain("3 CCAs are not frozen for AY2026/27 yet.");
    expect(html).toContain('role="status"');
    expect(render()).not.toContain("not frozen for AY2026/27 yet");
  });

  it("shows a load error inline", () => {
    expect(render({ loadError: "Something went wrong. Try again." })).toContain(
      'role="alert"',
    );
  });
});
