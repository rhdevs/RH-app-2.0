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
  ccaID: number | null;
  title: string;
  description: string;
  proposalID: string;
  /** Quantities stay text while typing so a blank box is not a 0 yet. */
  quantities: Record<DisposableItem, string>;
  collectionDay: string;
  collectionTime: string;
};

export const ITEM_LABELS: Record<DisposableItem, string> = {
  plates: "Plates",
  cups: "Cups",
  bowls: "Bowls",
  forks: "Forks",
  spoons: "Spoons",
};

export function emptyForm(ccaID: number | null): DisposableFormState {
  return {
    ccaID,
    title: "",
    description: "",
    proposalID: "",
    quantities: { plates: "", cups: "", bowls: "", forks: "", spoons: "" },
    collectionDay: "",
    collectionTime: "",
  };
}

type Loaded = {
  ccaID: number;
  title: string;
  description: string;
  proposalID: string | null;
  collectionDay: string;
  collectionTime: string;
} & Record<DisposableItem, number>;

export function formFromRequest(r: Loaded): DisposableFormState {
  return {
    ccaID: r.ccaID,
    title: r.title,
    description: r.description,
    proposalID: r.proposalID ?? "",
    quantities: Object.fromEntries(
      DISPOSABLE_ITEMS.map((i) => [i, String(r[i])]),
    ) as Record<DisposableItem, string>,
    collectionDay: r.collectionDay,
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
    proposalID: state.proposalID === "" ? null : state.proposalID,
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
  if (state.ccaID === null) return { ok: false, errors: ["Choose a CCA"] };
  const parsed = disposableCreateInput.safeParse({
    ccaID: state.ccaID,
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
    if (/Ask for at least one item|Use a real date|Use a time/.test(m))
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
