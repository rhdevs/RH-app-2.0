"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  isProposalCategory,
  PROPOSAL_CATEGORIES,
  PROPOSAL_CATEGORY_LABELS,
} from "~/lib/proposals/categories";
import {
  isProposalStatus,
  PROPOSAL_STATUS_LABELS,
} from "~/lib/proposals/status";
import {
  PROPOSAL_BLAST_MAX,
  PROPOSAL_DESCRIPTION_MAX,
  PROPOSAL_TITLE_MAX,
} from "~/lib/schemas/proposal";
import { historyLine } from "~/lib/proposals/historyLine";
import { formatDateTime } from "~/app/events/_lib/format";
import {
  isOwnProposalPosterUrl,
  normalizeDocLink,
  PROPOSAL_DOC_LINK_MAX,
} from "~/lib/schemas/proposalFiles";
import ProposalEventLink from "./ProposalEventLink";
import ProposalPosterField from "./ProposalPosterField";
import {
  describeProposalError,
  docLinkIsInvalid,
  EMPTY_PROPOSAL_FORM,
  formFromProposal,
  missingFromForm,
  sameForm,
  saveFieldsFromForm,
  updateFieldsFromForm,
  withCategory,
  type ProposalFormState,
} from "../_lib/proposalForm";

const FIELD =
  "w-full rounded-lg border border-gray-300 p-2.5 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600 disabled:bg-gray-50 disabled:text-gray-500";

type Failure = { text: string; items: string[] };
type Stored = { id: string; version: number };

const asDate = (d: Date | string) => new Date(d);
const toEpoch = (d: Date | string) => Math.floor(asDate(d).getTime() / 1000);

/**
 * Write, save and submit one proposal. With no `proposalID` it creates a draft
 * on the first save and moves to that proposal's page.
 *
 * Submit is ONE server call. If there are unsaved edits they are saved first
 * and the submit names the version that save produced, so the server checks
 * exactly what was typed. A failed submit leaves the draft as it was.
 *
 * NOT a guard. Every procedure checks the flag and the headship itself. The
 * checklist of what is missing comes from the same table the server enforces.
 * Everything the server sends is rendered as React text.
 */
