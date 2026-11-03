import { defaultCollectionDay } from "./events";
import {
  disposableCreateInput,
  disposableUpdateInput,
  DISPOSABLE_ITEMS,
  isPastDay,
  type DisposableItem,
} from "~/lib/schemas/disposable";

/**
 * The request form's state and its checks, kept out of the component so they
 * run without a browser. The form runs the same schema as the procedure; the
 * server checks again.
 */
export type DisposableFormState = {
  /** The event the request is for (the CCA comes from it, on the server). */
  eventID: number | null;
  title: string;
  description: string;
  proposalID: string;
  /** Quantities stay text while typing so a blank box is not a 0 yet. */
  quantities: Record<DisposableItem, string>;
  collectionDay: string;
  /** The person typed the date, so choosing an event must not overwrite it. */
  collectionDayEdited: boolean;
  collectionTime: string;
};

export const ITEM_LABELS: Record<DisposableItem, string> = {
  plates: "Plates",
  cups: "Cups",
  bowls: "Bowls",
  forks: "Forks",
  spoons: "Spoons",
};

export function emptyForm(eventID: number | null = null): DisposableFormState {
  return {
    eventID,
    title: "",
    description: "",
    proposalID: "",
    quantities: { plates: "", cups: "", bowls: "", forks: "", spoons: "" },
    collectionDay: "",
    collectionDayEdited: false,
    collectionTime: "",
  };
}

/**
 * Choose (or clear) the event. A proposal is the other way to say what the
 * request is for, so choosing an event clears it. The collection day starts as
 * the day the event starts, in Singapore time, until the person types their own.
 */
export function chooseEvent(
  state: DisposableFormState,
  event: { eventID: number; startTime: number | null } | null,
  todayKey: string,
): DisposableFormState {
  if (event === null) return { ...state, eventID: null };
  return {
    ...state,
    eventID: event.eventID,
    proposalID: "",
    collectionDay: state.collectionDayEdited
      ? state.collectionDay
      : defaultCollectionDay(event.startTime, todayKey),
  };
}

/** Choose (or clear) a proposal that has no event yet; clears the event. */
export function chooseProposal(
  state: DisposableFormState,
  proposalID: string,
): DisposableFormState {
  return proposalID === ""
    ? { ...state, proposalID }
    : { ...state, proposalID, eventID: null };
}

type Loaded = {
  /** The event it is for, if any (the tag cannot be edited). */
  event: { eventID: number } | null;
  title: string;
  description: string;
  proposalID: string | null;
  collectionDay: string;
  collectionTime: string;
} & Record<DisposableItem, number>;

export function formFromRequest(r: Loaded): DisposableFormState {
  return {
    eventID: r.event?.eventID ?? null,
    title: r.title,
    description: r.description,
    proposalID: r.proposalID ?? "",
    quantities: Object.fromEntries(
      DISPOSABLE_ITEMS.map((i) => [i, String(r[i])]),
    ) as Record<DisposableItem, string>,
    collectionDay: r.collectionDay,
    collectionDayEdited: true,
    collectionTime: r.collectionTime,
  };
}

/** A blank box is 0; anything that is not a whole number is NaN (and refused). */
const quantityOf = (raw: string) =>
  raw.trim() === "" ? 0 : Number(raw.trim());

function contentOf(state: DisposableFormState) {
  return {
    title: state.title,
    description: state.description,
    ...Object.fromEntries(
      DISPOSABLE_ITEMS.map((i) => [i, quantityOf(state.quantities[i])]),
    ),
    collectionDay: state.collectionDay,
    collectionTime: state.collectionTime,
  };
}

export type ParsedForm<T> =
  | { ok: true; input: T }
  | { ok: false; errors: string[] };

const messagesOf = (issues: readonly { message: string }[]) => [
  ...new Set(issues.map((i) => i.message)),
];

/** The input for `disposable.create`, or the messages to show. */
export function parseCreate(
  state: DisposableFormState,
  todayKey: string,
): ParsedForm<ReturnType<typeof disposableCreateInput.parse>> {
  const parsed = disposableCreateInput.safeParse({
    eventID: state.eventID,
    proposalID: state.proposalID === "" ? null : state.proposalID,
    ...contentOf(state),
  });
  if (!parsed.success) {
    return { ok: false, errors: friendly(messagesOf(parsed.error.issues)) };
  }
  if (isPastDay(parsed.data.collectionDay, todayKey)) {
    return { ok: false, errors: ["Choose today or a later collection date"] };
  }
  return { ok: true, input: parsed.data };
}

/** The input for `disposable.update`. */
export function parseUpdate(
  state: DisposableFormState,
  id: string,
  version: number,
  todayKey: string,
): ParsedForm<ReturnType<typeof disposableUpdateInput.parse>> {
  const parsed = disposableUpdateInput.safeParse({
    id,
    version,
    ...contentOf(state),
  });
  if (!parsed.success) {
    return { ok: false, errors: friendly(messagesOf(parsed.error.issues)) };
  }
  if (isPastDay(parsed.data.collectionDay, todayKey)) {
    return { ok: false, errors: ["Choose today or a later collection date"] };
  }
  return { ok: true, input: parsed.data };
}

/** Zod's default wording ("Too small: expected number to be >=0") is for developers. */
function friendly(messages: string[]): string[] {
  return messages.map((m) => {
    if (
      /Ask for at least one item|Use a real date|Use a time|Choose the event/.test(
        m,
      )
    )
      return m;
    if (/string/i.test(m) && /(>=|least|1 character)/i.test(m)) {
      return "Give the request a title";
    }
    if (/number|integer|>=|<=/i.test(m)) {
      return "Quantities are whole numbers from 0 to 500";
    }
    return m;
  });
}
