import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every query the header makes, answered by one switchable stub.
const answers: Record<string, unknown> = {};
const optionsSeen: Record<string, unknown> = {};
const query = (name: string) => (_input: unknown, options: unknown) => {
  optionsSeen[name] = options;
  return answers[name] ?? { data: undefined };
};
const useSession = vi.fn();

vi.mock("next-auth/react", () => ({
  useSession: () => useSession(),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("next/image", () => ({
  default: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    transcript: {
      enabled: { useQuery: query("transcript.enabled") },
      mine: { readiness: { useQuery: query("transcript.readiness") } },
    },
    proposal: {
      directorEntry: { useQuery: query("directorEntry") },
    },
  },
}));

const { default: Header } = await import("~/app/_components/header");
const render = () => renderToStaticMarkup(<Header currentPage="Home" />);

describe("the Director navigation entry", () => {
  beforeEach(() => {
    for (const k of Object.keys(answers)) delete answers[k];
    useSession.mockReturnValue({
      data: { user: { userID: "E1", roles: ["resident"] } },
      status: "authenticated",
    });
  });

  it("is drawn only when the server says the person directs a CCA", () => {
    answers.directorEntry = { data: { show: true } };
    expect(render()).toContain("Director");

    answers.directorEntry = { data: { show: false } };
    expect(render()).not.toContain("Director");
  });

  it("is hidden while loading and when the read failed", () => {
    answers.directorEntry = { data: undefined, isLoading: true };
    expect(render()).not.toContain("Director");
    answers.directorEntry = { data: undefined, error: new Error("x") };
    expect(render()).not.toContain("Director");
  });

  it("does not come from the session's roles", () => {
    useSession.mockReturnValue({
      data: {
        user: { userID: "E1", roles: ["resident", "jcrc", "admin", "scrc"] },
      },
      status: "authenticated",
    });
    answers.directorEntry = { data: { show: false } };
    expect(render()).not.toContain("Director");
  });

  it("asks only once signed in", () => {
    useSession.mockReturnValue({ data: null, status: "unauthenticated" });
    render();
    expect((optionsSeen.directorEntry as { enabled: boolean }).enabled).toBe(
      false,
    );
  });
});
