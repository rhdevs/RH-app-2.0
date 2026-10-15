import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The app header's entry point to the transcript. The menus open on a click, so
 * a static render covers what is visible at rest: the dot on the profile button
 * and whether the readiness question is asked at all.
 */
const useSession = vi.fn();
const useQuery = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => useSession(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: object) => <img {...(props as Record<string, string>)} />,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    transcript: {
      mine: { readiness: { useQuery: (...a: unknown[]) => useQuery(...a) } },
    },
  },
}));

const { default: Header } = await import("~/app/_components/header");

const render = () => renderToStaticMarkup(<Header currentPage="Home" />);

describe("header: My transcript entry", () => {
  beforeEach(() => {
    useSession.mockReset();
    useQuery.mockReset();
  });

  it("shows a dot and a screen-reader line on the profile button when a transcript is ready", () => {
    useSession.mockReturnValue({ data: { user: { name: "Sam" } } });
    useQuery.mockReturnValue({
      data: { ready: true, academicYear: "AY2026/27" },
    });

    const html = render();

    expect(html).toContain("Your transcript is ready");
    expect(html).toContain("bg-amber-400");
  });

  it("shows no dot when nothing is waiting", () => {
    useSession.mockReturnValue({ data: { user: { name: "Sam" } } });
    useQuery.mockReturnValue({ data: { ready: false, academicYear: null } });

    expect(render()).not.toContain("Your transcript is ready");
  });

  it("shows no dot while the answer is still loading, or if it failed", () => {
    useSession.mockReturnValue({ data: { user: { name: "Sam" } } });
    useQuery.mockReturnValue({ data: undefined });

    expect(render()).not.toContain("Your transcript is ready");
  });

  it("never asks for a signed-out visitor, and shows nothing", () => {
    useSession.mockReturnValue({ data: null });
    useQuery.mockReturnValue({ data: undefined });

    const html = render();

    expect(useQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
    expect(html).not.toContain("Your transcript is ready");
  });

  it("asks only when signed in, once a minute at most", () => {
    useSession.mockReturnValue({ data: { user: { name: "Sam" } } });
    useQuery.mockReturnValue({ data: undefined });

    render();

    expect(useQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        enabled: true,
        retry: false,
        staleTime: 60_000,
      }),
    );
  });
});
