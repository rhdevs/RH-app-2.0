import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AwardsPanelView,
  CITATION_MAX,
  TITLE_MAX,
  type AwardRowView,
  type AwardsPanelViewProps,
} from "../_components/AwardsPanel";
import {
  PeriodPanelView,
  type PeriodPanelViewProps,
} from "../_components/PeriodPanel";
import { PreviewPickerView, previewHref } from "../_components/PreviewPicker";
import {
  ResidentPickerView,
  type PickedResident,
} from "../_components/ResidentPicker";
import {
  VolunteeringTagsView,
  filterCcas,
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
  publishedLine: null,
  sem2Value: "2027-01-11",
  onSem2Change: noop,
  sem2Dirty: false,
  onSaveSem2: noop,
  saving: false,
  saveError: null,
  confirming: null,
  onConfirming: noop,
  onPublish: noop,
  onReopen: noop,
  publishing: false,
  reopening: false,
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
  it("offers Publish, and not Reopen, while the year is collecting", () => {
    const html = renderPeriod();

    expect(html).toContain("Academic year");
    expect(html).toContain("Collecting");
    expect(html).toContain("Publish AY2026/27");
    expect(html).not.toContain("Reopen AY2026/27");
    expect(html).toContain('value="2027-01-11"');
  });

  it("offers Reopen, and not Publish, once published, and locks the date", () => {
    const html = renderPeriod({
      status: "published",
      publishedLine: "Published on 15 Oct 2026 by SEED-R02.",
    });

    expect(html).toContain("Published");
    expect(html).toContain("Reopen AY2026/27");
    expect(html).not.toContain("Publish AY2026/27");
    expect(html).toContain("Published on 15 Oct 2026 by SEED-R02.");
    expect(html).toMatch(/<input[^>]*id="transcripts-sem2"[^>]*\sdisabled=""/);
  });

  it("treats a year with no period yet as collecting, with an empty date", () => {
    const html = renderPeriod({ status: null, sem2Value: "" });

    expect(html).toContain("Collecting");
    expect(html).toContain("Publish AY2026/27");
    expect(html).toMatch(/<input[^>]*id="transcripts-sem2"[^>]*value=""/);
  });

  it("states the Singapore-midnight rule beside the date", () => {
    expect(renderPeriod()).toContain("midnight Singapore time");
  });

  it("disables Save until the date has changed", () => {
    expect(renderPeriod({ sem2Dirty: false })).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>Save</,
    );
    expect(
      renderPeriod({ sem2Dirty: true, downloadByDirty: true }),
    ).not.toMatch(
      /<button[^>]*\sdisabled=""[^>]*>Save</,
    );
  });

  it("shows the result of an action in words, and an error as an alert", () => {
    const html = renderPeriod({
      resultLine:
        "AY2026/27 published. 64 members frozen, 0 rows could not be matched.",
      actionError: "Set the semester 2 start date before publishing.",
    });

    expect(html).toContain("64 members frozen, 0 rows could not be matched.");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Set the semester 2 start date before publishing.");
  });

  it("shows a save error inline", () => {
    const html = renderPeriod({
      saveError:
        "The semester 2 start date must fall inside the academic year.",
    });

    expect(html).toContain("must fall inside the academic year");
  });

  it("lists every year offered, newest first as given", () => {
    const html = renderPeriod();

    expect(html.indexOf("AY2027/28")).toBeLessThan(
      html.indexOf('value="AY2026/27"'),
    );
    expect(html).toContain('<option value="AY2026/27" selected');
  });

  it("uses sentence case and no exclamation marks or the word successfully", () => {
    const html = renderPeriod({ status: "published" });
    const text = html.replace(/<[^>]*>/g, " ");

    expect(text).not.toContain("!");
    expect(text.toLowerCase()).not.toContain("successfully");
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
  onToggle: noop,
  loadError: null,
  ...over,
});
const renderTags = (over?: Partial<VolunteeringTagsViewProps>) =>
  renderToStaticMarkup(<VolunteeringTagsView {...tags(over)} />);

describe("volunteering CCAs panel", () => {
  it("shows every CCA with the four RVC CCAs switched on", () => {
    const html = renderTags();

    for (const cca of CCAS) expect(html).toContain(cca.ccaName);
    expect(html.match(/role="switch"[^>]*aria-checked="true"/g)).toHaveLength(
      4,
    );
    expect(html.match(/role="switch"[^>]*aria-checked="false"/g)).toHaveLength(
      1,
    );
    expect(html).toContain("4 of 5 CCAs marked as volunteering.");
  });

  it("filters by name or category, ignoring case", () => {
    expect(filterCcas(CCAS, "rvc children").map((c) => c.ccaID)).toEqual([
      9002,
    ]);
    expect(filterCcas(CCAS, "SPORTS").map((c) => c.ccaID)).toEqual([9005]);
    expect(filterCcas(CCAS, "  ").length).toBe(5);

    const html = renderTags({ query: "soccer" });
    expect(html).toContain("Soccer (MALE)");
    expect(html).not.toContain("RVC Children");
  });

  it("says so when nothing matches", () => {
    expect(renderTags({ query: "zzz" })).toContain("No CCAs match.");
  });

  it("shows an empty hall without breaking", () => {
    const html = renderTags({ ccas: [] });

    expect(html).toContain("0 of 0 CCAs marked as volunteering.");
    expect(html).toContain("No CCAs match.");
  });

  it("shows a saving state and disables only that CCA's switch", () => {
    const html = renderTags({ pendingID: 9005 });

    expect(html).toContain("Saving");
    expect(html.match(/role="switch"[^>]*\sdisabled=""/g)).toHaveLength(1);
  });

  it("shows a failed save beside that CCA, and a load error", () => {
    const html = renderTags({
      error: { ccaID: 9005, message: "That CCA no longer exists." },
      loadError: "Something went wrong. Try again.",
    });

    expect(html).toContain("That CCA no longer exists.");
    expect(html).toContain("Something went wrong. Try again.");
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });
});

