"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { ArrowLeft, CalendarClock } from "lucide-react";

import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  applyInput,
  APPLICATION_NOTES_MAX,
  isTerminalStatus,
} from "~/lib/schemas/ccaApplication";
import { statusBadgeClass, statusLabel } from "../_lib/status";
import SlotPicker from "./SlotPicker";

/** Friendly copy for the machine-readable error tokens the procedures throw. */
function applyErrorCopy(message: string | undefined): string | null {
  switch (message) {
    case undefined:
      return null;
    case "ALREADY_MEMBER":
      return "You're already a member of this CCA.";
    case "APPLICATION_OPEN":
      return "You already have an application in progress here.";
    case "HEAD_CANNOT_APPLY":
      return "You head this CCA — you can't apply to it.";
    case "MATRIC_REQUIRED":
      return "Add your matriculation number in your profile before applying.";
    case "NO_SUCH_CCA":
      return "This CCA no longer exists.";
    case "CCA_APPLICATIONS_DISABLED":
      return "Applications aren't open right now.";
    default:
      return "That didn't go through. Try again.";
  }
}

export default function CcaApplyPanel({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const cca = api.ccaApplications.getCca.useQuery({ ccaID }, { retry: false });

  const [notes, setNotes] = useState("");
  const [showApply, setShowApply] = useState(false);

  const refresh = async () => {
    await Promise.all([
      utils.ccaApplications.getCca.invalidate({ ccaID }),
      utils.ccaApplications.browse.invalidate(),
      utils.ccaApplications.availableSlots.invalidate({ ccaID }),
    ]);
  };

  const apply = api.ccaApplications.submitApplication.useMutation({
    onSuccess: async () => {
      setShowApply(false);
      setNotes("");
      await refresh();
    },
  });
  const withdraw = api.ccaApplications.withdraw.useMutation({
    onSuccess: refresh,
  });
  const cancelSlot = api.ccaApplications.cancelSlot.useMutation({
    onSuccess: refresh,
  });

  if (cca.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-gray-200" />;
  }
  if (cca.error) {
    const disabled = cca.error.message === "CCA_APPLICATIONS_DISABLED";
    return (
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center">
        <p className="text-sm font-medium text-gray-900">
          {disabled
            ? "CCA applications aren't open right now"
            : "This CCA couldn't be loaded"}
        </p>
        <Link
          href="/ccas"
          className="mt-3 inline-block text-sm font-medium text-emerald-700"
        >
          ← Back to all CCAs
        </Link>
      </div>
    );
  }

  const d = cca.data;
  const app = d.application;
  const openApp = app && !isTerminalStatus(app.status);

  return (
    <div className="space-y-5">
      <Link
        href="/ccas"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 hover:text-gray-800"
      >
        <ArrowLeft className="h-4 w-4" /> All CCAs
      </Link>

      {/* Header card */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {d.bannerUrl && (
          <div className="relative h-32 w-full sm:h-40">
            <Image src={d.bannerUrl} alt="" fill className="object-cover" />
          </div>
        )}
        <div className="flex items-start gap-4 p-5">
          {d.logoUrl ? (
            <Image
              src={d.logoUrl}
              alt=""
              width={56}
              height={56}
              className="h-14 w-14 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-lg font-semibold text-emerald-700">
              {d.ccaName.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-gray-900">{d.ccaName}</h1>
            {d.category && (
              <p className="text-sm text-gray-500">{d.category}</p>
            )}
          </div>
          {d.isMember && (
            <span className="inline-flex items-center rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">
              Member
            </span>
          )}
        </div>
        {d.description && (
          <p className="whitespace-pre-line border-t border-gray-100 px-5 py-4 text-sm text-gray-600">
            {d.description}
          </p>
        )}
      </div>

      {/* Application state */}
      {d.isMember ? (
        <Card>
          <p className="text-sm text-gray-700">
            You&rsquo;re a member of {d.ccaName}. 🎉
          </p>
        </Card>
      ) : openApp ? (
        <ApplicationInProgress
          ccaID={ccaID}
          app={app}
          openSlotCount={d.openSlotCount}
          onWithdraw={() =>
            withdraw.mutate({ applicationID: app.applicationID })
          }
          withdrawing={withdraw.isPending}
          onCancelSlot={() =>
            cancelSlot.mutate({ applicationID: app.applicationID })
          }
          cancelingSlot={cancelSlot.isPending}
          onChanged={refresh}
        />
      ) : (
        <Card>
          {app && (
            <div className="mb-3 flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
                  app.status,
                )}`}
              >
                {statusLabel(app.status)}
              </span>
              {app.status === "rejected" && (
                <span className="text-sm text-gray-500">
                  You can apply again below.
                </span>
              )}
            </div>
          )}

          {app?.status === "rejected" && app.decisionReason && (
            <p className="mb-3 text-sm text-gray-600">
              <span className="font-medium text-gray-700">Note from the CCA:</span>{" "}
              {app.decisionReason}
            </p>
          )}

          {!showApply ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-gray-600">
                {d.canApply
                  ? "Interested? Apply to become a member."
                  : "You can't apply right now."}
              </p>
              {d.canApply && (
                <Button onClick={() => setShowApply(true)}>Apply to join</Button>
              )}
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = applyInput.safeParse({ ccaID, notes });
                if (!parsed.success) return;
                apply.mutate(parsed.data);
              }}
              className="space-y-3"
            >
              <label
                htmlFor="apply-notes"
                className="block text-sm font-medium text-gray-700"
              >
                Anything you&rsquo;d like the CCA to know?{" "}
                <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <textarea
                id="apply-notes"
                value={notes}
                maxLength={APPLICATION_NOTES_MAX}
                rows={5}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Why you're interested, relevant experience, availability…"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              <p className="text-right text-xs text-gray-400">
                {notes.length}/{APPLICATION_NOTES_MAX}
              </p>
              {apply.error && (
                <p className="text-sm text-red-600">
                  {applyErrorCopy(apply.error.message)}
                </p>
              )}
              <div className="flex items-center gap-3">
                <Button type="submit" disabled={apply.isPending}>
                  {apply.isPending ? "Submitting…" : "Submit application"}
                </Button>
                <button
                  type="button"
                  onClick={() => setShowApply(false)}
                  className="text-sm font-medium text-gray-500 hover:text-gray-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      {children}
    </div>
  );
}

type AppShape = RouterOutputs["ccaApplications"]["getCca"]["application"];

/** The panel shown while an application is live (submitted / scheduled). */
function ApplicationInProgress({
  ccaID,
  app,
  openSlotCount,
  onWithdraw,
  withdrawing,
  onCancelSlot,
  cancelingSlot,
  onChanged,
}: {
  ccaID: number;
  app: NonNullable<AppShape>;
  openSlotCount: number;
  onWithdraw: () => void;
  withdrawing: boolean;
  onCancelSlot: () => void;
  cancelingSlot: boolean;
  onChanged: () => Promise<void>;
}) {
  const scheduled = app.status === "interview_scheduled";
  const [picking, setPicking] = useState(false);

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusBadgeClass(
              app.status,
            )}`}
          >
            {statusLabel(app.status)}
          </span>
          <p className="mt-2 text-sm text-gray-600">
            {app.status === "submitted" &&
              (openSlotCount > 0
                ? "Your application is in. Book an interview slot below."
                : "Your application is in. The CCA will open interview slots soon.")}
            {scheduled && "Your interview is booked."}
            {app.status === "interviewed" &&
              "Your interview's done — the CCA will be in touch with a decision."}
          </p>
        </div>
        {!scheduled && (
          <button
            onClick={onWithdraw}
            disabled={withdrawing}
            className="shrink-0 text-sm font-medium text-gray-400 hover:text-red-600 disabled:opacity-50"
          >
            {withdrawing ? "Withdrawing…" : "Withdraw"}
          </button>
        )}
      </div>

      {(app.status === "submitted" || scheduled) && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          {!picking ? (
            <div className="flex flex-wrap items-center gap-3">
              {scheduled ? (
                <>
                  <Button variant="outline" onClick={() => setPicking(true)}>
                    Reschedule interview
                  </Button>
                  <button
                    onClick={onCancelSlot}
                    disabled={cancelingSlot}
                    className="text-sm font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
                  >
                    {cancelingSlot ? "Cancelling…" : "Cancel interview"}
                  </button>
                </>
              ) : openSlotCount > 0 ? (
                <Button
                  onClick={() => setPicking(true)}
                  className="inline-flex items-center gap-1.5"
                >
                  <CalendarClock className="h-4 w-4" /> Book an interview
                </Button>
              ) : (
                <p className="text-sm text-gray-500">
                  No interview slots are open yet.
                </p>
              )}
            </div>
          ) : (
            <SlotPicker
              ccaID={ccaID}
              applicationID={app.applicationID}
              currentSlotID={app.interviewSlotID}
              onDone={async () => {
                setPicking(false);
                await onChanged();
              }}
              onCancel={() => setPicking(false)}
            />
          )}
        </div>
      )}
    </Card>
  );
}
