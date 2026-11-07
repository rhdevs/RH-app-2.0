"use client";

import { useEffect, useRef, useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { PROPOSAL_COMMENT_MAX } from "~/lib/schemas/proposal";
import { unreadLabel } from "~/lib/proposals/unreadText";
import { formatDateTime } from "~/app/events/_lib/format";
import { describeProposalError } from "~/app/cca/_lib/proposalForm";

const FIELD =
  "w-full rounded-lg border border-gray-300 p-2.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600 disabled:bg-gray-50";

const toEpoch = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/** What the thread calls a comment whose author's account was deleted. */
export const FORMER_MEMBER = "Former member";

/**
 * The comment thread of one proposal, for the head's page and the director's.
 * NOT a guard: `commentList`, `commentAdd` and `commentMarkRead` each check,
 * from the stored proposal, that the caller may read THIS proposal now (and a
 * director not a draft). Every comment is rendered as React text, so markup
 * in one is shown as typed. No person id reaches this screen; an author is
 * "You", a name, or "Former member".
 *
 * Reading the thread does not mark it read. Once the newest page is on screen
 * the thread marks itself read, up to the newest comment shown, through its
 * own mutation; the "new" marks stay for this visit.
 */
export default function ProposalThread({
  proposalID,
  ccaID,
}: {
  proposalID: string;
  /** Lists to refresh when the unread count changes. */
  ccaID?: number;
}) {
  const utils = api.useUtils();
  const [body, setBody] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const first = api.proposal.commentList.useQuery(
    { proposalID },
    { retry: false },
  );
  const [olderItems, setOlderItems] = useState<
    NonNullable<typeof first.data>["items"]
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(
    undefined,
  );

  const markRead = api.proposal.commentMarkRead.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.proposal.get.invalidate({ id: proposalID }),
        utils.proposal.directorQueue.invalidate(),
        ccaID !== undefined
          ? utils.proposal.list.invalidate({ ccaID })
          : utils.proposal.list.invalidate(),
      ]);
    },
  });
  const add = api.proposal.commentAdd.useMutation();

  const markedFor = useRef<string | null>(null);
  const newest = first.data?.items[0]?.createdAt;
  const unread = first.data?.unread ?? 0;
  useEffect(() => {
    if (!first.data || unread < 1 || !newest) return;
    const key = `${proposalID}:${String(newest)}`;
    if (markedFor.current === key) return;
    markedFor.current = key;
    markRead.mutate({ proposalID, upTo: new Date(newest) });
    // markRead is a stable mutation handle; only a new page should refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.data, unread, newest, proposalID]);

  if (first.isLoading) {
    return <p className="text-sm text-gray-500">Loading comments…</p>;
  }
  if (first.isError || !first.data) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {describeProposalError(first.error?.message).text}
      </p>
    );
  }

  const cursor = nextCursor === undefined ? first.data.nextCursor : nextCursor;
  const items = [...first.data.items, ...olderItems];
  // Newest first from the server; read top to bottom oldest first.
  const shown = [...items].reverse();

  const loadEarlier = async () => {
    if (!cursor) return;
    const page = await utils.proposal.commentList.fetch({
      proposalID,
      cursor,
    });
    setOlderItems((o) => [...o, ...page.items]);
    setNextCursor(page.nextCursor);
  };

  const post = async () => {
    setFailure(null);
    try {
      await add.mutateAsync({ proposalID, body });
      setBody("");
      setOlderItems([]);
      setNextCursor(undefined);
      markedFor.current = null;
      await utils.proposal.commentList.invalidate({ proposalID });
    } catch (e) {
      setFailure(
        describeProposalError((e as { message?: string }).message).text,
      );
    }
  };

  const badge = unreadLabel(unread);
  return (
    <section
      aria-labelledby="proposal-thread-heading"
      className="space-y-3 rounded-lg border border-gray-200 bg-white p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3
          id="proposal-thread-heading"
          className="text-sm font-semibold text-gray-900"
        >
          Comments
        </h3>
        {badge && (
          <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800">
            {badge}
          </span>
        )}
      </div>

      {cursor && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void loadEarlier()}
        >
          Show earlier comments
        </Button>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-gray-500">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {shown.map((c) => (
            <li key={c.id} className="text-sm">
              <p className="text-xs text-gray-500">
                <span className="font-medium text-gray-700">
                  {c.mine ? "You" : (c.authorName ?? FORMER_MEMBER)}
                </span>
                {" · "}
                {formatDateTime(toEpoch(c.createdAt))}
                {c.headsOnly && (
                  <span className="ml-2 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700">
                    Heads only
                  </span>
                )}
                {c.isNew && (
                  <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                    New
                  </span>
                )}
              </p>
              <p className="whitespace-pre-wrap text-gray-800">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post();
        }}
      >
        <label
          htmlFor="proposal-comment"
          className="block text-sm font-medium text-gray-700"
        >
          Add a comment
        </label>
        <textarea
          id="proposal-comment"
          rows={3}
          value={body}
          maxLength={PROPOSAL_COMMENT_MAX}
          disabled={add.isPending}
          onChange={(e) => setBody(e.target.value)}
          className={FIELD}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={add.isPending || body.trim() === ""}>
            {add.isPending ? "Posting…" : "Post comment"}
          </Button>
          <span className="text-xs text-gray-500">
            {body.length}/{PROPOSAL_COMMENT_MAX}
          </span>
        </div>
        {failure && (
          <p role="alert" className="text-sm text-red-600">
            {failure}
          </p>
        )}
      </form>
    </section>
  );
}
