import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The /admin/transcripts segment gate. The layout is a server component that
 * reads the session and a LIVE role list, so the collaborators are replaced: no
 * database and no app environment are needed. `redirect` throws, as Next's does.
 */
const auth = vi.fn();
const getUserRoles = vi.fn();

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("~/server/auth", () => ({ auth: () => auth() }));
vi.mock("~/server/db", () => ({ db: {} }));
vi.mock("~/server/api/services/access", () => ({
  getUserRoles: (...args: unknown[]) => getUserRoles(...args),
}));
const flag = vi.hoisted(() => ({ on: true }));
vi.mock("~/server/api/services/transcript/flag", () => ({
  isTranscriptEnabled: async () => flag.on,
}));

const { default: Layout } = await import("../layout");

const outcome = async (): Promise<string> => {
  try {
    const page = await Layout({ children: "CHILDREN" });
    if (page.props.children !== "CHILDREN") return "switched off";
    return "rendered";
  } catch (error) {
    return (error as Error).message;
  }
};

describe("/admin/transcripts layout gate", () => {
  beforeEach(() => {
    auth.mockReset();
    getUserRoles.mockReset();
  });

  it("sends a signed-out visitor to sign in", async () => {
    auth.mockResolvedValue(null);

    expect(await outcome()).toBe("REDIRECT:/login");
    expect(getUserRoles).not.toHaveBeenCalled();
  });

  it.each([
    ["a plain resident", ["resident"]],
    ["a CCA head", ["resident", "cca_head"]],
    ["hall office (scrc)", ["scrc"]],
    ["someone with no roles", []],
  ])("turns away %s", async (_who, roles) => {
    auth.mockResolvedValue({ user: { userID: "SEED-R09" } });
    getUserRoles.mockResolvedValue(roles);

    expect(await outcome()).toBe("REDIRECT:/admin");
  });

  it.each([
    ["jcrc", ["resident", "jcrc"]],
    ["admin", ["admin", "resident"]],
    ["jcrc who also heads a CCA", ["jcrc", "cca_head", "resident"]],
  ])("admits %s", async (_who, roles) => {
    auth.mockResolvedValue({ user: { userID: "SEED-R02" } });
    getUserRoles.mockResolvedValue(roles);

    expect(await outcome()).toBe("rendered");
  });

  it("decides from a live role read of the session's user, not from the session's own roles", async () => {
    auth.mockResolvedValue({
      user: { userID: "SEED-R09", roles: ["admin", "jcrc"] },
    });
    getUserRoles.mockResolvedValue(["resident"]);

    expect(await outcome()).toBe("REDIRECT:/admin");
    expect(getUserRoles).toHaveBeenCalledWith({}, "SEED-R09");
  });

  it("shows the switched-off note to a manager while transcripts are off, and stays a gate", async () => {
    auth.mockResolvedValue({ user: { userID: "SEED-R02" } });
    flag.on = false;
    try {
      getUserRoles.mockResolvedValue(["jcrc", "resident"]);
      expect(await outcome()).toBe("switched off");
      const html = renderToStaticMarkup(await Layout({ children: "CHILDREN" }));
      expect(html).toContain("Transcripts are not available yet.");
      expect(html).toContain("transcript.enabled");
      expect(html).not.toContain("CHILDREN");
      // A resident is still turned away first.
      getUserRoles.mockResolvedValue(["resident"]);
      expect(await outcome()).toBe("REDIRECT:/admin");
    } finally {
      flag.on = true;
    }
  });

  it("fails closed when the role read fails", async () => {
    auth.mockResolvedValue({ user: { userID: "SEED-R02" } });
    getUserRoles.mockRejectedValue(new Error("database down"));

    expect(await outcome()).toBe("REDIRECT:/admin");
  });
});
