import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AwardsSummaryView,
  type AwardsSummaryViewProps,
} from "../_components/AwardsPanel";
import {
  PeriodPanelView,
  panelReminders,
  runOpen,
  type OpenStep,
  type PeriodPanelViewProps,
} from "../_components/PeriodPanel";
import { PreviewPickerView, previewHref } from "../_components/PreviewPicker";
import {
  ResidentPickerView,
  type PickedResident,
} from "../_components/ResidentPicker";
import {
  REMOVE_CONFIRMATION,
  VolunteeringTagsView,
  countLine,
  suggestCcas,
  taggedCcas,
  type TaggedCca,
  type VolunteeringTagsViewProps,
} from "../_components/VolunteeringTags";

const noop = () => undefined;

/* ---- section a: academic year ---------------------------------------- */

const period = (
  over: Partial<PeriodPanelViewProps> = {},
): PeriodPanelViewProps => ({
  years: ["AY2027/28", "AY2026/27"],
  selected: "AY2026/27",
  onSelect: noop,
  status: "collecting",
  canOpen: true,
  publishedLine: null,
  confirming: false,
  onConfirming: noop,
  onConfirm: noop,
  acting: false,
  actionError: null,
  resultLine: null,
  downloadByValue: "",
  onDownloadByChange: noop,
  downloadByDirty: false,
  onSaveDownloadBy: noop,
  savingDownloadBy: false,
  downloadByError: null,
  ...over,
});
const renderPeriod = (over?: Partial<PeriodPanelViewProps>) =>
  renderToStaticMarkup(<PeriodPanelView {...period(over)} />);

describe("academic year panel", () => {
  const buttons = (html: string) =>
    [...html.matchAll(/<button[^>]*type="button"[^>]*>([^<]*)</g)].map(
      (m) => m[1],
    );

  it("offers one button, Open transcripts, while the year is collecting", () => {
    const html = renderPeriod();

    expect(html).toContain("Academic year");
    expect(html).toContain("Collecting");
    expect(buttons(html)).toEqual(["Open transcripts"]);
    for (const gone of [
      "Close year",
      "Publish",
      "Reopen for review",
      "Back to collecting",
      "Freeze remaining",
      "draft",
    ]) {
      expect(html).not.toContain(gone);
    }
  });

  it("has no Semester 2 start date: semester labels are chosen by heads", () => {
    const html = renderPeriod();
    expect(html).not.toContain("Semester 2 start");
    expect(html).not.toContain("transcripts-sem2");
    expect(html).not.toContain("defaults to semester 2");
    expect(html).toContain("Download by");
  });

  it("hides the button once the year is open and says so", () => {
    const html = renderPeriod({
      status: "published",
      canOpen: false,
      publishedLine: "Opened on 15 Apr 2027 by Seed Resident 02.",
      freezeTable: <p>member list results</p>,
    });

    expect(html).toContain(">Open<");
    expect(buttons(html)).not.toContain("Open transcripts");
    expect(html).toContain("Opened on 15 Apr 2027 by Seed Resident 02.");
    // The member-list results are whatever the container passes in.
    expect(html).toContain("member list results");
    expect(renderPeriod()).not.toContain("member list results");
  });

  it("shows the per-CCA results for a collecting year too, when it is given", () => {
    const html = renderPeriod({
      status: "collecting",
      freezeTable: <p>member list results</p>,
    });
    expect(html).toContain("member list results");
    expect(buttons(html)).toContain("Open transcripts");
  });

  it("offers no Open transcripts for a future year", () => {
    expect(buttons(renderPeriod({ canOpen: false }))).not.toContain(
      "Open transcripts",
    );
    expect(renderPeriod({ canOpen: false })).not.toContain("Contact RHDevs");
  });

  it("offers no Open transcripts for a past year, and says to contact RHDevs", () => {
    const html = renderPeriod({ canOpen: false, pastUnopened: true });
    expect(buttons(html)).not.toContain("Open transcripts");
    expect(html).toContain(
      "This year can no longer be opened from the app, because CCA member lists have changed since August. Contact RHDevs.",
    );
  });

  it("treats a year with no period yet as collecting", () => {
    const html = renderPeriod({ status: null });

    expect(html).toContain("Collecting");
    expect(buttons(html)).toContain("Open transcripts");
  });

  it("disables Save until the download-by date has changed", () => {
    expect(renderPeriod({ downloadByDirty: false })).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>Save</,
    );
    expect(renderPeriod({ downloadByDirty: true })).not.toMatch(
      /<button[^>]*\sdisabled=""[^>]*>Save</,
    );
  });

  it("shows the result in words, and an error as an alert", () => {
    const html = renderPeriod({
      resultLine:
        "Transcripts for AY2026/27 are open. 12 CCA member lists saved.",
      actionError: "Transcripts for this academic year are already open.",
    });

    expect(html).toContain("12 CCA member lists saved.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("already open");
  });

  it("shows the reminders it is given, the August one as an alert", () => {
    const html = renderPeriod({
      reminders: {
        openReminder: "Transcripts for AY2026/27 are not open yet.",
        previousYear: "Transcripts for AY2025/26 are still not open.",
      },
    });
    expect(html).toContain("Transcripts for AY2026/27 are not open yet.");
    expect(html).toMatch(/role="alert"[^>]*>Transcripts for AY2025\/26/);
  });

  it("lists every year offered, newest first as given", () => {
    const html = renderPeriod();

    expect(html.indexOf("AY2027/28")).toBeLessThan(
      html.indexOf('value="AY2026/27"'),
    );
    expect(html).toContain('<option value="AY2026/27" selected');
  });

  it("uses sentence case and no exclamation marks or the word successfully", () => {
    const html = renderPeriod({ status: "published", canOpen: false });
    const text = html.replace(/<[^>]*>/g, " ");

    expect(text).not.toContain("!");
    expect(text.toLowerCase()).not.toContain("successfully");
  });
});

