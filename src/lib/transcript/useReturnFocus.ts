import { useRef } from "react";

/**
 * Focus goes back to whatever opened a dialog when it closes. Radix does this
 * itself only for a dialog opened by its own Trigger; these dialogs are opened
 * from state, so without this, focus fell to the page body and a keyboard user
 * started again from the top. Spread the result on the dialog's Content.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    // Called before Radix moves focus into the dialog: the opener still has it.
    onOpenAutoFocus: () => {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const el = opener.current;
      opener.current = null;
      if (el?.isConnected) {
        event.preventDefault();
        el.focus();
      }
    },
  };
}
