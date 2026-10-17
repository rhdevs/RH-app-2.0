"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { errorText } from "~/lib/transcript/adminView";
import {
  RELEASE_DIALOG,
  RELOCK_DIALOG,
  SECTION_TABS,
  UNLOCK_DIALOG,
  WITHHOLD_DIALOG,
  canEditResident,
  canUnlock,
  readOnlyNote,
  statusLine,
  type PanelFacts,
  type SectionTab,
} from "~/lib/transcript/residentView";
import { api } from "~/trpc/react";
import { ErrorLine } from "../../_components/Bits";
import { previewHref } from "../../_components/PreviewPicker";
import ActivitiesTab from "./ActivitiesTab";
import AwardsTab from "./AwardsTab";
import HistoryTab from "./HistoryTab";
import JcrcTab from "./JcrcTab";
import MembershipsTab from "./MembershipsTab";
import {
  Loading,
  ReasonDialogView,
  Tag,
  type ReasonDialogCopy,
  type SectionProps,
} from "./ResidentBits";
import VolunteerTab from "./VolunteerTab";

export interface PanelData extends PanelFacts {
  userID: string;
  displayName: string | null;
  academicYear: string;
  isJcrcMember: boolean;
  unlock: {
    reason: string;
    byName: string | null;
    at: Date | string | null;
  } | null;
  withhold: {
    reason: string;
    byName: string | null;
    at: Date | string | null;
  } | null;
}

export type DialogKind = "unlock" | "relock" | "withhold" | "release";

const COPY: Record<DialogKind, ReasonDialogCopy> = {
  unlock: UNLOCK_DIALOG,
  relock: RELOCK_DIALOG,
  withhold: WITHHOLD_DIALOG,
  release: RELEASE_DIALOG,
};

/** Unlock and withhold need a reason; relock and release take an optional note. */
export const NEEDS_REASON: Record<DialogKind, boolean> = {
  unlock: true,
  relock: false,
  withhold: true,
  release: false,
};

export interface PanelHeaderViewProps {
  panel: PanelData;
  previewUrl: string;
  onDialog: (kind: DialogKind) => void;
}

/** The resident, the year's status line, and the actions for them. */
export function PanelHeaderView({
  panel,
  previewUrl,
  onDialog,
}: PanelHeaderViewProps) {
  const note = readOnlyNote(panel);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="text-base font-semibold text-gray-900">
          {panel.displayName ?? panel.userID}
        </h2>
        <span className="text-sm text-gray-600">{panel.academicYear}</span>
        <p className="text-sm font-medium text-gray-900" role="status">
          {statusLine(panel)}
        </p>
        {panel.unlocked && <Tag tone="amber">Unlocked</Tag>}
        {panel.withheld && <Tag tone="amber">Withheld</Tag>}
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href={previewUrl}
          className="inline-flex h-9 items-center rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50"
        >
          Preview transcript
        </Link>
        {canUnlock(panel) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onDialog("unlock")}
          >
            Unlock
          </Button>
        )}
        {panel.unlocked && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onDialog("relock")}
          >
            Relock
          </Button>
        )}
        {panel.withheld ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onDialog("release")}
          >
            Release
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => onDialog("withhold")}
          >
            Withhold
          </Button>
        )}
      </div>

      {panel.unlock && (
        <p className="text-xs text-gray-600">
          Unlocked{panel.unlock.byName ? ` by ${panel.unlock.byName}` : ""}.
          Reason: {panel.unlock.reason}
        </p>
      )}
      {panel.withhold && (
        <p className="text-xs text-gray-600">
          Withheld{panel.withhold.byName ? ` by ${panel.withhold.byName}` : ""}.
          Reason: {panel.withhold.reason}
        </p>
      )}
      {note && (
        <p className="text-sm text-amber-800" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

export interface ResidentPanelProps {
  userID: string;
  academicYear: string;
  onDirty: SectionProps["onDirty"];
  /** Asks to leave unsaved typing behind; returns whether to go ahead. */
  leave: () => boolean;
}

/** One resident's year: status, actions and the six sections. */
export default function ResidentPanel(p: ResidentPanelProps) {
  const utils = api.useUtils();
  const scope = { userID: p.userID, academicYear: p.academicYear };
  const panel = api.transcriptManage.corrections.panel.useQuery(scope, {
    retry: false,
  });
  const [tab, setTab] = useState<SectionTab>("memberships");
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const unlock = api.transcriptManage.corrections.unlock.useMutation();
  const relock = api.transcriptManage.corrections.relock.useMutation();
  const withhold = api.transcriptManage.corrections.withhold.useMutation();
  const release = api.transcriptManage.corrections.release.useMutation();
  const pending =
    unlock.isPending ||
    relock.isPending ||
    withhold.isPending ||
    release.isPending;

  if (panel.isPending) return <Loading rows={3} />;
  if (panel.error)
    return <ErrorLine message={errorText(panel.error.message)} />;
  const data = panel.data as PanelData;
  const editable = canEditResident(data);

  const close = () => {
    setDialog(null);
    setReason("");
    setError(null);
  };
  const confirm = async () => {
    if (!dialog) return;
    setError(null);
    try {
      const text = reason.trim();
      if (dialog === "unlock")
        await unlock.mutateAsync({ ...scope, reason: text });
      if (dialog === "relock")
        await relock.mutateAsync({ ...scope, note: text });
      if (dialog === "withhold") {
        await withhold.mutateAsync({ ...scope, reason: text });
      }
      if (dialog === "release")
        await release.mutateAsync({ ...scope, note: text });
      close();
      await utils.transcriptManage.invalidate();
      await utils.transcript.preview.invalidate();
    } catch (e) {
      setError(errorText((e as Error).message));
    }
  };

  const section: SectionProps = {
    userID: p.userID,
    academicYear: p.academicYear,
    editable,
    onDirty: p.onDirty,
  };

  const content: Record<SectionTab, ReactNode> = {
    memberships: <MembershipsTab {...section} />,
    activities: <ActivitiesTab {...section} />,
    volunteer: <VolunteerTab {...section} />,
    awards: <AwardsTab {...section} />,
    jcrc: <JcrcTab {...section} isJcrcMember={data.isJcrcMember} />,
    history: <HistoryTab userID={p.userID} academicYear={p.academicYear} />,
  };

  return (
    <div className="space-y-5">
      <PanelHeaderView
        panel={data}
        previewUrl={previewHref(p.userID, p.academicYear)}
        onDialog={(kind) => {
          setReason("");
          setError(null);
          setDialog(kind);
        }}
      />

      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (v !== tab && p.leave()) setTab(v as SectionTab);
        }}
      >
        <TabsList className="h-auto flex-wrap justify-start">
          {SECTION_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {SECTION_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-5">
            {tab === t.value ? content[t.value] : null}
          </TabsContent>
        ))}
      </Tabs>

      {dialog && (
        <ReasonDialogView
          copy={COPY[dialog]}
          open
          required={NEEDS_REASON[dialog]}
          reason={reason}
          onReason={setReason}
          pending={pending}
          error={error}
          onCancel={close}
          onConfirm={() => void confirm()}
        />
      )}
    </div>
  );
}