describe("one press of Open transcripts", () => {
  const step = (over: Partial<OpenStep>): OpenStep => ({
    opened: false,
    runID: "11111111-1111-4111-8111-111111111111",
    lockedInRun: 0,
    totalCcas: 3,
    lockedNow: 0,
    relocked: 0,
    failures: [],
    unresolved: 0,
    ...over,
  });

  it("continues the run with its runID, shows progress, and adds the counts up", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(step({ lockedInRun: 1, lockedNow: 1 }))
      .mockResolvedValueOnce(
        step({ lockedInRun: 2, lockedNow: 1, unresolved: 2 }),
      )
      .mockResolvedValueOnce(
        step({ opened: true, lockedInRun: 3, lockedNow: 1 }),
      );
    const progress: string[] = [];
    const refresh = vi.fn(async () => undefined);

    const outcome = await runOpen(
      "AY2026/27",
      call,
      (l) => progress.push(l),
      refresh,
    );

    expect(call.mock.calls.map((c) => c[0])).toEqual([
      { academicYear: "AY2026/27", runID: undefined },
      { academicYear: "AY2026/27", runID: step({}).runID },
      { academicYear: "AY2026/27", runID: step({}).runID },
    ]);
    expect(progress).toEqual([
      "Locking member lists: 1 of 3 CCAs",
      "Locking member lists: 2 of 3 CCAs",
    ]);
    expect(outcome).toEqual({
      result: step({
        opened: true,
        lockedInRun: 3,
        lockedNow: 3,
        unresolved: 2,
      }),
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops at the first failure and returns it", async () => {
    const failed = step({ failures: [{ name: "Chess Club", code: "P2034" }] });
    const call = vi.fn().mockResolvedValue(failed);

    const outcome = await runOpen("AY2026/27", call, noop, async () => noop());

    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ result: failed });
  });

  it("refreshes after a rejected call and shows a generic line for uncoded text (F26)", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(step({ lockedInRun: 1, lockedNow: 1 }))
      .mockRejectedValueOnce(new Error("socket hang up at 10.0.0.1"));
    const refresh = vi.fn(async () => undefined);

    const outcome = await runOpen("AY2026/27", call, noop, refresh);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ error: "Something went wrong. Try again." });
    const html = renderPeriod({
      actionError: "error" in outcome ? outcome.error : null,
    });
    expect(html).toContain("Something went wrong. Try again.");
    expect(html).not.toContain("socket");
  });

  it("keeps the coded refusals in plain words", async () => {
    const call = vi.fn().mockRejectedValue(new Error("ALREADY_PUBLISHED"));
    const outcome = await runOpen("AY2026/27", call, noop, async () => noop());
    expect(outcome).toEqual({
      error: "Transcripts for this academic year are already open.",
    });
  });
});

