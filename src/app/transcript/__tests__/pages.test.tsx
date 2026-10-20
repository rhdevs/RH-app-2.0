import { TRPCError } from "@trpc/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The resident page and the dev specimen page, in the node environment: the
 * collaborators (session, tRPC server caller, the drawn components) are
 * replaced, so what is tested is each page's DECISION. `redirect` and
 * `notFound` throw, as Next's do.
 */
const auth = vi.fn();
const years = vi.fn();
const get = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("~/server/auth", () => ({ auth: () => auth() }));
vi.mock("~/trpc/server", () => ({
  api: {
    transcript: {
      mine: {
        years: () => years(),
        get: (input: unknown) => get(input),
      },
    },
  },
}));
vi.mock("~/trpc/react", () => ({ api: {} }));
vi.mock("../_components/NotAvailable", () => ({
  NotAvailable: function NotAvailable() {
    return null;
  },
}));
vi.mock("../_components/OnHold", () => ({
  OnHold: function OnHold() {
    return null;
  },
}));
vi.mock("../_components/TranscriptFrame", () => ({
  TranscriptFrame: function TranscriptFrame() {
    return null;
  },
}));
vi.mock("../_components/YearSwitcher", () => ({
  YearSwitcher: function YearSwitcher() {
    return null;
  },
}));
vi.mock("../_components/MarkOpened", () => ({
  MarkOpened: function MarkOpened() {
    return null;
  },
}));
vi.mock("../_components/TranscriptPageShell", () => ({
  TranscriptPageShell: function TranscriptPageShell() {
    return null;
  },
}));

const { default: Page } = await import("../page");
const { default: PreviewPage } = await import("../preview/[fixture]/page");

/** Names of the components a page returned (a fragment's children too). */
function names(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const el = node as ReactElement<{ children?: unknown }>;
  const own = typeof el.type === "function" ? [el.type.name] : [];
  const kids = el.props?.children;
  const list = Array.isArray(kids) ? kids : kids ? [kids] : [];
  return [...own, ...list.flatMap(names)];
}

const outcome = async (searchParams: { ay?: string } = {}) => {
  try {
    return names(await Page({ searchParams }));
  } catch (error) {
    return (error as Error).message;
  }
};

describe("/transcript", () => {
  beforeEach(() => {
    auth.mockReset();
    years.mockReset();
    get.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-04-15T04:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a signed-out visitor to sign in", async () => {
    auth.mockResolvedValue(null);

    expect(await outcome()).toBe("REDIRECT:/login");
    expect(years).not.toHaveBeenCalled();
  });

  it("sends the visitor to sign in when the server says UNAUTHORIZED", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockRejectedValue(new TRPCError({ code: "UNAUTHORIZED" }));

    expect(await outcome()).toBe("REDIRECT:/login");
  });

  it("shows the calm not-available page while the year is collecting", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockResolvedValue([]);

    expect(await outcome()).toEqual(["NotAvailable"]);
    expect(get).not.toHaveBeenCalled();
  });

  it("shows nothing but not-available when the person has no canonical identity (FORBIDDEN)", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "NO_CANONICAL_IDENTITY" }),
    );

    expect(await outcome()).toEqual(["NotAvailable"]);
  });

  it("sends any other FORBIDDEN from years to the error path (F27)", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "SOMETHING_ELSE" }),
    );

    expect(await outcome()).toBe("SOMETHING_ELSE");
  });

  it("shows the switched-off words when the switch flips between years and get (F27)", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockResolvedValue(["AY2026/27"]);
    get.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "TRANSCRIPT_DISABLED" }),
    );

    const page = (await Page({ searchParams: {} })) as ReactElement<{
      notes?: { headline: string };
    }>;
    expect(names(page)).toEqual(["NotAvailable"]);
    expect(page.props.notes?.headline).toBe(
      "Transcripts are not available yet.",
    );
  });

  it("rethrows any other error from get (F27)", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockResolvedValue(["AY2026/27"]);
    get.mockRejectedValue(
      new TRPCError({ code: "PRECONDITION_FAILED", message: "NOPE" }),
    );

    expect(await outcome()).toBe("NOPE");
  });

  it("shows the calm page, with the switched-off words, while transcripts are off", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockRejectedValue(
      new TRPCError({ code: "FORBIDDEN", message: "TRANSCRIPT_DISABLED" }),
    );

    const page = (await Page({ searchParams: {} })) as ReactElement<{
      notes?: { headline: string };
    }>;
    expect(names(page)).toEqual(["NotAvailable"]);
    expect(page.props.notes?.headline).toBe(
      "Transcripts are not available yet.",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error instead of calling it 'not available'", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockRejectedValue(new Error("database is down"));

    expect(await outcome()).toBe("database is down");
  });

  it("shows only the hold when the hall office has withheld the transcript", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockResolvedValue(["AY2026/27"]);
    get.mockResolvedValue({ status: "on_hold", academicYear: "AY2026/27" });

    const shown = await outcome();

    expect(shown).toEqual(expect.arrayContaining(["OnHold"]));
    expect(shown).not.toContain("TranscriptFrame");
    expect(shown).not.toContain("MarkOpened");
  });

  it("shows the transcript, and notes the opening from the client, when it is ready", async () => {
    auth.mockResolvedValue({ user: { id: "x" } });
    years.mockResolvedValue(["AY2026/27"]);
    get.mockResolvedValue({
      status: "ready",
      academicYear: "AY2026/27",
      transcript: {},
      downloadBy: null,
    });

    const shown = await outcome();

    expect(shown).toEqual(
      expect.arrayContaining(["MarkOpened", "TranscriptFrame"]),
    );
  });
});

describe("/transcript/preview/[fixture]", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const preview = (fixture: string) => {
    try {
      return names(PreviewPage({ params: { fixture }, searchParams: {} }));
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("is a 404 in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(preview("plain-member")).toBe("NOT_FOUND");
  });

  it("renders a specimen in development", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(preview("plain-member")).toEqual(["TranscriptPageShell"]);
  });

  it("is a 404 for a specimen that does not exist", () => {
    vi.stubEnv("NODE_ENV", "development");

    expect(preview("no-such-specimen")).toBe("NOT_FOUND");
  });
});
