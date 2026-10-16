import {
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_TITLE_MAX,
  MAX_PARTICIPANTS,
  PARTICIPANT_DESCRIPTION_MAX,
  PARTICIPANT_ROLE_MAX,
  readPeriod,
  type ActivityPeriod,
} from "./activities";

/**
 * The activity editor's state and rules. PURE: the dialog draws it, the server
 * enforces the same limits again (manageInput.ts).
 */

export interface ActivityDraft {
  title: string;
  description: string;
  period: ActivityPeriod;
}

export interface PersonDraft {
  userID: string;
  displayName: string | null;
  role: string;
  description: string;
}

export interface EditorState {
  activity: ActivityDraft;
  /** Everyone ticked or added, members and outsiders alike. */
  people: PersonDraft[];
}

export interface MemberOption {
  userID: string;
  displayName: string | null;
}

export const ROLE_PLACEHOLDER = "Leave empty if no role";
export const PERSON_DESCRIPTION_PLACEHOLDER =
  "What they did; leave empty to use the general description";

export const emptyEditor = (): EditorState => ({
  activity: { title: "", description: "", period: "full" },
  people: [],
});

/** The editor state for a saved activity (what activities.list returns). */
export function editorOf(saved: {
  title: string;
  description: string;
  period: string;
  participants: ReadonlyArray<{
    userID: string;
    displayName: string | null;
    role: string;
    description: string;
  }>;
}): EditorState {
  return {
    activity: {
      title: saved.title,
      description: saved.description,
      period: readPeriod(saved.period),
    },
    people: saved.participants.map((p) => ({ ...p })),
  };
}

const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();

const personKeyOf = (p: PersonDraft) =>
  `${p.userID}\u0000${norm(p.role)}\u0000${norm(p.description)}`;

/** Has anything changed since `saved`? Blank and absent count as the same; order does not matter. */
export function isEditorDirty(draft: EditorState, saved: EditorState): boolean {
  const a = draft.activity;
  const b = saved.activity;
  if (
    norm(a.title) !== norm(b.title) ||
    norm(a.description) !== norm(b.description) ||
    a.period !== b.period
  ) {
    return true;
  }
  if (draft.people.length !== saved.people.length) return true;
  const was = new Set(saved.people.map(personKeyOf));
  return draft.people.some((p) => !was.has(personKeyOf(p)));
}

/** The first thing wrong with the editor, as a sentence; null when it can be saved. */
export function editorProblem(state: EditorState): string | null {
  const title = norm(state.activity.title);
  if (title === "") return "Give the activity a title.";
  if (title.length > ACTIVITY_TITLE_MAX) {
    return `Use at most ${ACTIVITY_TITLE_MAX} characters for the title.`;
  }
  if (norm(state.activity.description).length > ACTIVITY_DESCRIPTION_MAX) {
    return `Use at most ${ACTIVITY_DESCRIPTION_MAX} characters for the description.`;
  }
  if (state.people.length > MAX_PARTICIPANTS) {
    return `An activity can have at most ${MAX_PARTICIPANTS} people.`;
  }
  for (const p of state.people) {
    const name = p.displayName ?? p.userID;
    if (norm(p.role).length > PARTICIPANT_ROLE_MAX) {
      return `Use at most ${PARTICIPANT_ROLE_MAX} characters for ${name}'s role.`;
    }
    if (norm(p.description).length > PARTICIPANT_DESCRIPTION_MAX) {
      return `Use at most ${PARTICIPANT_DESCRIPTION_MAX} characters for ${name}'s description.`;
    }
  }
  return null;
}

/** The activities.create / update fields for a draft. */
export const activityFields = (draft: ActivityDraft) => ({
  title: norm(draft.title),
  description: norm(draft.description),
  period: draft.period,
});

/** The participants.set list for a draft. */
export const participantsPayload = (state: EditorState) =>
  state.people.map((p) => ({
    userID: p.userID,
    role: norm(p.role),
    description: norm(p.description),
  }));

/* ---- ticking members and adding outsiders -------------------------------- */

/** Members whose name contains the filter (any case); everyone when it is blank. */
export function filterMembers<T extends MemberOption>(
  members: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...members];
  return members.filter((m) =>
    (m.displayName ?? m.userID).toLowerCase().includes(q),
  );
}

export const isPicked = (state: EditorState, userID: string) =>
  state.people.some((p) => p.userID === userID);

/** Tick or untick one person. Their role and description are kept only while ticked. */
export function togglePerson(
  state: EditorState,
  person: MemberOption,
): EditorState {
  if (isPicked(state, person.userID)) {
    return {
      ...state,
      people: state.people.filter((p) => p.userID !== person.userID),
    };
  }
  return addPerson(state, person);
}

/** Add a person (a member or an outsider); a person already there is left alone. */
export function addPerson(
  state: EditorState,
  person: MemberOption,
): EditorState {
  if (isPicked(state, person.userID)) return state;
  return {
    ...state,
    people: [
      ...state.people,
      {
        userID: person.userID,
        displayName: person.displayName,
        role: "",
        description: "",
      },
    ],
  };
}

export function removePerson(state: EditorState, userID: string): EditorState {
  return {
    ...state,
    people: state.people.filter((p) => p.userID !== userID),
  };
}

/** Tick everyone in `shown` (the filtered list). Nobody is ticked twice. */
export function selectAll(
  state: EditorState,
  shown: readonly MemberOption[],
): EditorState {
  return shown.reduce(addPerson, state);
}

/** Untick everyone in `shown`; people outside the list (outsiders) stay. */
export function clearAll(
  state: EditorState,
  shown: readonly MemberOption[],
): EditorState {
  const drop = new Set(shown.map((m) => m.userID));
  return {
    ...state,
    people: state.people.filter((p) => !drop.has(p.userID)),
  };
}

export function patchPerson(
  state: EditorState,
  userID: string,
  patch: Partial<Pick<PersonDraft, "role" | "description">>,
): EditorState {
  return {
    ...state,
    people: state.people.map((p) =>
      p.userID === userID ? { ...p, ...patch } : p,
    ),
  };
}

/** Ticked people who are not members of this CCA: the "outside people" chips. */
export function outsiders(
  state: EditorState,
  members: readonly MemberOption[],
): PersonDraft[] {
  const ids = new Set(members.map((m) => m.userID));
  return state.people.filter((p) => !ids.has(p.userID));
}

/* ---- wording -------------------------------------------------------------- */

export const peopleCountLine = (n: number) =>
  `${n} ${n === 1 ? "person" : "people"} selected`;