describe("the admin reminders, by date (time travel)", () => {
  const periods = (open: string[]) =>
    ["AY2026/27", "AY2027/28"].map((academicYear) => ({
      academicYear,
      status: open.includes(academicYear) ? "published" : "collecting",
    }));

  it("says nothing in October", () => {
    expect(
      panelReminders(
        periods([]),
        "AY2026/27",
        new Date("2026-10-15T00:00:00Z"),
      ),
    ).toEqual({ openReminder: null, previousYear: null });
  });

  it("reminds from 1 April to open the year", () => {
    expect(
      panelReminders(periods([]), "AY2026/27", new Date("2027-04-02T00:00:00Z"))
        .openReminder,
    ).toBe(
      "Transcripts for AY2026/27 are not open yet. Open them at the end of the year, before 1 August. After that, this year can no longer be opened from the app.",
    );
    expect(
      panelReminders(
        periods(["AY2026/27"]),
        "AY2026/27",
        new Date("2027-04-02T00:00:00Z"),
      ).openReminder,
    ).toBeNull();
  });

  it("warns from 1 August when the previous year was never opened", () => {
    const august = new Date("2027-08-05T00:00:00Z");
    expect(panelReminders(periods([]), "AY2027/28", august).previousYear).toBe(
      "Transcripts for AY2026/27 were never opened. This year can no longer be opened from the app, because CCA member lists have changed since August. Contact RHDevs.",
    );
    expect(
      panelReminders(periods(["AY2026/27"]), "AY2027/28", august).previousYear,
    ).toBeNull();
  });
});

/* ---- section b: volunteering CCAs ------------------------------------ */

const CCAS: TaggedCca[] = [
  {
    ccaID: 9001,
    ccaName: "RVC Special Projects",
    category: "Committees",
    isVolunteering: true,
  },
  {
    ccaID: 9002,
    ccaName: "RVC Children",
    category: "Committees",
    isVolunteering: true,
  },
  {
    ccaID: 9003,
    ccaName: "RVC Pioneers",
    category: "Committees",
    isVolunteering: true,
  },
  {
    ccaID: 9004,
    ccaName: "RVC Special Needs",
    category: "Committees",
    isVolunteering: true,
  },
  {
    ccaID: 9005,
    ccaName: "Soccer (MALE)",
    category: "Sports Activities",
    isVolunteering: false,
  },
];
const tags = (
  over: Partial<VolunteeringTagsViewProps> = {},
): VolunteeringTagsViewProps => ({
  ccas: CCAS,
  query: "",
  onQueryChange: noop,
  pendingID: null,
  error: null,
  onAdd: noop,
  confirmRemoveID: null,
  onConfirmRemove: noop,
  onRemove: noop,
  loadError: null,
  ...over,
});
const renderTags = (over?: Partial<VolunteeringTagsViewProps>) =>
  renderToStaticMarkup(<VolunteeringTagsView {...tags(over)} />);

