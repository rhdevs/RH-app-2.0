import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  VolunteerSectionView,
  type VolunteerSectionViewProps,
} from "../_components/VolunteerSection";

vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;
const props = (
  over: Partial<VolunteerSectionViewProps> = {},
): VolunteerSectionViewProps => ({
  academicYear: "AY2026/27",
  readOnly: false,
  picker: null,
  hasResident: false,
  kind: "oneoff",
  onKind: noop,
  activity: "",
  onActivity: noop,
  date: "",
  onDate: noop,
  hours: "",
  onHours: noop,
  onAdd: noop,
  adding: false,
  addError: null,
  fieldErrors: { activity: null, date: null },
  records: [],
  loading: false,
  listError: null,
  confirmVoidId: null,
  onConfirmVoid: noop,
  onVoid: noop,
  voiding: false,
  voidError: null,
  ...over,
});

describe("the volunteer form after an add (inputs cleared)", () => {
  it("keeps the academic year and the chosen kind", () => {
    const html = renderToStaticMarkup(<VolunteerSectionView {...props()} />);

    expect(html).toContain("Records for AY2026/27");
    expect(html).toMatch(
      /value="oneoff"[^>]*checked=""|checked=""[^>]*value="oneoff"/,
    );
    expect(html).toContain('id="volunteer-date"');
    expect(html).toContain("Within AY2026/27");
  });

  it("shows an empty activity and hours", () => {
    const html = renderToStaticMarkup(<VolunteerSectionView {...props()} />);

    expect(html).toMatch(
      /id="volunteer-activity"[^>]*value=""|value=""[^>]*id="volunteer-activity"/,
    );
  });
});
