import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { draftOf } from "~/lib/transcript/headView";
import {
  RosterRowView,
  type RosterRowData,
  type RosterRowViewProps,
} from "../_components/RosterEditor";

vi.mock("~/trpc/react", () => ({ api: {} }));

const row = (over: Partial<RosterRowData> = {}): RosterRowData => ({
  userID: "SEED-R05",
  displayName: "Seed Five",
  isHead: true,
  defaultDuration: "full",
  duration: null,
  defaultRoleLabel: "Head",
  roleLabel: null,
  roleDuration: null,
  extraContribution: null,
  ...over,
});

const render = (data: RosterRowData, over: Partial<RosterRowViewProps> = {}) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <RosterRowView
          row={data}
          draft={draftOf(data)}
          onDraft={() => undefined}
          onSave={() => undefined}
          saving={false}
          saved={false}
          error={null}
          readOnly={false}
          {...over}
        />
      </tbody>
    </table>,
  );

/** The option list of the role period select, as markup. */
const roleOptions = (html: string) => {
  const start = html.indexOf('id="roleDuration-SEED-R05"');
  const end = html.indexOf("</select>", start);
  return start < 0 ? "" : html.slice(start, end);
};

describe("role period select in a roster row", () => {
  it("offers all options for a full-year member, with no Default entry", () => {
    const options = roleOptions(render(row()));

    expect(options).not.toContain("Default (");
    expect(options).toContain(">Full year<");
    expect(options).toContain("Semester 1 only");
    expect(options).toContain("Semester 2 only");
  });

  it("offers only that semester for a semester 2 member", () => {
    const sem2 = row({ duration: "sem2" });
    const options = roleOptions(render(sem2));

    expect(options).toContain(">Semester 2 only<");
    expect(options).toContain('value="sem2"');
    expect(options).not.toContain("Semester 1 only");
    expect(options).not.toContain(">Full year<");
  });

  it("offers only that semester for a semester 1 member", () => {
    const options = roleOptions(render(row({ duration: "sem1" })));

    expect(options).toContain(">Semester 1 only<");
    expect(options).not.toContain("Semester 2 only");
  });

  it("shows the one-line note under the row when the role period was changed", () => {
    const note = "Role period changed to Semester 2 only to match membership.";

    expect(render(row({ duration: "sem2" }), { roleNote: note })).toContain(
      note,
    );
    expect(render(row())).not.toContain("Role period changed");
  });
});
