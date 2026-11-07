import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Capabilities } from "~/server/api/services/roles";

/**
 * The admin "Transcripts" tab and the CCA "Transcript" tab show only while the
 * transcript switch is on: hidden when off, while the answer loads, and when it
 * fails. A static render covers what is visible at rest.
 */
const enabledQuery = vi.fn();
const milestoneQuery = vi.fn();
const feedbackQuery = vi.fn();
const proposalQuery = vi.fn();
const disposableQuery = vi.fn();
const evidenceQuery = vi.fn();

vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));
vi.mock("~/app/_components/header", () => ({ default: () => null }));
vi.mock("~/app/cca/_components/CcaSwitcher", () => ({ default: () => null }));
vi.mock("~/trpc/react", () => ({
  api: {
    transcript: {
      enabled: { useQuery: (...a: unknown[]) => enabledQuery(...a) },
    },
    feedback: {
      enabled: { useQuery: (...a: unknown[]) => feedbackQuery(...a) },
    },
    proposal: {
      enabled: { useQuery: (...a: unknown[]) => proposalQuery(...a) },
    },
    disposable: {
      enabled: { useQuery: (...a: unknown[]) => disposableQuery(...a) },
    },
    milestoneEvidence: {
      enabled: { useQuery: (...a: unknown[]) => evidenceQuery(...a) },
    },
    milestone: {
      enabled: { useQuery: (...a: unknown[]) => milestoneQuery(...a) },
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

// Every other tab's tests leave the Evidence tab off.
beforeEach(() => {
  milestoneQuery.mockReset();
  milestoneQuery.mockReturnValue({ data: { enabled: false } });
  evidenceQuery.mockReset();
  evidenceQuery.mockReturnValue({ data: { enabled: false } });
});

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
  beforeEach(() => {
    enabledQuery.mockReset();
    feedbackQuery.mockReset();
    feedbackQuery.mockReturnValue({ data: { enabled: false } });
    proposalQuery.mockReset();
    proposalQuery.mockReturnValue({ data: { enabled: false } });
    disposableQuery.mockReset();
    disposableQuery.mockReturnValue({ data: { enabled: false } });
  });

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

describe("the admin Feedback tab", () => {
  const adminWithFeedback = () =>
    renderToStaticMarkup(
      <AdminShell
        capabilities={
          {
            reachDashboard: true,
            readAuditLog: true,
          } as unknown as Capabilities
        }
      >
        content
      </AdminShell>,
    );

  beforeEach(() => {
    enabledQuery.mockReset();
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    feedbackQuery.mockReset();
  });

  it.each(answers)("is hidden while the switch is %s", (_n, answer) => {
    feedbackQuery.mockReturnValue(answer);

    expect(adminWithFeedback()).not.toContain("/admin/feedback");
    expect(adminWithFeedback()).toContain("Overview");
  });

  it("shows once the switch is on", () => {
    feedbackQuery.mockReturnValue({ data: { enabled: true } });

    expect(adminWithFeedback()).toContain("/admin/feedback");
  });

  it("asks for the flag only when the user could see the tab", () => {
    feedbackQuery.mockReturnValue({ data: { enabled: true } });

    admin();
    expect(feedbackQuery.mock.calls.at(-1)![1]).toMatchObject({
      enabled: false,
    });
    adminWithFeedback();
    expect(feedbackQuery.mock.calls.at(-1)![1]).toMatchObject({
      enabled: true,
    });
  });
});

describe("the CCA Proposals tab", () => {
  beforeEach(() => {
    enabledQuery.mockReset();
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    proposalQuery.mockReset();
  });

  it.each(answers)("is hidden while the switch is %s", (_n, answer) => {
    proposalQuery.mockReturnValue(answer);

    expect(cca()).not.toContain("/cca/7/proposals");
    expect(cca()).toContain("Overview");
  });

  it("shows once the switch is on", () => {
    proposalQuery.mockReturnValue({ data: { enabled: true } });

    expect(cca()).toContain("/cca/7/proposals");
  });
});

describe("the CCA Disposables tab", () => {
  beforeEach(() => {
    enabledQuery.mockReset();
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    proposalQuery.mockReset();
    proposalQuery.mockReturnValue({ data: { enabled: false } });
    disposableQuery.mockReset();
  });

  it.each(answers)("is hidden while the switch is %s", (_n, answer) => {
    disposableQuery.mockReturnValue(answer);

    expect(cca()).not.toContain("/cca/7/disposables");
    expect(cca()).toContain("Overview");
  });

  it("shows once the switch is on", () => {
    disposableQuery.mockReturnValue({ data: { enabled: true } });

    expect(cca()).toContain("/cca/7/disposables");
  });
});

describe("the CCA Evidence tab", () => {
  beforeEach(() => {
    enabledQuery.mockReset();
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    proposalQuery.mockReset();
    proposalQuery.mockReturnValue({ data: { enabled: false } });
    disposableQuery.mockReset();
    disposableQuery.mockReturnValue({ data: { enabled: false } });
    evidenceQuery.mockReset();
  });

  it.each(answers)("is hidden while the switch is %s", (_n, answer) => {
    evidenceQuery.mockReturnValue(answer);

    expect(cca()).not.toContain("/cca/7/evidence");
    expect(cca()).toContain("Overview");
  });

  it("shows once the switch is on", () => {
    evidenceQuery.mockReturnValue({ data: { enabled: true } });

    expect(cca()).toContain("/cca/7/evidence");
  });
});