/* ---- section c: awards ----------------------------------------------- */

const AWARDS: AwardRowView[] = [
  {
    id: "a1",
    residentName: "Seed Resident 04",
    title: "Colours Award, Soccer",
    citation: "Led the team.",
    recordedBy: "SEED-R02",
    voided: false,
  },
  {
    id: "a2",
    residentName: "Seed Resident 12",
    title: "Recorded in error",
    citation: null,
    recordedBy: "SEED-R02",
    voided: true,
  },
];
const awards = (
  over: Partial<AwardsPanelViewProps> = {},
): AwardsPanelViewProps => ({
  years: ["AY2026/27"],
  year: "AY2026/27",
  onYear: noop,
  status: "collecting",
  picker: <div data-testid="picker">picker</div>,
  hasResident: true,
  title: "Service Excellence",
  onTitle: noop,
  citation: "",
  onCitation: noop,
  onAdd: noop,
  adding: false,
  addError: null,
  titleError: null,
  citationError: null,
  awards: AWARDS,
  loadingAwards: false,
  listError: null,
  showVoided: false,
  onShowVoided: noop,
  confirmVoidId: null,
  onConfirmVoid: noop,
  onVoid: noop,
  voiding: false,
  voidError: null,
  ...over,
});
const renderAwards = (over?: Partial<AwardsPanelViewProps>) =>
  renderToStaticMarkup(<AwardsPanelView {...awards(over)} />);

describe("awards panel", () => {
  it("shows the award form and the year's awards while collecting", () => {
    const html = renderAwards();

    expect(html).toContain("Award title");
    expect(html).toContain("Citation (optional)");
    expect(html).toContain("Awards for AY2026/27");
    expect(html).toContain("Colours Award, Soccer");
    expect(html).toContain("Seed Resident 04");
    expect(html).toContain("Recorded by SEED-R02");
    expect(html).not.toContain("changes are locked");
  });

  it("uses the server's length limits on both inputs", () => {
    const html = renderAwards();

    expect(TITLE_MAX).toBe(120);
    expect(CITATION_MAX).toBe(300);
    expect(html).toMatch(/id="award-title"[^>]*maxLength="120"/);
    expect(html).toMatch(/id="award-citation"[^>]*maxLength="300"/);
  });

  it("only enables Add when a resident and a title are present", () => {
    const addDisabled = (over: Partial<AwardsPanelViewProps>) =>
      /<button[^>]*\sdisabled=""[^>]*>Add award</.test(renderAwards(over));

    expect(addDisabled({})).toBe(false);
    expect(addDisabled({ hasResident: false })).toBe(true);
    expect(addDisabled({ title: "   " })).toBe(true);
    // While adding, the button shows its progress word and stays disabled.
    expect(renderAwards({ adding: true })).toMatch(
      /<button[^>]*\sdisabled=""[^>]*>(?:(?!<\/button>).)*Adding/s,
    );
  });

  it("locks the form with an explanation while the year is published", () => {
    const html = renderAwards({ status: "published" });

    expect(html).toContain(
      "This academic year is published, so changes are locked.",
    );
    expect(html).toMatch(/id="award-title"[^>]*\sdisabled=""/);
    expect(html).toMatch(/id="award-citation"[^>]*\sdisabled=""/);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Add award</);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>Void</);
  });

  it("shows an empty year plainly", () => {
    expect(renderAwards({ awards: [] })).toContain(
      "No awards recorded for AY2026/27.",
    );
  });

  it("strikes through a voided award and gives it no Void button", () => {
    const html = renderAwards({ showVoided: true });

    expect(html).toContain("line-through");
    expect(html).toContain("Recorded in error");
    expect(html.match(/>Void</g)).toHaveLength(1); // only the live award
    expect(html).toContain("Voided");
  });

  it("shows field and form errors inline", () => {
    const html = renderAwards({
      titleError: "Use at most 120 characters.",
      citationError: "Remove any control characters.",
      addError: "No resident was found for that selection.",
      listError: "Something went wrong. Try again.",
    });

    expect(html).toContain("Use at most 120 characters.");
    expect(html).toContain("Remove any control characters.");
    expect(html).toContain("No resident was found for that selection.");
    expect(html).toContain("Something went wrong. Try again.");
    expect(html).toContain('aria-invalid="true"');
  });

  it("offers the 'show voided' toggle and a loading state", () => {
    expect(renderAwards()).toContain("Show voided");
    expect(renderAwards({ loadingAwards: true })).toContain("Loading awards.");
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
