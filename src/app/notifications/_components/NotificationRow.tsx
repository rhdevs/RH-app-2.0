import Link from "next/link";

export type NotificationItem = {
  id: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: Date;
  readAt: Date | null;
};

/** Only a path inside this app becomes a link; anything else is just text. */
export const isInAppHref = (href: string | null): href is string =>
  href !== null && /^\/(?![/\\])\S*$/.test(href);

const WHEN = new Intl.DateTimeFormat("en-SG", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Singapore",
});

/**
 * One notice. Title and body are rendered as React text children, never as
 * HTML, so `<`, `&` and `"` in a title show up exactly as typed.
 */
export function NotificationRow({
  item,
  onOpen,
}: {
  item: NotificationItem;
  onOpen?: (id: string) => void;
}) {
  const unread = item.readAt === null;
  const content = (
    <>
      <span className="flex items-start justify-between gap-3">
        <span
          className={`text-sm text-gray-900 ${unread ? "font-semibold" : "font-medium"}`}
        >
          {item.title}
        </span>
        {unread && (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-600">
            <span className="sr-only">Unread</span>
          </span>
        )}
      </span>
      {item.body && (
        <span className="mt-1 block whitespace-pre-line text-sm text-gray-600">
          {item.body}
        </span>
      )}
      <span className="mt-1 block text-xs text-gray-400">
        {WHEN.format(item.createdAt)}
      </span>
    </>
  );
  const className = `block rounded-lg border px-4 py-3 ${unread ? "border-emerald-200 bg-white" : "border-gray-200 bg-gray-50"}`;

  return isInAppHref(item.href) ? (
    <Link
      href={item.href}
      onClick={() => onOpen?.(item.id)}
      className={`${className} hover:border-emerald-400`}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
