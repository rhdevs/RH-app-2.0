import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_JCRC,
  JcrcSelfView,
  type JcrcSelfViewProps,
} from "../_components/JcrcSelf";

const auth = vi.fn();
vi.mock("~/server/auth", () => ({ auth: () => auth() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));

const noop = () => undefined;

const props = (over: Partial<JcrcSelfViewProps> = {}): JcrcSelfViewProps => ({
  academicYear: "AY2026/27",
  years: ["AY2026/27"],
  onYear: noop,
  readOnly: false,
  draft: EMPTY_JCRC,
  onDraft: noop,
  onSave: noop,
  saving: false,
  saved: false,
  dirty: false,
  error: null,
  fieldErrors: {},
  previewUrl: "/admin/transcripts/preview/SEED-R02?ay=2026-27",
  ...over,
});
const render = (over?: Partial<JcrcSelfViewProps>) =>
  renderToStaticMarkup(<JcrcSelfView {...props(over)} />);

const disabledTags = (html: string, tag: string) =>
  (html.match(new RegExp(`<${tag}\\b[^>]*>`, "g")) ?? []).filter((t) =>
    /\sdisabled=""/.test(t),
  );

describe("JCRC self page", () => {
  it("shows every field with its server limit", () => {
    const html = render();

    for (const label of [
      "Portfolio",
      "Position",
      "What this role covers",
      "Contributions during the year",
      "Testimonial",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('maxLength="800"');
    expect(html).toContain('maxLength="1500"');
  });

  it("counts characters left on the two long fields", () => {
    const html = render({
      draft: {
        ...EMPTY_JCRC,
        description: "d".repeat(100),
        testimonial: "t".repeat(500),
      },
    });

    expect(html).toContain("700 characters left");
    expect(html).toContain("1000 characters left");
  });

  it("states that the signatures are placeholders, in one line", () => {
    expect(render()).toContain(
      "The Master and President signatures on your JCRC page are placeholders for now.",
    );
  });

  it("links to the preview of the user's own transcript", () => {
    const html = render();
    expect(html).toContain("Preview my transcript");
    expect(html).toContain(
      'href="/admin/transcripts/preview/SEED-R02?ay=2026-27"',
    );
  });

  it("lists contributions with a remove control, up to ten", () => {
    const some = render({
      draft: { ...EMPTY_JCRC, contributions: ["Ran orientation", "Ran quiz"] },
    });
    expect(some).toContain("Ran orientation");
    expect(some).toContain("Remove contribution 2");
    expect(some).toContain("2 of 10, up to 200 characters each");
    expect(some).toContain('maxLength="200"');

    const full = render({
      draft: {
        ...EMPTY_JCRC,
        contributions: Array.from({ length: 10 }, (_, i) => `c${i}`),
      },
    });
    const add = (full.match(
      /<button\b[^>]*>(?:(?!<\/button>).)*Add contribution/g,
    ) ?? [])[0];
    expect(add).toMatch(/\sdisabled=""/);
  });

  it("says when no contributions have been added", () => {
    expect(render()).toContain("No contributions added.");
  });

  it("keeps Save disabled until something changes", () => {
    expect(render()).toMatch(
      /<button[^>]*\sdisabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*\sdisabled=""/,
    );
    const dirty = render({ dirty: true });
    expect(
      disabledTags(dirty, "button").some((t) => t.includes('type="submit"')),
    ).toBe(false);
  });

  it("shows the saved indicator and inline errors", () => {
    expect(render({ saved: true })).toContain(">Saved<");
    const html = render({
      error: "Something went wrong. Try again.",
      fieldErrors: { testimonial: "Use at most 1500 characters." },
    });
    expect(html).toContain("Something went wrong. Try again.");
    expect(html).toContain("Use at most 1500 characters.");
    expect(html).toContain('role="alert"');
  });

  it("is read-only once published: note shown, no Save, fields disabled", () => {
    const html = render({
      readOnly: true,
      draft: { ...EMPTY_JCRC, contributions: ["Ran orientation"] },
    });

    expect(html).toContain(
      "Transcripts for AY2026/27 are published. Editing is closed. Ask the JCRC to reopen it.",
    );
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain("Add contribution");
    expect(html).not.toContain("Remove contribution");
    expect(disabledTags(html, "input")).toHaveLength(3);
    expect(disabledTags(html, "textarea")).toHaveLength(2);
  });

  it("uses plain wording", () => {
    const html = render({ readOnly: true });
    expect(html).not.toContain("!");
    expect(html).not.toMatch(/successfully/i);
  });
});

describe("JCRC self page gate", () => {
  beforeEach(() => auth.mockReset());

  it("sends a signed-out visitor to sign in", async () => {
    auth.mockResolvedValue(null);
    const { default: Page } = await import("../jcrc/page");

    await expect(Page()).rejects.toThrow("REDIRECT:/login");
  });

  it("renders for a signed-in user; membership is decided by the API", async () => {
    auth.mockResolvedValue({ user: { userID: "SEED-R01" } });
    const { default: Page } = await import("../jcrc/page");

    await expect(Page()).resolves.toBeTruthy();
  });
});
