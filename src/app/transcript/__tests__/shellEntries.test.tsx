import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Capabilities } from "~/server/api/services/roles";

/**
 * The admin "Transcripts" tab and the CCA "Transcript" tab show only while the
 * transcript switch is on: hidden when off, while the answer loads, and when it
 * fails. A static render covers what is visible at rest.
 */
const enabledQuery = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));
vi.mock("~/app/_components/header", () => ({ default: () => null }));
vi.mock("~/app/cca/_components/CcaSwitcher", () => ({ default: () => null }));
vi.mock("~/trpc/react", () => ({
  api: {
    transcript: {
      enabled: { useQuery: (...a: unknown[]) => enabledQuery(...a) },
    },
    cca: {
      listMine: {
        useQuery: () => ({ data: { ccas: [{ ccaID: 7, ccaName: "Club" }] } }),
      },
    },
  },
}));

const { default: AdminShell } = await import(
  "~/app/admin/_components/AdminShell"
);
const { default: CcaDashboardShell } = await import(
  "~/app/cca/_components/CcaDashboardShell"
);

const capabilities = {
  reachDashboard: true,
  manageCcaHeads: true,
} as unknown as Capabilities;

const admin = () =>
  renderToStaticMarkup(
    <AdminShell capabilities={capabilities}>content</AdminShell>,
  );
const cca = () =>
  renderToStaticMarkup(
    <CcaDashboardShell ccaID={7}>content</CcaDashboardShell>,
  );

const answers = [
  ["off", { data: { enabled: false } }],
  ["loading", { data: undefined }],
  ["failed", { data: undefined, error: new Error("x") }],
] as const;

describe("transcript entries in the admin and CCA shells", () => {
  beforeEach(() => enabledQuery.mockReset());

  it.each(answers)("hide both entries while the switch is %s", (_n, answer) => {
    enabledQuery.mockReturnValue(answer);

    expect(admin()).not.toContain("Transcripts");
    expect(admin()).toContain("Overview");
    expect(cca()).not.toContain("/cca/7/transcript");
    expect(cca()).toContain("Overview");
  });

  it("shows both entries once the switch is on", () => {
    enabledQuery.mockReturnValue({ data: { enabled: true } });

    expect(admin()).toContain("Transcripts");
    expect(cca()).toContain("/cca/7/transcript");
  });
});
