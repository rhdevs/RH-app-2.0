import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { draftOf } from "~/lib/transcript/headView";
import {
  BLANK_ROW_DRAFT,
  RosterCardView,
  RosterRowView,
  canReset,
  hasOverrides,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";

vi.mock("~/trpc/react", () => ({ api: {} }));

const row = (over: Partial<RosterRowData> = {}): RosterRowData => ({
  userID: "SEED-R12",
  displayName: "Seed Twelve",
  isHead: false,
  defaultDuration: "full",
  duration: "sem2",
  defaultRoleLabel: null,
  roleLabel: "Vice-Captain",
  defaultRoleDuration: null,
  roleDuration: "sem2",
  extraContribution: "Ran the fixtures.",
  ...over,
});

const props = (
  data: RosterRowData,
  over: Partial<RosterRowViewProps> = {},
): RosterRowViewProps => ({
  row: data,
  draft: draftOf(data),
  onDraft: () => undefined,
  onSave: () => undefined,
  onReset: () => undefined,
  saving: false,
  saved: false,
  error: null,
  readOnly: false,
  ...over,
});

const table = (p: RosterRowViewProps) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <RosterRowView {...p} />
      </tbody>
    </table>,
  );
const card = (p: RosterRowViewProps) =>
  renderToStaticMarkup(
    <ul>
      <RosterCardView {...p} />
    </ul>,
  );

describe.each([
  ["a table row", table],
  ["a card", card],
])("clearing and resetting in %s", (_name, render) => {
  it("offers Clear role, Clear contribution and Reset to default for a row with overrides", () => {
    const html = render(props(row()));
    expect(html).toContain('aria-label="Clear role for Seed Twelve"');
    expect(html).toContain('aria-label="Clear contribution for Seed Twelve"');
    expect(html).toContain('aria-label="Reset to default for Seed Twelve"');
  });

  it("offers nothing to clear on a row that has no role or contribution", () => {
    const data = row({
      duration: null,
      roleLabel: null,
      roleDuration: null,
      extraContribution: null,
    });
    const html = render(props(data));
    expect(html).not.toContain("Clear role");
    expect(html).not.toContain("Clear contribution");
    expect(html).not.toContain("Reset to default");
  });

  it("offers no Reset on a frozen list, which has no defaults to go back to", () => {
    const html = render(props(row({ defaultDuration: null })));
    expect(html).not.toContain("Reset to default");
    expect(html).toContain("Clear role");
  });

  it("offers none of them when read-only", () => {
    const html = render(props(row(), { readOnly: true }));
    expect(html).not.toContain("Clear role");
    expect(html).not.toContain("Clear contribution");
    expect(html).not.toContain("Reset to default");
  });
});

describe("the reset rule", () => {
  it("blank is the default; any override makes a reset worth offering", () => {
    expect(hasOverrides(BLANK_ROW_DRAFT)).toBe(false);
    expect(hasOverrides({ ...BLANK_ROW_DRAFT, extra: " x " })).toBe(true);
    expect(hasOverrides({ ...BLANK_ROW_DRAFT, duration: "sem1" })).toBe(true);
    expect(canReset(row(), draftOf(row()))).toBe(true);
    expect(canReset(row({ defaultDuration: null }), draftOf(row()))).toBe(
      false,
    );
    expect(canReset(row(), BLANK_ROW_DRAFT)).toBe(false);
  });
});
