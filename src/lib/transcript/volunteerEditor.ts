import type { MemberOption } from "./activityEditor";
import {
  VOLUNTEER_DESCRIPTION_MAX,
  VOLUNTEER_TITLE_MAX,
  MAX_VOLUNTEER_PEOPLE,
  isValidHours,
  readKind,
  type VolunteerKind,
} from "./volunteer";

/**
 * The volunteer activity editor's state and rules. PURE: the dialog draws it, the
 * server enforces the same limits again (manageInput.ts).
 */

export interface VolunteerDraft {
  title: string;
  kind: VolunteerKind;
  description: string;
  /** Text, so a half-typed number is allowed; "" means none. */
  defaultHours: string;
  /** One-off only. */
  date: string;
  hours: string;
  people: MemberOption[];
}

export const emptyVolunteerDraft = (): VolunteerDraft => ({
  title: "",
  kind: "regular",
  description: "",
  defaultHours: "",
  date: "",
  hours: "",
  people: [],
});

export interface SavedVolunteerActivity {
  title: string;
  kind: string;
  description: string;
  defaultHours: number | null;
  people: MemberOption[];
  /** A one-off's single session. */
  session?: { date: string; hours: number } | null;
}

export function volunteerDraftOf(
  saved: SavedVolunteerActivity,
): VolunteerDraft {
  return {
    title: saved.title,
    kind: readKind(saved.kind),
    description: saved.description,
    defaultHours: saved.defaultHours === null ? "" : String(saved.defaultHours),
    date: saved.session?.date ?? "",
    hours: saved.session ? String(saved.session.hours) : "",
    people: saved.people.map((p) => ({ ...p })),
  };
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();

/** Hours typed as text: a valid quarter-hour number, or null. */
export function parseVolunteerHours(text: string): number | null {
  if (norm(text) === "") return null;
  const n = Number(norm(text));
  return isValidHours(n) ? n : null;
}

export function hoursText(text: string): string | null {
  if (norm(text) === "") return null;
  const n = Number(norm(text));
  if (!Number.isFinite(n)) return "Enter a number of hours.";
  if (n < 0.25) return "Hours must be at least 0.25.";
  if (n > 24) return "Hours must be at most 24.";
  if (!Number.isInteger(n * 4)) return "Hours go up in steps of 0.25.";
  return null;
}

export function isVolunteerDirty(
  draft: VolunteerDraft,
  saved: VolunteerDraft,
): boolean {
  const key = (d: VolunteerDraft) =>
    JSON.stringify([
      norm(d.title),
      d.kind,
      norm(d.description),
      norm(d.defaultHours),
      d.kind === "oneoff" ? d.date : "",
      d.kind === "oneoff" ? norm(d.hours) : "",
      d.people.map((p) => p.userID).sort(),
    ]);
  return key(draft) !== key(saved);
}

/** The first thing wrong, as a sentence; null when it can be saved. */
export function volunteerProblem(draft: VolunteerDraft): string | null {
  const title = norm(draft.title);
  if (title === "") return "Give the activity a title.";
  if (title.length > VOLUNTEER_TITLE_MAX) {
    return `Use at most ${VOLUNTEER_TITLE_MAX} characters for the title.`;
  }
  if (norm(draft.description).length > VOLUNTEER_DESCRIPTION_MAX) {
    return `Use at most ${VOLUNTEER_DESCRIPTION_MAX} characters for the description.`;
  }
  const dh = hoursText(draft.defaultHours);
  if (dh) return dh;
  if (draft.kind === "oneoff") {
    if (draft.date === "") return "A one-off activity needs a date.";
    if (parseVolunteerHours(draft.hours) === null) {
      return hoursText(draft.hours) ?? "A one-off activity needs its hours.";
    }
  }
  if (draft.people.length > MAX_VOLUNTEER_PEOPLE) {
    return "That is more people than one save can take. Save in smaller steps.";
  }
  return null;
}

/** The create / update fields for a draft. */
export function volunteerFields(draft: VolunteerDraft) {
  const defaultHours = parseVolunteerHours(draft.defaultHours);
  return {
    title: norm(draft.title),
    description: norm(draft.description),
    defaultHours,
  };
}

/* ---- people ------------------------------------------------------------------- */

export const isPicked = (draft: VolunteerDraft, userID: string) =>
  draft.people.some((p) => p.userID === userID);

export function addPerson(
  draft: VolunteerDraft,
  person: MemberOption,
): VolunteerDraft {
  return isPicked(draft, person.userID)
    ? draft
    : { ...draft, people: [...draft.people, { ...person }] };
}

export function togglePerson(
  draft: VolunteerDraft,
  person: MemberOption,
): VolunteerDraft {
  return isPicked(draft, person.userID)
    ? removePerson(draft, person.userID)
    : addPerson(draft, person);
}

export const removePerson = (
  draft: VolunteerDraft,
  userID: string,
): VolunteerDraft => ({
  ...draft,
  people: draft.people.filter((p) => p.userID !== userID),
});

export const selectAll = (
  draft: VolunteerDraft,
  shown: readonly MemberOption[],
): VolunteerDraft => shown.reduce(addPerson, draft);

export function clearAll(
  draft: VolunteerDraft,
  shown: readonly MemberOption[],
): VolunteerDraft {
  const drop = new Set(shown.map((m) => m.userID));
  return {
    ...draft,
    people: draft.people.filter((p) => !drop.has(p.userID)),
  };
}

/** People ticked who are not members of this CCA. */
export function outsiders(
  draft: VolunteerDraft,
  members: readonly MemberOption[],
): MemberOption[] {
  const ids = new Set(members.map((m) => m.userID));
  return draft.people.filter((p) => !ids.has(p.userID));
}