describe("volunteering CCAs panel", () => {
  it("lists only the volunteering CCAs, with a count and a Remove button each", () => {
    const html = renderTags();

    for (const cca of CCAS.filter((c) => c.isVolunteering)) {
      expect(html).toContain(cca.ccaName);
      expect(html).toContain(`aria-label="Remove ${cca.ccaName}"`);
    }
    expect(html).not.toContain("Soccer (MALE)");
    expect(html).toContain("4 volunteering CCAs");
    expect(html.match(/>Remove</g)).toHaveLength(4);
    expect(html).not.toContain('role="switch"');
  });

  it("counts one in the singular", () => {
    expect(countLine(1)).toBe("1 volunteering CCA");
    expect(countLine(0)).toBe("0 volunteering CCAs");
    expect(countLine(4)).toBe("4 volunteering CCAs");
  });

  it("says so when there are none", () => {
    const html = renderTags({ ccas: CCAS.filter((c) => !c.isVolunteering) });

    expect(html).toContain("No volunteering CCAs yet.");
    expect(html).toContain("0 volunteering CCAs");
  });

  it("suggests only untagged CCAs, from two characters, by name or category", () => {
    expect(suggestCcas(CCAS, "").map((c) => c.ccaID)).toEqual([]);
    expect(suggestCcas(CCAS, "s").map((c) => c.ccaID)).toEqual([]);
    expect(suggestCcas(CCAS, "so").map((c) => c.ccaID)).toEqual([9005]);
    expect(suggestCcas(CCAS, "SPORTS").map((c) => c.ccaID)).toEqual([9005]);
    // a tagged CCA is never suggested
    expect(suggestCcas(CCAS, "rvc")).toEqual([]);
    expect(suggestCcas(CCAS, "  so  ").map((c) => c.ccaID)).toEqual([9005]);
  });

  it("limits the suggestions to eight", () => {
    const many: TaggedCca[] = Array.from({ length: 20 }, (_, i) => ({
      ccaID: i + 1,
      ccaName: `Club ${i}`,
      category: "Clubs",
      isVolunteering: false,
    }));

    expect(suggestCcas(many, "club")).toHaveLength(8);
  });

  it("shows the suggestions with an Add action, and the hint before two characters", () => {
    const html = renderTags({ query: "soc" });
    expect(html).toContain("Soccer (MALE)");
    expect(html).toContain(">Add<");
    expect(renderTags({ query: "s" })).toContain(
      "Type at least 2 characters to search.",
    );
    expect(renderTags({ query: "zzz" })).toContain("No CCAs to add match.");
    expect(taggedCcas(CCAS)).toHaveLength(4);
  });

  it("words the confirmation exactly, and keeps it out of the page until asked", () => {
    // The dialog itself is a portal, which a static render does not draw.
    expect(REMOVE_CONFIRMATION).toBe(
      "Its heads will no longer be able to record new hours. Hours already recorded stay on residents’ transcripts.",
    );
    expect(renderTags()).not.toContain("no longer be able to record");
  });

  it("shows a saving state and disables only that CCA's Remove", () => {
    const html = renderTags({ pendingID: 9002 });

    expect(html).toContain("Removing");
    const buttons = html.match(/<button[^>]*aria-label="Remove[^>]*>/g) ?? [];
    expect(buttons.filter((b) => b.includes(' disabled=""'))).toHaveLength(1);
  });

  it("shows a failed save beside that CCA, and a load error", () => {
    const html = renderTags({
      error: { ccaID: 9002, message: "That CCA no longer exists." },
      loadError: "Something went wrong. Try again.",
    });

    expect(html).toContain("That CCA no longer exists.");
    expect(html).toContain("Something went wrong. Try again.");
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });

  it("shows a failed add under the search box", () => {
    const html = renderTags({
      query: "soc",
      error: { ccaID: 9005, message: "That CCA no longer exists." },
    });

    expect(html).toContain("That CCA no longer exists.");
  });
});

/* ---- section c: awards (a summary; the screens live under /awards) ------ */

const renderAwards = (over: Partial<AwardsSummaryViewProps> = {}) =>
  renderToStaticMarkup(
    <AwardsSummaryView
      academicYear="AY2026/27"
      count={4}
      error={null}
      {...over}
    />,
  );

describe("awards summary", () => {
  it("counts the year's awards and links to the awards screens", () => {
    const html = renderAwards();

    expect(html).toContain("4 awards for AY2026/27.");
    expect(html).toContain('href="/admin/transcripts/awards"');
    expect(html).toContain("Manage awards");
  });

  it("uses the singular, and says so while loading or on an error", () => {
    expect(renderAwards({ count: 1 })).toContain("1 award for AY2026/27.");
    expect(renderAwards({ count: null })).toContain("Loading.");
    expect(renderAwards({ error: "Nope." })).toContain('role="alert"');
  });
});

/* ---- the resident picker --------------------------------------------- */

const HIT: PickedResident = {
  userID: "SEED-R12",
  displayName: "Seed Resident 12",
  maskedMatric: "A*****00X",
};
const pickerProps = (
  over: Partial<Parameters<typeof ResidentPickerView>[0]> = {},
) => ({
  idPrefix: "t",
  label: "Resident",
  query: "",
  onQueryChange: noop,
  status: "short" as const,
  hits: [],
  error: null,
  selected: null,
  onSelect: noop,
  onClear: noop,
  ...over,
});
const renderPicker = (
  over?: Partial<Parameters<typeof ResidentPickerView>[0]>,
) => renderToStaticMarkup(<ResidentPickerView {...pickerProps(over)} />);

describe("resident picker", () => {
  it("asks for at least 3 characters before searching", () => {
    expect(renderPicker()).toContain("Type at least 3 characters to search.");
  });

  it("shows loading, empty and error states", () => {
    expect(renderPicker({ status: "loading", query: "see" })).toContain(
      "Searching.",
    );
    expect(renderPicker({ status: "empty", query: "zzz" })).toContain(
      "No residents match.",
    );
    const html = renderPicker({
      status: "error",
      error: "You do not have access to this.",
    });
    expect(html).toContain("You do not have access to this.");
    expect(html).toContain('role="alert"');
  });

  it("lists results with the masked matric only", () => {
    const html = renderPicker({
      status: "results",
      hits: [HIT],
      query: "seed",
    });

    expect(html).toContain("Seed Resident 12");
    expect(html).toContain("A*****00X");
    expect(html).not.toContain("A9912000X");
  });

  it("shows the chosen resident with a Change button instead of the search box", () => {
    const html = renderPicker({ selected: HIT });

    expect(html).toContain("Seed Resident 12");
    expect(html).toContain("Change");
    expect(html).not.toContain('type="search"');
  });
});

/* ---- section d: preview ---------------------------------------------- */

describe("preview picker", () => {
  it("builds a preview address with the userID encoded and the year in URL form", () => {
    expect(previewHref("SEED-R12", "AY2026/27")).toBe(
      "/admin/transcripts/preview/SEED-R12?ay=2026-27",
    );
    expect(previewHref("A B/C", "AY2027/28")).toBe(
      "/admin/transcripts/preview/A%20B%2FC?ay=2027-28",
    );
  });

  it("shows a hint until a resident is chosen, then a link", () => {
    const view = (href: string | null) =>
      renderToStaticMarkup(
        <PreviewPickerView
          years={["AY2026/27"]}
          year="AY2026/27"
          onYear={noop}
          picker={<span>picker</span>}
          href={href}
        />,
      );

    expect(view(null)).toContain("Choose a resident to open a preview.");
    expect(view(null)).not.toContain("Open preview");
    const withLink = view("/admin/transcripts/preview/SEED-R12?ay=2026-27");
    expect(withLink).toContain("Open preview");
    expect(withLink).toContain(
      'href="/admin/transcripts/preview/SEED-R12?ay=2026-27"',
    );
    expect(withLink).toContain(
      "Nothing is issued and residents cannot see it.",
    );
  });
});

describe("no screen shows a bare matric except the search results", () => {
  it("renders none in the award list, the year panel or the volunteering list", () => {
    const html = [renderAwards(), renderPeriod(), renderTags()].join("\n");

    expect(html).not.toMatch(/A99\d{2}000X/);
  });

  it("does not log anything while rendering", () => {
    const log = vi.spyOn(console, "log").mockImplementation(noop);
    renderAwards();
    renderPicker({ status: "results", hits: [HIT] });

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("download-by date", () => {
  it("shows the saved date and stays editable while the year is published", () => {
    const html = renderPeriod({
      status: "published",
      downloadByValue: "2027-12-31",
      downloadByDirty: true,
    });

    expect(html).toContain('id="transcripts-download-by"');
    expect(html).toContain('value="2027-12-31"');
    const field = /<input[^>]*id="transcripts-download-by"[^>]*>/.exec(
      html,
    )![0];
    expect(field).not.toMatch(/\sdisabled=""/);
    expect(html).toContain("Download by");
  });

  it("keeps Save disabled until the date changes, and shows an API error inline", () => {
    const clean = renderPeriod({ downloadByDirty: false });
    const saveButtons = clean.match(/<button[^>]*type="submit"[^>]*>/g) ?? [];
    expect(saveButtons.some((b) => /\sdisabled=""/.test(b))).toBe(true);

    const html = renderPeriod({ downloadByError: "Enter a real date." });
    expect(html).toContain("Enter a real date.");
    expect(html).toContain('role="alert"');
  });
});

describe("resident picker as an ARIA combobox", () => {
  const HITS: PickedResident[] = [
    {
      userID: "SEED-R12",
      displayName: "Seed Resident 12",
      maskedMatric: "A*****00X",
    },
    {
      userID: "SEED-R13",
      displayName: "Seed Resident 13",
      maskedMatric: "A*****00X",
    },
  ];
  const listed = (combo = { open: true, active: -1 }) =>
    renderPicker({ status: "results", hits: HITS, query: "seed", combo });

  it("marks the input as a combobox that controls the listbox", () => {
    const html = listed();

    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="t-listbox"');
    expect(html).toContain('aria-autocomplete="list"');
    expect(html).toContain('id="t-listbox"');
    expect(html).toContain('role="listbox"');
  });

  it("marks each result as an option, selected only for the active one", () => {
    const html = listed({ open: true, active: 1 });

    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('id="t-option-0"');
    expect(html).toContain('id="t-option-1"');
    expect(html).toMatch(/id="t-option-0"[^>]*aria-selected="false"/);
    expect(html).toMatch(/id="t-option-1"[^>]*aria-selected="true"/);
    expect(html).toContain('aria-activedescendant="t-option-1"');
  });

  it("has no active descendant when nothing is active", () => {
    expect(listed()).not.toContain("aria-activedescendant");
  });

  it("is collapsed with no listbox when closed, or with no results", () => {
    const closed = listed({ open: false, active: -1 });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('role="listbox"');
    expect(closed).not.toContain("aria-activedescendant");

    const none = renderPicker({ status: "empty", query: "zzz" });
    expect(none).toContain('aria-expanded="false"');
    expect(none).not.toContain('role="listbox"');
  });

  it("announces the number of results in the existing live line", () => {
    expect(listed()).toContain(
      "2 results. Use the up and down arrow keys, then Enter.",
    );
    const one = renderPicker({
      status: "results",
      hits: HITS.slice(0, 1),
      combo: { open: true, active: -1 },
    });
    expect(one).toContain("1 result. Use the up and down arrow keys");
  });

  it("uses the placeholder for the caller: a manager searches name, email or matric, a head name", () => {
    expect(renderPicker()).toContain('placeholder="Name, email or matric"');
    expect(renderPicker({ placeholder: "Name" })).toContain(
      'placeholder="Name"',
    );
    expect(renderPicker({ placeholder: "Name" })).not.toContain(
      "email or matric",
    );
  });

  it("shows only the masked matric on a result", () => {
    const html = listed();

    expect(html).toContain("A*****00X");
    expect(html).not.toMatch(/A99\d{2}000X/);
  });
});
