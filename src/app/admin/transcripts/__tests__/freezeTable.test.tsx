import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FreezeTableView,
  UnfreezePreviewPanel,
  canConfirmUnfreeze,
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
  preview: null,
  previewError: null,
  confirmed: false,
  onConfirmed: noop,
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

describe("unmatched members (F19)", () => {
  it("says how many members could not be matched when a list was frozen", () => {
    const html = render({
      rows: [{ ...ROWS[1]!, unresolvedCount: 2 }, ROWS[2]!],
    });
    expect(html).toContain("2 members could not be matched");
    expect(render()).not.toContain("could not be matched");
  });
});

describe("the Unfreeze preview (F17)", () => {
  const preview = {
    dropped: [{ userID: "SEED-R12", name: "Seed Resident 12" }],
    added: [{ userID: "SEED-R20", name: "Seed Resident 20" }],
  };
  const panel = (
    over: Partial<Parameters<typeof UnfreezePreviewPanel>[0]> = {},
  ) =>
    renderToStaticMarkup(
      <UnfreezePreviewPanel
        preview={preview}
        previewError={null}
        confirmed={false}
        onConfirmed={noop}
        pending={false}
        {...over}
      />,
    );

  it("names who would be dropped and who added", () => {
    const html = panel();
    expect(html).toContain("Would be dropped");
    expect(html).toContain("Seed Resident 12");
    expect(html).toContain("Would be added");
    expect(html).toContain("Seed Resident 20");
    expect(html).toContain("I understand who would be dropped and added.");
  });

  it("says Nobody for an empty list, and waits while loading", () => {
    expect(panel({ preview: { dropped: [], added: [] } })).toContain("Nobody");
    const loading = panel({ preview: null });
    expect(loading).toContain("Loading who would change");
    expect(loading).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
  });

  it("allows Unfreeze only with a reason, the preview and the tick", () => {
    const ok = { reason: "Fixing it", preview, confirmed: true };
    expect(canConfirmUnfreeze(ok)).toBe(true);
    expect(canConfirmUnfreeze({ ...ok, confirmed: false })).toBe(false);
    expect(canConfirmUnfreeze({ ...ok, preview: null })).toBe(false);
    expect(canConfirmUnfreeze({ ...ok, reason: " x " })).toBe(false);
  });
});