export default function ProposalEditor({
  ccaID,
  proposalID,
}: {
  ccaID: number;
  proposalID?: string;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const enabled = api.proposal.enabled.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const on = enabled.data?.enabled === true;
  const detail = api.proposal.get.useQuery(
    { id: proposalID ?? "" },
    { retry: false, enabled: on && proposalID !== undefined },
  );

  const [form, setForm] = useState<ProposalFormState>(EMPTY_PROPOSAL_FORM);
  const [seenVersion, setSeenVersion] = useState<number | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);

  // Load the stored values once per version. A save bumps the version, which
  // refills the form with what the server kept (trimmed text).
  const loaded = detail.data;
  useEffect(() => {
    if (loaded && loaded.version !== seenVersion) {
      setForm(formFromProposal(loaded));
      setSeenVersion(loaded.version);
    }
  }, [loaded, seenVersion]);

  const create = api.proposal.create.useMutation();
  const update = api.proposal.update.useMutation();
  const submit = api.proposal.submit.useMutation();
  const busy = create.isPending || update.isPending || submit.isPending;

  if (enabled.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (!on) {
    return (
      <p className="text-sm text-gray-500">
        Proposals are not switched on yet.
      </p>
    );
  }
  if (proposalID !== undefined && detail.isLoading) {
    return <p className="text-sm text-gray-500">Loading proposal…</p>;
  }
  if (proposalID !== undefined && !loaded) {
    return (
      <p role="alert" className="text-sm text-red-600">
        {describeProposalError(detail.error?.message).text}
      </p>
    );
  }

  const editable = proposalID === undefined || loaded?.canEdit === true;
  const dirty =
    loaded === undefined || !sameForm(form, formFromProposal(loaded));
  const missing = missingFromForm(form);
  const set = (patch: Partial<ProposalFormState>) => {
    setSaved(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const fail = (e: unknown) =>
    setFailure(describeProposalError((e as { message?: string }).message));

  /** Save the form. Resolves to the stored id and version, or null on error. */
  const save = async (): Promise<Stored | null> => {
    setFailure(null);
    const fields = saveFieldsFromForm(form);
    try {
      if (loaded === undefined) {
        return await create.mutateAsync({ ccaID, ...fields });
      }
      if (!dirty) return { id: loaded.id, version: loaded.version };
      return await update.mutateAsync({
        id: loaded.id,
        version: loaded.version,
        ...updateFieldsFromForm(form),
      });
    } catch (e) {
      fail(e);
      return null;
    }
  };

  const refresh = async (id: string) => {
    await utils.proposal.get.invalidate({ id });
    await utils.proposal.list.invalidate({ ccaID });
  };

  const onSave = async () => {
    const result = await save();
    if (!result) return;
    if (loaded === undefined) {
      router.push(`/cca/${ccaID}/proposals/${result.id}`);
      return;
    }
    setSaved(true);
    await refresh(result.id);
  };

  const onSubmit = async () => {
    const result = await save();
    if (!result) return;
    try {
      await submit.mutateAsync({ id: result.id, version: result.version });
    } catch (e) {
      fail(e);
      await refresh(result.id);
      return;
    }
    await refresh(result.id);
    if (loaded === undefined)
      router.push(`/cca/${ccaID}/proposals/${result.id}`);
  };

  const noTitle = form.title.trim() === "";
  const linkInvalid = docLinkIsInvalid(form);
  // A stored link is checked again on the way out; one that fails is not shown.
  const shownLink = normalizeDocLink(loaded?.docLink ?? "");
  const shownPoster =
    loaded?.posterUrl && isOwnProposalPosterUrl(loaded.posterUrl, loaded.id)
      ? loaded.posterUrl
      : null;

  return (
    <div className="space-y-5">
      <div>
        <Link
          href={`/cca/${ccaID}/proposals`}
          className="text-sm text-emerald-700 underline underline-offset-2"
        >
          All proposals
        </Link>
        <h2 className="mt-1 text-lg font-semibold text-gray-900">
          {loaded ? loaded.title : "New proposal"}
        </h2>
        {loaded && (
          <p className="text-sm text-gray-500">
            {isProposalStatus(loaded.status)
              ? PROPOSAL_STATUS_LABELS[loaded.status]
              : "Unknown status"}
            {loaded.submittedAt
              ? `, submitted ${formatDateTime(toEpoch(loaded.submittedAt))}`
              : ""}
          </p>
        )}
      </div>

      {loaded && !editable && (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600">
          This proposal can no longer be edited.
        </p>
      )}

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <div>
          <label
            htmlFor="proposal-category"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Type
          </label>
          <select
            id="proposal-category"
            value={form.category}
            disabled={!editable || busy}
            onChange={(e) => {
              const v = e.target.value;
              if (isProposalCategory(v)) {
                setSaved(false);
                setForm((f) => withCategory(f, v));
              }
            }}
            className={FIELD}
          >
            {PROPOSAL_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PROPOSAL_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="proposal-title"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Title
          </label>
          <input
            id="proposal-title"
            type="text"
            value={form.title}
            maxLength={PROPOSAL_TITLE_MAX}
            disabled={!editable || busy}
            onChange={(e) => set({ title: e.target.value })}
            className={FIELD}
          />
        </div>

        <div>
          <label
            htmlFor="proposal-description"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Description
          </label>
          <textarea
            id="proposal-description"
            rows={6}
            value={form.description}
            maxLength={PROPOSAL_DESCRIPTION_MAX}
            disabled={!editable || busy}
            onChange={(e) => set({ description: e.target.value })}
            className={FIELD}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="proposal-start"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Planned start
            </label>
            <input
              id="proposal-start"
              type="datetime-local"
              value={form.startLocal}
              disabled={!editable || busy}
              onChange={(e) => set({ startLocal: e.target.value })}
              className={FIELD}
            />
          </div>
          <div>
            <label
              htmlFor="proposal-end"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Planned end <span className="text-gray-400">(optional)</span>
            </label>
            <input
              id="proposal-end"
              type="datetime-local"
              value={form.endLocal}
              disabled={!editable || busy}
              onChange={(e) => set({ endLocal: e.target.value })}
              className={FIELD}
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="proposal-blast"
            className="mb-1 block text-sm font-medium text-gray-700"
          >
            Blast message
          </label>
          <textarea
            id="proposal-blast"
            rows={3}
            value={form.blastMessage}
            maxLength={PROPOSAL_BLAST_MAX}
            disabled={!editable || busy}
            onChange={(e) => set({ blastMessage: e.target.value })}
            className={FIELD}
          />
        </div>

        <div className="flex items-start gap-2">
          <input
            id="proposal-will-be-event"
            type="checkbox"
            checked={form.willBeEvent}
            disabled={!editable || busy}
            onChange={(e) => set({ willBeEvent: e.target.checked })}
            className="mt-1 h-4 w-4 rounded border-gray-300 text-emerald-600"
          />
          <label
            htmlFor="proposal-will-be-event"
            className="text-sm text-gray-700"
          >
            <span className="font-medium">This will be an event</span>
            <span className="block text-gray-500">
              When it is approved, an unpublished event draft is made for you.
              You publish it yourself. Leave this off to make one later.
            </span>
          </label>
        </div>

        {editable ? (
          <>
            <ProposalPosterField
              proposalID={loaded?.id}
              value={form.posterUrl}
              onChange={(url) => set({ posterUrl: url })}
              disabled={busy}
            />
            <div>
              <label
                htmlFor="proposal-doclink"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Document link{" "}
                <span className="text-gray-400">(https only)</span>
              </label>
              <input
                id="proposal-doclink"
                type="url"
                inputMode="url"
                autoComplete="off"
                value={form.docLink}
                maxLength={PROPOSAL_DOC_LINK_MAX}
                disabled={busy}
                aria-invalid={linkInvalid}
                aria-describedby={
                  linkInvalid ? "proposal-doclink-error" : undefined
                }
                onChange={(e) => set({ docLink: e.target.value })}
                className={FIELD}
              />
              {linkInvalid && (
                <p
                  id="proposal-doclink-error"
                  role="alert"
                  className="mt-1 text-sm text-red-600"
                >
                  The link must start with https:// and have no username or
                  password.
                </p>
              )}
            </div>
          </>
        ) : (
          (shownPoster || shownLink) && (
            <div className="space-y-3">
              {shownPoster && (
                <div>
                  <p className="mb-1 text-sm font-medium text-gray-700">
                    Poster
                  </p>
                  <div className="relative h-64 w-full max-w-md overflow-hidden rounded-md border border-gray-200 bg-gray-50">
                    <Image
                      src={shownPoster}
                      alt="Poster"
                      fill
                      className="object-contain"
                      sizes="448px"
                      unoptimized
                    />
                  </div>
                </div>
              )}
              {shownLink && (
                <p className="text-sm">
                  <span className="font-medium text-gray-700">
                    Document link:{" "}
                  </span>
                  <a
                    href={shownLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-emerald-700 underline underline-offset-2"
                  >
                    {shownLink}
                  </a>
                </p>
              )}
            </div>
          )
        )}

        {editable && missing.length > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-medium">Needed before you can submit</p>
            <ul className="mt-1 list-disc pl-5">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        {failure && (
          <div role="alert" className="text-sm text-red-600">
            <p>{failure.text}</p>
            {failure.items.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {failure.items.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {saved && !failure && (
          <p role="status" className="text-sm text-emerald-700">
            Saved.
          </p>
        )}

        {editable && (
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="outline"
              disabled={busy || noTitle || !dirty || linkInvalid}
            >
              {create.isPending || update.isPending ? "Saving…" : "Save draft"}
            </Button>
            <Button
              type="button"
              disabled={busy || noTitle || missing.length > 0 || linkInvalid}
              onClick={() => void onSubmit()}
            >
              {submit.isPending ? "Submitting…" : "Submit for review"}
            </Button>
          </div>
        )}
      </form>

      {loaded && <ProposalEventLink ccaID={ccaID} proposal={loaded} />}

      {loaded && loaded.history.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-gray-900">History</h3>
          <ul className="space-y-1 text-sm text-gray-600">
            {loaded.history.map((h) => (
              <li key={h.id}>
                {historyLine(h, (at) => formatDateTime(toEpoch(at)))}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
