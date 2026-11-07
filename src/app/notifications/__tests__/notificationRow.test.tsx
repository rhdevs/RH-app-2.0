import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const enabledQuery = vi.fn();
const countQuery = vi.fn();
vi.mock("~/trpc/react", () => ({
  api: {
    notifications: {
      enabled: { useQuery: (...a: unknown[]) => enabledQuery(...a) },
      unreadCount: { useQuery: (...a: unknown[]) => countQuery(...a) },
    },
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    "aria-label"?: string;
  }) => (
    <a href={href} className={rest.className} aria-label={rest["aria-label"]}>
      {children}
    </a>
  ),
}));

const { NotificationRow, isInAppHref } = await import(
  "../_components/NotificationRow"
);
const { default: NotificationBell, badgeLabel } = await import(
  "~/app/_components/NotificationBell"
);

const base = {
  id: "0123456789abcdef01234567",
  body: null,
  href: null,
  createdAt: new Date("2026-11-02T01:00:00Z"),
  readAt: null,
};

describe("a notification row is plain text", () => {
  it('shows < & and " in a title as text, never as markup', () => {
    const title = `<script>alert(1)</script> Fish & "Chips" <img src=x onerror=y>`;

    const html = renderToStaticMarkup(
      <NotificationRow item={{ ...base, title, body: `<b>bold</b> & "q"` }} />,
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Fish &amp; &quot;Chips&quot;");
    // The escaped markup decodes back to exactly the stored title.
    const decoded = html
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
    expect(decoded).toContain(title);
  });

  it("links only to a path inside the app", () => {
    const link = renderToStaticMarkup(
      <NotificationRow item={{ ...base, title: "t", href: "/events/3" }} />,
    );
    const hostile = renderToStaticMarkup(
      <NotificationRow
        item={{ ...base, title: "t", href: "javascript:alert(1)" }}
      />,
    );

    expect(link).toContain('href="/events/3"');
    expect(hostile).not.toContain("href=");
    expect(isInAppHref("//evil.example")).toBe(false);
    expect(isInAppHref("https://evil.example")).toBe(false);
    expect(isInAppHref("/ok")).toBe(true);
  });

  it("marks an unread row for screen readers and leaves a read one plain", () => {
    const unread = renderToStaticMarkup(
      <NotificationRow item={{ ...base, title: "t" }} />,
    );
    const read = renderToStaticMarkup(
      <NotificationRow
        item={{ ...base, title: "t", readAt: new Date("2026-11-02T02:00:00Z") }}
      />,
    );

    expect(unread).toContain("Unread");
    expect(read).not.toContain("Unread");
  });
});

describe("the bell badge", () => {
  it("caps the number it draws", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(99)).toBe("99");
    expect(badgeLabel(100)).toBe("99+");
  });
});

describe("the bell with the switch off", () => {
  it("draws nothing and never asks for the count", () => {
    enabledQuery.mockReturnValue({ data: { enabled: false } });
    countQuery.mockReturnValue({ data: undefined });

    const html = renderToStaticMarkup(<NotificationBell signedIn />);

    expect(html).toBe("");
    expect(countQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ enabled: false }),
    );
  });

  it("draws nothing while the answer is loading or failed", () => {
    enabledQuery.mockReturnValue({ data: undefined });
    countQuery.mockReturnValue({ data: undefined });

    expect(renderToStaticMarkup(<NotificationBell signedIn />)).toBe("");
  });

  it("draws nothing for a signed-out visitor", () => {
    enabledQuery.mockReturnValue({ data: { enabled: true } });
    countQuery.mockReturnValue({ data: { count: 4 } });

    expect(renderToStaticMarkup(<NotificationBell signedIn={false} />)).toBe(
      "",
    );
  });

  it("with the switch on, links to the inbox and shows the unread badge", () => {
    enabledQuery.mockReturnValue({ data: { enabled: true } });
    countQuery.mockReturnValue({ data: { count: 4 } });

    const html = renderToStaticMarkup(<NotificationBell signedIn />);

    expect(html).toContain('href="/notifications"');
    expect(html).toContain("Notifications, 4 unread");
    expect(html).toContain(">4<");
  });
});
