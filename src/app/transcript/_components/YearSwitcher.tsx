import Link from "next/link";
import { yearToParam } from "~/lib/transcript/assemble";
import { type YearChoice } from "~/lib/transcript/pageState";

/**
 * The academic-year pills above a transcript or the "not yet available"
 * page. Nothing is drawn without choices. The labels say what each year is
 * ("AY2026/27 (not yet available)"), not just its name.
 */
export function YearSwitcher({
  choices,
  active,
  basePath,
}: {
  choices: readonly YearChoice[];
  active: string;
  basePath: string;
}) {
  if (choices.length === 0) return null;
  return (
    <nav
      aria-label="Academic year"
      className="mb-3 flex flex-wrap gap-2 print:hidden"
    >
      {choices.map((choice) => {
        const current = choice.academicYear === active;
        return (
          <Link
            key={choice.academicYear}
            href={`${basePath}?ay=${yearToParam(choice.academicYear)}`}
            aria-current={current ? "page" : undefined}
            className={`rounded-full border px-3 py-1 text-sm font-medium ${
              current
                ? "border-emerald-800 bg-emerald-800 text-white"
                : "border-gray-300 bg-white text-gray-700 hover:border-emerald-700"
            }`}
          >
            {choice.label}
          </Link>
        );
      })}
    </nav>
  );
}
