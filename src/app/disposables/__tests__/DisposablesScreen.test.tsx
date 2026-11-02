import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enabledQuery = vi.fn();
const listQuery = vi.fn();
const listInputs: unknown[] = [];

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
vi.mock("~/trpc/react", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    api: {
      useUtils: () => ({ disposable: { list: { invalidate: vi.fn() } } }),
      disposable: {
        enabled: { useQuery: () => enabledQuery() },
        list: {
          useQuery: (input: unknown) => {
            listInputs.push(input);
            return listQuery();
          },
        },
        approve: { useMutation: mutation },
        reject: { useMutation: mutation },
        delete: { useMutation: mutation },
        nudge: { useMutation: mutation },
      },
    },
  };
});

const { requestActions } = await import("~/lib/disposables/actions");
const { default: DisposablesScreen } = await import(
  "~/app/disposables/_components/DisposablesScreen"
);

const row = (over: Record<string, unknown> = {}) => ({
  id: "a".repeat(24),
  ccaID: 7,
  ccaName: "Hall Choir",
  title: "Choir supper",
  description: "",
  proposalID: null,
  plates: 40,
  cups: 0,
  bowls: 0,
  forks: 10,
  spoons: 0,
  collectionDay: "2027-03-12",
  collectionTime: "18:30",
  status: "pending",
  version: 0,
  decisionNote: null,
  decidedAt: null,
  createdAt: "2027-03-01T00:00:00.000Z",
  requestedBy: "Sam Head",
  can: requestActions({ isSocialDirector: false, status: "pending" }),
  ...over,
});

const data = (over: Record<string, unknown> = {}) => ({
  data: {
    items: [row()],
    skipped: 0,
    more: false,
    viewer: { isSocialDirector: false, canCreate: true },
    hasSocialDirector: true,
    ccaOptions: [
      { ccaID: 7, name: "Hall Choir" },
      { ccaID: 8, name: "Chess" },
    ],
    ...over,
  },
});

const render = (ccaID?: number) =>
  renderToStaticMarkup(<DisposablesScreen ccaID={ccaID} />);

describe("the disposables screen", () => {
  beforeEach(() => {
    enabledQuery.mockReset();
    listQuery.mockReset();
    listInputs.length = 0;
    enabledQuery.mockReturnValue({ data: { enabled: true } });
  });

  it("says so in one line while the switch is off, loading or failed", () => {
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    expect(render()).toContain("not switched on yet");
    enabledQuery.mockReturnValue({ data: undefined, error: new Error("x") });
    expect(render()).toContain("not switched on yet");
    enabledQuery.mockReturnValue({ data: undefined, isLoading: true });
    expect(render()).not.toContain("not switched on yet");
  });

  it("shows a plain refusal, not the server's words, when the list fails", () => {
    listQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error("PrismaClientKnownRequestError secret"),
    });
    const html = render();
    expect(html).toContain("Could not load the requests");
    expect(html).not.toContain("Prisma");
  });

  it("shows the access refusal to someone who cannot read", () => {
    listQuery.mockReturnValue({
      data: undefined,
      isError: true,
      error: new Error("NOT_DISPOSABLE_READER"),
    });
    expect(render()).toContain("do not have access");
  });

  it("a head sees no action buttons, and a New request link", () => {
    listQuery.mockReturnValue(
      data({
        items: [
          row({
            can: requestActions({ isSocialDirector: false, status: "pending" }),
          }),
        ],
      }),
    );
    const html = render();
    expect(html).toContain("Choir supper");
    expect(html).not.toContain(">Edit<");
    expect(html).toContain('href="/disposables/new"');
    // Buttons only: the status filter also lists "Approved" and "Rejected".
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
    expect(html).not.toContain(">Delete<");
  });

  it("the Social director sees Approve, Reject, Edit and Delete on a pending request", () => {
    listQuery.mockReturnValue(
      data({
        viewer: { isSocialDirector: true, canCreate: false },
        items: [
          row({
            can: requestActions({
              isSocialDirector: true,
              isHeadOfCca: true,
              status: "pending",
            }),
          }),
        ],
      }),
    );
    const html = render();
    for (const label of ["Approve", "Reject", "Edit", "Delete"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).not.toContain("New request");
  });

  it("shows Nudge only to a head of the CCA on a pending request, from the real action rules", () => {
    const nudgeFor = (
      who: { isSocialDirector: boolean; isHeadOfCca: boolean },
      status: "pending" | "approved",
    ) => {
      listQuery.mockReturnValue(
        data({
          items: [row({ status, can: requestActions({ ...who, status }) })],
        }),
      );
      return render().includes(">Nudge the Social director<");
    };
    expect(
      nudgeFor({ isSocialDirector: false, isHeadOfCca: true }, "pending"),
    ).toBe(true);
    expect(
      nudgeFor({ isSocialDirector: false, isHeadOfCca: true }, "approved"),
    ).toBe(false);
    expect(
      nudgeFor({ isSocialDirector: false, isHeadOfCca: false }, "pending"),
    ).toBe(false);
    expect(
      nudgeFor({ isSocialDirector: true, isHeadOfCca: true }, "pending"),
    ).toBe(false);
  });

  it("renders the quantities, the date and a note as text", () => {
    listQuery.mockReturnValue(
      data({
        items: [row({ status: "rejected", decisionNote: "<b>no stock</b>" })],
      }),
    );
    const html = render();
    expect(html).toContain("40 plates, 10 forks");
    expect(html).toContain("Collect 2027-03-12 at 18:30");
    expect(html).toContain("Rejected");
    expect(html).toContain("&lt;b&gt;no stock&lt;/b&gt;");
  });

  it("says plainly when nobody can decide", () => {
    listQuery.mockReturnValue(data({ hasSocialDirector: false }));
    expect(render()).toContain("Nobody holds the Social director position");
  });

  it("offers the status, CCA and date filters, and the CCA filter only on the all-requests screen", () => {
    listQuery.mockReturnValue(data());
    const all = render();
    expect(all).toContain("Status");
    expect(all).toContain("Collection from");
    expect(all).toContain("Collection to");
    expect(all).toContain("Chess");
    expect(render(7)).not.toContain("Chess");
  });

  it("asks for a fixed CCA when it is a CCA tab", () => {
    listQuery.mockReturnValue(data());
    render(7);
    expect(listInputs.at(-1)).toEqual({ ccaID: 7 });
  });

  it("an empty list says no requests match", () => {
    listQuery.mockReturnValue(data({ items: [] }));
    expect(render()).toContain("No requests match");
  });

  it("warns when rows were skipped or the list was cut", () => {
    listQuery.mockReturnValue(data({ skipped: 2, more: true }));
    const html = render();
    expect(html).toContain("2 requests could not be shown");
    expect(html).toContain("first 300");
  });
});
