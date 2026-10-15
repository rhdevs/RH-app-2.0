import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ROSTER_TABLE_MIN_WIDTH,
  rosterLayoutFor,
} from "~/lib/transcript/useContainerWidth";
import {
  RosterRowView,
  RosterTableView,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";
import { draftOf } from "~/lib/transcript/headView";

vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

describe("roster layout follows the container's own width", () => {
  it("uses cards below the width the table needs, and the table at or above it", () => {
    expect(ROSTER_TABLE_MIN_WIDTH).toBe(896);
    expect(rosterLayoutFor(375)).toBe("cards");
    expect(rosterLayoutFor(730)).toBe("cards"); // 1280px window, beside the side menu
    expect(rosterLayoutFor(895.9)).toBe("cards");
    expect(rosterLayoutFor(896)).toBe("table");
    expect(rosterLayoutFor(1100)).toBe("table");
  });

  it("starts with cards before the container has been measured", () => {
    expect(rosterLayoutFor(null)).toBe("cards");
  });

  it("can be told a different table width", () => {
    expect(rosterLayoutFor(700, 600)).toBe("table");
    expect(rosterLayoutFor(500, 600)).toBe("cards");
  });
});

describe("RosterTableView layout", () => {
  const cards = <li data-card="1">card</li>;

  it("draws only the cards when told cards, with no window-based hiding", () => {
    const html = renderToStaticMarkup(
      <RosterTableView count={1} rows={<tr />} cards={cards} layout="cards" />,
    );
    expect(html).toContain('data-card="1"');
    expect(html).not.toContain("md:hidden");
    expect(html).toMatch(/<div class="hidden">/);
  });

  it("draws only the table when told table", () => {
    const html = renderToStaticMarkup(
      <RosterTableView count={1} rows={<tr />} cards={cards} layout="table" />,
    );
    expect(html).not.toContain('data-card="1"');
    expect(html).toContain('<div class="overflow-x-auto">');
    expect(html).toContain("<table");
  });

  it("keeps the window-based behaviour when no layout is given", () => {
    const html = renderToStaticMarkup(
      <RosterTableView count={1} rows={<tr />} cards={cards} />,
    );
    expect(html).toContain("md:hidden");
    expect(html).toContain("hidden overflow-x-auto md:block");
  });
});

describe("the Save column stays in view", () => {
  const row: RosterRowData = {
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
  };
  const props: RosterRowViewProps = {
    row,
    draft: draftOf(row),
    onDraft: noop,
    onSave: noop,
    saving: false,
    saved: false,
    error: null,
    readOnly: false,
  };

  it("makes the last header cell and each row's Save cell sticky at the right edge", () => {
    const head = renderToStaticMarkup(
      <RosterTableView count={1} rows={null} layout="table" />,
    );
    const lastTh = head.split("<th ").pop()!.split(">")[0]!;
    expect(lastTh).toContain("sticky right-0");
    expect(head).toContain('<span class="sr-only">Save</span>');

    const body = renderToStaticMarkup(
      <table>
        <tbody>
          <RosterRowView {...props} />
        </tbody>
      </table>,
    );
    const lastTd = body.split("<td ").pop()!.split(">")[0]!;
    expect(lastTd).toContain("sticky right-0");
    expect(lastTd).toContain("bg-white");
    expect(body).toContain(">Save<");
  });
});
