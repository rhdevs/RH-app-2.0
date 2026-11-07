import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQuery = vi.fn();
const useSession = vi.fn();

vi.mock("next-auth/react", () => ({ useSession: () => useSession() }));
vi.mock("~/trpc/react", () => ({
  api: {
    feedback: {
      enabled: { useQuery: (...a: unknown[]) => useQuery(...a) },
    },
  },
}));

const { default: FeedbackFooterLink } = await import(
  "~/app/_components/FeedbackFooterLink"
);

const render = () => renderToStaticMarkup(<FeedbackFooterLink />);
const optionsOfLastCall = () =>
  useQuery.mock.calls.at(-1)![1] as { enabled: boolean };

describe("the footer feedback link", () => {
  beforeEach(() => {
    useQuery.mockReset();
    useQuery.mockReturnValue({ data: { enabled: true } });
    useSession.mockReset();
  });

  it.each(["unauthenticated", "loading"])(
    "runs no query while the session is %s",
    (status) => {
      useSession.mockReturnValue({ status });
      useQuery.mockReturnValue({ data: undefined });

      expect(render()).toBe("");
      expect(optionsOfLastCall().enabled).toBe(false);
    },
  );

  it("runs the query once signed in, and shows the link only while the flag is on", () => {
    useSession.mockReturnValue({ status: "authenticated" });

    expect(render()).toContain('href="/feedback"');
    expect(optionsOfLastCall().enabled).toBe(true);

    useQuery.mockReturnValue({ data: { enabled: false } });
    expect(render()).toBe("");
    useQuery.mockReturnValue({ data: undefined, error: new Error("x") });
    expect(render()).toBe("");
  });
});
