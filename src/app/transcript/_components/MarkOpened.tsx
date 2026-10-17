"use client";

import { useEffect, useRef } from "react";

import { api } from "~/trpc/react";

/**
 * Notes, once, that the resident has this year's transcript on screen (this is
 * what clears the "Ready" badge). Viewing itself writes nothing; this is the
 * one write, a mutation, and it renders nothing.
 */
export function MarkOpened({ academicYear }: { academicYear: string }) {
  const utils = api.useUtils();
  const mark = api.transcript.mine.markOpened.useMutation({
    onSuccess: () => utils.transcript.mine.readiness.invalidate(),
  });
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (sent.current === academicYear) return;
    sent.current = academicYear;
    mark.mutate({ academicYear });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academicYear]);

  return null;
}
