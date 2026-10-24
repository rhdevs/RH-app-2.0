import { TRANSCRIPTS_OFF_NOTES } from "~/lib/transcript/pageState";

/**
 * In place of a management screen while the transcript kill switch is off.
 * Calm: nothing is broken, transcripts are simply not turned on yet. Admin and
 * JCRC are also told what turns them on.
 */
export function TranscriptsOffPanel({ forManagers }: { forManagers: boolean }) {
  return (
    <section
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
    >
      <p className="text-sm font-medium text-amber-900">
        {TRANSCRIPTS_OFF_NOTES.headline}
      </p>
      <p className="mt-1 text-sm text-amber-800">
        {forManagers
          ? TRANSCRIPTS_OFF_NOTES.forManagers
          : TRANSCRIPTS_OFF_NOTES.detail}
      </p>
    </section>
  );
}
