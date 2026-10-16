import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EMPTY_JCRC,
  JcrcSelfView,
  type JcrcSelfViewProps,
} from "../_components/JcrcSelf";
import type { ContributionDraft } from "~/lib/transcript/headView";

const auth = vi.fn();
const getUserRoles = vi.fn();
vi.mock("~/server/auth", () => ({ auth: () => auth() }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/services/access", () => ({
  getUserRoles: (...args: unknown[]) => getUserRoles(...args) as unknown,
}));
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

  const row = (over: Partial<ContributionDraft> = {}): ContributionDraft => ({
    activity: "Ran orientation",
    role: "Lead",
    description: "Ran the week.",
    removed: false,
    ...over,
  });

  it("shows one card per contribution with its three fields and counters", () => {
    const html = render({
      draft: {
        ...EMPTY_JCRC,
        contributions: [row(), row({ activity: "Ran quiz", role: "" })],
      },
    });

    expect(html).toContain("Ran orientation");
    expect(html).toContain('id="jcrc-activity-0"');
    expect(html).toContain('id="jcrc-role-1"');
    expect(html).toContain('id="jcrc-contribution-description-1"');
    expect(html).toContain('maxLength="80"');
    expect(html).toContain('maxLength="60"');
    expect(html).toContain('maxLength="300"');
    expect(html).toContain("65 characters left"); // activity "Ran orientation" is 15
    expect(html).toContain("2 of 10");
  });

  it("offers Move up, Move down and Remove, disabling a move that has nowhere to go", () => {
    const html = render({
      draft: { ...EMPTY_JCRC, contributions: [row(), row({ activity: "B" })] },
    });
    const button = (label: string) =>
      html.match(new RegExp(`<button\\b[^>]*>[^<]*${label}`, "g")) ?? [];

    expect(button("Move up")).toHaveLength(2);
    expect(button("Move down")).toHaveLength(2);
    expect(button("Remove")).toHaveLength(2);
    expect(button("Move up")[0]).toMatch(/\sdisabled=""/);
    expect(button("Move up")[1]).not.toMatch(/\sdisabled=""/);
    expect(button("Move down")[1]).toMatch(/\sdisabled=""/);
  });

  it("shows a removed row as Removed with Undo, until Save", () => {
    const html = render({
      draft: {
        ...EMPTY_JCRC,
        contributions: [row({ removed: true }), row({ activity: "Kept" })],
      },
    });

    expect(html).toContain("Removed. Ran orientation");
    expect(html).toContain(">Undo<");
    expect(html).toContain("1 of 10");
  });

  it("stops adding at ten and says how many there are", () => {
    const full = render({
      draft: {
        ...EMPTY_JCRC,
        contributions: Array.from({ length: 10 }, (_, i) =>
          row({ activity: `c${i}` }),
        ),
      },
    });
    const add = (full.match(
      /<button\b[^>]*>(?:(?!<\/button>).)*Add contribution/g,
    ) ?? [])[0];

    expect(add).toMatch(/\sdisabled=""/);
    expect(full).toContain("10 of 10");
  });

  it("asks for an activity on every row before saving", () => {
    const html = render({
      draft: { ...EMPTY_JCRC, contributions: [row({ activity: "  " })] },
    });

    expect(html).toContain("Each contribution needs an activity.");
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
      draft: {
        ...EMPTY_JCRC,
        contributions: [
          {
            activity: "Ran orientation",
            role: "",
            description: "",
            removed: false,
          },
        ],
      },
    });

    expect(html).toContain(
      "Transcripts for AY2026/27 are published. Editing is closed. Ask the JCRC to reopen it.",
    );
    expect(html).not.toContain(">Save<");
    expect(html).not.toContain("Add contribution");
    expect(html).not.toContain("Remove contribution");
    expect(disabledTags(html, "input")).toHaveLength(4);
    expect(disabledTags(html, "textarea")).toHaveLength(3);
  });

  it("uses plain wording", () => {
    const html = render({ readOnly: true });
    expect(html).not.toContain("!");
    expect(html).not.toMatch(/successfully/i);
  });
});

describe("JCRC self page gate", () => {
  beforeEach(() => {
    auth.mockReset();
    getUserRoles.mockReset();
  });

  it("sends a signed-out visitor to sign in", async () => {
    auth.mockResolvedValue(null);
    const { default: Page } = await import("../jcrc/page");

    await expect(Page()).rejects.toThrow("REDIRECT:/login");
  });

  it("renders for a signed-in user, deciding membership from the live jcrc role", async () => {
    auth.mockResolvedValue({ user: { userID: "SEED-R01" } });
    const { default: Page } = await import("../jcrc/page");

    getUserRoles.mockResolvedValue(["admin"]);
    const admin = (await Page()) as { props: { children: unknown[] } };
    expect(JSON.stringify(admin.props.children[1])).toContain(
      '"isMember":false',
    );

    getUserRoles.mockResolvedValue(["jcrc", "resident"]);
    const member = (await Page()) as { props: { children: unknown[] } };
    expect(JSON.stringify(member.props.children[1])).toContain(
      '"isMember":true',
    );
    expect(getUserRoles).toHaveBeenCalledWith({}, "SEED-R01");
  });
});
