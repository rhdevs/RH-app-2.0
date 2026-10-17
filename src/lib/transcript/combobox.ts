/**
 * Keyboard handling for the resident picker, an ARIA combobox with a listbox of
 * results. PURE, so every key is tested without a DOM.
 *
 * State: whether the list is open, and which option is active (-1 for none).
 * The list opens as the person types and closes on Escape or a pick.
 */

export interface ComboState {
  open: boolean;
  /** Index of the active option, or -1 when none is. */
  active: number;
}

export type ComboKey =
  | "ArrowDown"
  | "ArrowUp"
  | "Home"
  | "End"
  | "Enter"
  | "Escape"
  | "Type";

export const COMBO_CLOSED: ComboState = { open: false, active: -1 };

export interface ComboResult {
  state: ComboState;
  /** The option to pick, for Enter on an active option. */
  pick: number | null;
  /** True when the browser's own handling of the key must be stopped. */
  prevent: boolean;
}

/**
 * What a key does, given `count` options. ArrowDown and ArrowUp move (wrapping)
 * and open a closed list; Home and End jump; Enter picks the active option;
 * Escape closes; typing opens the list with nothing active.
 */
export function comboReduce(
  state: ComboState,
  key: ComboKey,
  count: number,
): ComboResult {
  const unchanged: ComboResult = { state, pick: null, prevent: false };

  switch (key) {
    case "Type":
      return {
        state: { open: true, active: -1 },
        pick: null,
        prevent: false,
      };

    case "ArrowDown": {
      if (count === 0) return unchanged;
      const active = state.open ? (state.active + 1) % count : 0;
      return { state: { open: true, active }, pick: null, prevent: true };
    }

    case "ArrowUp": {
      if (count === 0) return unchanged;
      const active =
        state.open && state.active > 0 ? state.active - 1 : count - 1;
      return { state: { open: true, active }, pick: null, prevent: true };
    }

    case "Home":
    case "End": {
      if (count === 0 || !state.open) return unchanged;
      return {
        state: { open: true, active: key === "Home" ? 0 : count - 1 },
        pick: null,
        prevent: true,
      };
    }

    case "Enter": {
      // Without an active option Enter is left alone (it must not submit a
      // choice nobody made, nor be swallowed).
      if (!state.open || state.active < 0 || state.active >= count) {
        return unchanged;
      }
      return { state: COMBO_CLOSED, pick: state.active, prevent: true };
    }

    case "Escape": {
      if (!state.open) return unchanged;
      return { state: COMBO_CLOSED, pick: null, prevent: true };
    }
  }
}

/** The DOM id of option `index` of the listbox of a picker. */
export const optionId = (idPrefix: string, index: number) =>
  `${idPrefix}-option-${index}`;

/** The DOM id of a picker's listbox. */
export const listboxId = (idPrefix: string) => `${idPrefix}-listbox`;
