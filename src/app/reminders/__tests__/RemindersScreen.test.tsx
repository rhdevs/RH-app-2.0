import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enabledQuery = vi.fn();
const mineQuery = vi.fn();

vi.mock("~/trpc/react", () => ({
  api: {
    useUtils: () => ({
      reminder: {
        mine: { invalidate: vi.fn() },
        entry: { invalidate: vi.fn() },
      },
    }),
    reminder: {
      enabled: { useQuery: () => enabledQuery() },
      mine: { useQuery: () => mineQuery() },
      markDone: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

const { default: RemindersScreen } = await import(
  "~/app/reminders/_components/RemindersScreen"
);

const item = (over: Record<string, unknown> = {}) => ({
  broadcastID: "a".repeat(24),
  ccaID: 7,
  ccaName: "Hall Choir",
  title: "Send your budget",
  message: "",
  deadline: "2027-03-12",
  daysLeft: 1,
  done: false,
  doneAt: null,
  ...over,
});
const mine = (over: Record<string, unknown> = {}) => ({
  data: { items: [item()], skipped: 0, isHead: true, ...over },
  isLoading: false,
  isError: false,
});
const render = () => renderToStaticMarkup(<RemindersScreen />);

describe("RemindersScreen", () => {
  beforeEach(() => {
    enabledQuery.mockReset();
    mineQuery.mockReset();
    enabledQuery.mockReturnValue({
      data: { enabled: true },
      isLoading: false,
    });
  });

  it("says so when the switch is off, and does not ask for the list", () => {
    enabledQuery.mockReturnValue({
      data: { enabled: false },
      isLoading: false,
    });
    mineQuery.mockReturnValue({ isLoading: false, isError: false });
    expect(render()).toContain("not switched on yet");
  });

  it("shows an open item with its urgency and a Mark done button", () => {
    mineQuery.mockReturnValue(mine());
    const html = render();
    expect(html).toContain("Send your budget");
    expect(html).toContain("Due tomorrow");
    expect(html).toContain("Mark done");
  });

  it("shows a done item without the button", () => {
    mineQuery.mockReturnValue(mine({ items: [item({ done: true })] }));
    const html = render();
    expect(html).toContain("Done");
    expect(html).not.toContain("Mark done");
  });

  it("says nothing is due, and says when the person is not a head", () => {
    mineQuery.mockReturnValue(mine({ items: [] }));
    expect(render()).toContain("Nothing is due.");
    mineQuery.mockReturnValue(mine({ items: [], isHead: false }));
    expect(render()).toContain("not a head");
  });

  it("shows a failed read as an error, not as an empty list", () => {
    mineQuery.mockReturnValue({ isLoading: false, isError: true });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("Nothing is due.");
  });
});
