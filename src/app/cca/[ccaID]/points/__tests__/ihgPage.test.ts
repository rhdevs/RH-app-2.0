import * as React from "react";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "~/components/ui/tooltip";
import {
  MemberCards,
  MemberTable,
} from "~/app/cca/[ccaID]/points/_components/MemberList";
import PointsHeader from "~/app/cca/[ccaID]/points/_components/PointsHeader";
import { IhgTick } from "~/app/cca/[ccaID]/points/_components/fields";
import {
  applyEntryPatch,
  ihgResultLabel,
  savedAtText,
  type PointsState,
} from "~/app/cca/[ccaID]/points/_components/usePointsEntries";
import type { PointsEntry } from "~/lib/points/entries";

// The components use the classic JSX runtime under vitest, which needs React in scope.
(globalThis as { React?: typeof React }).React = React;

const RANGE = { meanMin: 9, meanMax: 12, sdMin: 2, sdMax: 4 };

const entry = (n: number, ihg: boolean): PointsEntry => ({
  rowKey: `u:${n}`,
  matric: `A99${String(n).padStart(5, "0")}Z`,
  name: `Test Member ${n}`,
  resolved: true,
  basePoints: 10,
  semesterOnly: false,
  outgoingRole: "none",
  incomingRole: "none",
  ihg,
});

const state = { texts: {}, setIhg: () => undefined } as unknown as PointsState;

const render = (el: ReactElement): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, el));

const header = (
  ihg: { result: "1st" | "3rd4th_no_match" | null; cap: number | null } | null,
) =>
  render(
    createElement(PointsHeader, {
      ccaName: "Soccer",
      entryOpen: true,
      range: RANGE,
      isWaived: false,
      note: null,
      ihg,
    }),
  );

const ROWS = [entry(1, true), entry(2, false)];

const listProps = (
  ihg: { result: null; cap: number | null } | null,
  disabled = false,
  listState: PointsState = state,
) => ({
  rows: ROWS,
  state: listState,
  disabled,
  highlightKey: null,
  ihg,
});

const list = (
  Comp: typeof MemberTable,
  ihg: { result: null; cap: number | null } | null,
  disabled = false,
) => render(createElement(Comp, listProps(ihg, disabled)));

// The class list always mentions "disabled:", so match the attribute itself.
const DISABLED = /\sdisabled=""/;

/** The <button> that renders one member's IHG checkbox. */
const tickButton = (html: string, member: number): string => {
  const label = `aria-label="IHG points for Test Member ${member}"`;
  const at = html.indexOf(label);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", at) + 1);
};

/** Every IhgTick element in an unrendered tree, in document order. */
const findTicks = (node: unknown): ReactElement<TickProps>[] => {
  if (Array.isArray(node)) return node.flatMap(findTicks);
  if (!isValidElement(node)) return [];
  const props = node.props as { children?: unknown };
  const own = node.type === IhgTick ? [node as ReactElement<TickProps>] : [];
  return [...own, ...findTicks(props.children)];
};

type TickProps = { name: string; onChange: (on: boolean) => void };

describe("PointsHeader IHG lines", () => {
  it("shows the result and cap when both are set", () => {
    const html = header({ result: "1st", cap: 12 });
    expect(html).toContain("IHG result: 1st");
    expect(html).toContain("up to 12 members get the IHG points");
    expect(html).toContain("tick them below.");
  });

  it("writes 3rd4th_no_match in words", () => {
    expect(ihgResultLabel("3rd4th_no_match")).toBe(
      "3rd–4th, no placement match",
    );
    expect(header({ result: "3rd4th_no_match", cap: 5 })).toContain(
      "3rd–4th, no placement match",
    );
  });

  it("shows the amber line when the result or cap is blank", () => {
    for (const ihg of [
      { result: null, cap: 2 },
      { result: "1st" as const, cap: null },
    ]) {
      const html = header(ihg);
      expect(html).toContain("hasn’t set this CCA’s IHG result and cap yet");
      expect(html).toContain("the export waits for JCRC");
    }
  });

  it("shows nothing for a non-sport", () => {
    expect(header(null)).not.toContain("IHG");
  });
});

