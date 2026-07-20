import { type RouterOutputs } from "~/trpc/react";

export type Applicant =
  RouterOutputs["ccaApplicationsHead"]["listApplications"]["applications"][number]["applicant"];

/**
 * Everything the head knows about an applicant, plus the free-text notes they
 * sent with the application. Shared by the Applications and Interviews tabs so
 * the two always show the same detail set. Missing fields render as "—" rather
 * than vanishing, so an unresolved account is visibly incomplete, not silently
 * blank.
 */
export default function ApplicantDetails({
  applicant,
  userID,
  notes,
}: {
  applicant: Applicant;
  userID: string;
  notes: string | null;
}) {
  const rows: { label: string; value: string | null }[] = [
    { label: "Matric", value: applicant.matric },
    { label: "Block", value: applicant.block != null ? String(applicant.block) : null },
    { label: "Email", value: applicant.email },
    {
      label: "Telegram",
      value: applicant.telegramHandle ? `@${applicant.telegramHandle}` : null,
    },
    { label: "User ID", value: userID },
  ];

  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label} className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
              {r.label}
            </dt>
            <dd className="truncate text-sm text-gray-800" title={r.value ?? undefined}>
              {r.value ?? <span className="text-gray-300">—</span>}
            </dd>
          </div>
        ))}
      </dl>

      {applicant.bio?.trim() && (
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
            About
          </p>
          <p className="mt-0.5 whitespace-pre-line text-sm text-gray-700">
            {applicant.bio}
          </p>
        </div>
      )}

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
          Notes sent with the application
        </p>
        <p className="mt-0.5 whitespace-pre-line text-sm text-gray-700">
          {notes?.trim() ? notes : <span className="text-gray-300">— none —</span>}
        </p>
      </div>
    </div>
  );
}
