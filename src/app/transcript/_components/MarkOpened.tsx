"use client";

import { useEffect, useRef } from "react";

import { api } from "~/trpc/react";

export const RETRY_DELAY_MS = 5000;

/** A function to call on each failure: the first schedules `send` once after the delay, later ones do nothing. */
export function createMarkRetry(
  send: () => void,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
) {
  let retried = false;
  return () => {
    if (retried) return;
    retried = true;
    schedule(send, RETRY_DELAY_MS);
  };
}

/**
 * Notes, once, that the resident has this year's transcript on screen (this is
 * what clears the "Ready" badge). Viewing itself writes nothing; this is the
 * one write, a mutation, and it renders nothing.
 */
export function MarkOpened({ academicYear }: { academicYear: string }) {
  const utils = api.useUtils();
  const mark = api.transcript.mine.markOpened.useMutation({
    onSuccess: () => utils.transcript.mine.readiness.invalidate(),
    onError: () => {
      sent.current = null;
      retry.current?.();
    },
  });
  const sent = useRef<string | null>(null);
  const retry = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (sent.current === academicYear) return;
    sent.current = academicYear;
    retry.current = createMarkRetry(() => mark.mutate({ academicYear }));
    mark.mutate({ academicYear });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [academicYear]);

  return null;
}