describe("member list IHG controls", () => {
  it("renders an IHG column and a tick per member for a sport", () => {
    const html = list(MemberTable, { result: null, cap: 2 });
    expect(html).toContain(">IHG<");
    expect(html).toContain('aria-label="IHG points for Test Member 1"');
    expect(html).toContain('aria-label="IHG points for Test Member 2"');
  });

  it.each([
    ["table", MemberTable],
    ["cards", MemberCards as typeof MemberTable],
  ])(
    "%s: ticked member renders checked, unticked renders unchecked",
    (_n, Comp) => {
      const html = list(Comp, { result: null, cap: 2 });
      expect(tickButton(html, 1)).toContain('data-state="checked"');
      expect(tickButton(html, 2)).toContain('data-state="unchecked"');
    },
  );

  it.each([
    ["table", MemberTable],
    ["cards", MemberCards as typeof MemberTable],
  ])("%s: ticks are enabled while entry is open", (_n, Comp) => {
    const html = list(Comp, { result: null, cap: 2 });
    expect(tickButton(html, 1)).not.toMatch(DISABLED);
    expect(tickButton(html, 2)).not.toMatch(DISABLED);
  });

  it.each([
    ["table", MemberTable],
    ["cards", MemberCards as typeof MemberTable],
  ])("%s: ticks render disabled when the list is disabled", (_n, Comp) => {
    const html = list(Comp, { result: null, cap: 2 }, true);
    expect(tickButton(html, 1)).toMatch(DISABLED);
    expect(tickButton(html, 2)).toMatch(DISABLED);
  });

  it.each([
    ["table", MemberTable],
    ["cards", MemberCards as typeof MemberTable],
  ])("%s: each tick passes its own row key to state.setIhg", (_n, Comp) => {
    const setIhg = vi.fn();
    const spyState = { texts: {}, setIhg } as unknown as PointsState;
    const ticks = findTicks(
      (Comp as (p: unknown) => ReactElement)(
        listProps({ result: null, cap: 2 }, false, spyState),
      ),
    );
    expect(ticks.map((t) => t.props.name)).toEqual([
      "Test Member 1",
      "Test Member 2",
    ]);
    ticks[1]!.props.onChange(true);
    expect(setIhg).toHaveBeenCalledTimes(1);
    expect(setIhg).toHaveBeenCalledWith("u:2", true);
    ticks[0]!.props.onChange(false);
    expect(setIhg).toHaveBeenLastCalledWith("u:1", false);
  });

  it("puts the IHG column between Active for and Roles", () => {
    const html = list(MemberTable, { result: null, cap: 2 });
    const at = (s: string) => html.indexOf(s);
    expect(at("Active for")).toBeLessThan(at(">IHG<"));
    expect(at(">IHG<")).toBeLessThan(at(">Roles<"));
  });

  it("leaves the column out entirely for a non-sport", () => {
    const html = list(MemberTable, null);
    expect(html).not.toContain("IHG");
  });

  it("gives each card an IHG points row only for a sport", () => {
    expect(
      list(MemberCards as typeof MemberTable, { result: null, cap: 2 }),
    ).toContain("IHG points");
    expect(list(MemberCards as typeof MemberTable, null)).not.toContain("IHG");
  });
});

describe("IHG tick state update", () => {
  it("changes only the ticked row", () => {
    const next = applyEntryPatch(ROWS, true, "u:2", { ihg: true });
    expect(next.map((e) => e.ihg)).toEqual([true, true]);
    expect(next[0]).toBe(ROWS[0]);
    expect(ROWS[1]!.ihg).toBe(false);
  });

  it("returns the same list when entry is closed", () => {
    expect(applyEntryPatch(ROWS, false, "u:2", { ihg: true })).toBe(ROWS);
  });
});

describe("savedAtText", () => {
  const now = new Date(2027, 3, 3, 18, 0);

  it("shows only the time when saved today", () => {
    expect(savedAtText(new Date(2027, 3, 3, 14, 32), now)).toBe("14:32");
  });

  it("adds the date when saved on an earlier day", () => {
    expect(savedAtText(new Date(2027, 3, 2, 14, 32), now)).toBe(
      "2 Apr 2027, 14:32",
    );
  });
});
