import * as React from "react";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TooltipProvider } from "~/components/ui/tooltip";
import {
  MemberCards,
  MemberTable,
} from "~/app/cca/[ccaID]/points/_components/MemberList";
import PointsHeader from "~/app/cca/[ccaID]/points/_components/PointsHeader";
import {
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

const list = (
  Comp: typeof MemberTable,
  ihg: { result: null; cap: number | null } | null,
) =>
  render(
    createElement(Comp, {
      rows: [entry(1, true), entry(2, false)],
      state,
      disabled: false,
      highlightKey: null,
      ihg,
    }),
  );

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
