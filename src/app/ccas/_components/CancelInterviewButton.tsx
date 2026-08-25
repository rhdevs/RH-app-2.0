"use client";

import { useId, useRef, useState } from "react";

/**
 * "Cancel interview", with an INFORMED-CONSENT step on the frozen path.
 *
 * WHY THIS EXISTS. Since 2026-08-25 the recruitment freeze gates `bookSlot`,
 * and `cancelSlot` is deliberately NOT gated (the resident must be able to free
 * a slot they cannot attend). The combination is a trap that neither procedure
 * shows on its own: while recruitment is closed, cancelling is ONE-WAY. The
 * resident gives up their interview and cannot claim another until the JCRC
 * reopens, so they sit in `submitted` with no path to an interview — the
 * stranded-applicant failure this codebase treats as first-class, and the
 * reason `reject` stays open during a freeze.
 *
 * The fix is NOT to gate cancelling. That trades one trap for another: a
 * resident with a genuine clash would be forced to hold a slot they cannot
 * attend, and the head eats a no-show. Both directions strand somebody. So the
 * resident keeps their agency and loses only the surprise — the consequence is
 * stated at the moment of the click, and withdrawing is named as the other
 * exit, because a resident who no longer wants the CCA at all should not have
 * to discover that separately.
 *
 * NOTE HOW THE WITHDRAWAL SENTENCE IS WORDED, because the obvious phrasing is a
 * lie. `ccaApplications.withdraw` is ungated and always works, but there is no
 * WITHDRAW CONTROL anywhere while an interview is booked: CcaApplyPanel renders
 * its Withdraw button only under `!scheduled`, and MyApplicationsList has no
 * withdraw affordance at all (its rows link to the CCA page). So "you can
 * withdraw instead" would be false on both surfaces at exactly the moment this
 * panel is on screen. What is true is that cancelling returns the application
 * to `submitted`, and Withdraw then appears on the CCA's page — so that is what
 * it says. If a Withdraw control is ever added to the scheduled state, simplify
 * this sentence; until then, do not.
 *
 * WHEN RECRUITMENT IS OPEN THIS IS EXACTLY THE OLD BUTTON. Cancelling is
 * genuinely reversible then — they can rebook in the next breath — and a
 * confirmation on a reversible action is friction theatre that teaches people
 * to click through the one that matters. The same reasoning the JCRC panel uses
 * for not confirming "Start recruitment".
 *
 * THE TRIGGER STAYS MOUNTED WHILE THE PANEL IS OPEN, and that is deliberate
 * rather than incidental: replacing it with the panel would unmount the focused
 * element and drop focus to `<body>`, which is the exact defect that took two
 * rounds to get out of the JCRC dialog. Arming the panel leaves focus where it
 * is; `aria-expanded` / `aria-controls` tie the two together, and `role="alert"`
 * on the panel means the consequence is announced rather than merely displayed.
 */
export default function CancelInterviewButton({
  recruitmentOpen,
  pending,
  onConfirm,
}: {
  /** Hall-wide freeze. When closed, booking is gated, so a cancel is one-way. */
  recruitmentOpen: boolean;
  pending: boolean;
  onConfirm: () => void;
}) {
  const panelId = `cancel-interview-${useId()}`;
  const [armed, setArmed] = useState(false);
  // The trigger is OUTSIDE the panel, which is what makes it a valid focus
  // target for dismissal: "Keep my interview" lives INSIDE the panel it
  // closes, so pressing it unmounts the focused element and focus falls to
  // <body> unless we put it somewhere real. The trigger-toggle path never had
  // this problem (the trigger survives its own press); only the in-panel
  // button does, which is why it was missed twice.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // ADJUST STATE WHEN THE PROP CHANGES — the React-documented pattern, not an
  // effect: it re-renders before the browser paints, so there is no flash and
  // no second commit.
  //
  // Without it, `armed` survives the freeze lifting. The sequence is: frozen,
  // the resident arms the panel, the JCRC reopens (a background refetch flips
  // the prop), the open branch below renders the plain button and the panel
  // silently disappears — correct so far, because the warning it carries is no
  // longer true. But `armed` is still true, so if recruitment closes again the
  // panel REAPPEARS with no press, re-firing its `role="alert"` and announcing
  // a consequence for a decision the resident never restarted. Same class of
  // defect as a refusal outliving its cause, which this codebase has now been
  // caught by three times; the fix is to make the arming belong to the freeze
  // it was made under.
  const [armedUnder, setArmedUnder] = useState(recruitmentOpen);
  if (armedUnder !== recruitmentOpen) {
    setArmedUnder(recruitmentOpen);
    setArmed(false);
  }

  // Open hall: no confirmation, no state, no change from before.
  if (recruitmentOpen) {
    return (
      <button
        onClick={onConfirm}
        disabled={pending}
        className="text-sm font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
      >
        {pending ? "Cancelling…" : "Cancel interview"}
      </button>
    );
  }

  // `w-full` ONLY while the panel is open. The hosts render this inside a
  // `flex flex-wrap items-center gap-3` row, so an unconditional `w-full` would
  // push the button onto its own line even when nothing is armed — changing the
  // layout of a frozen page that has no panel showing. Armed, full width is
  // what makes the panel readable rather than squeezed to the button's width.
  return (
    <div className={armed ? "w-full" : undefined}>
      <button
        ref={triggerRef}
        onClick={() => setArmed((a) => !a)}
        disabled={pending}
        aria-expanded={armed}
        aria-controls={panelId}
        className="text-sm font-medium text-gray-500 hover:text-red-600 disabled:opacity-50"
      >
        {pending ? "Cancelling…" : "Cancel interview"}
      </button>

      {armed && (
        <div
          id={panelId}
          role="alert"
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3"
        >
          <p className="text-sm font-medium text-amber-900">
            Cancel this interview? You won’t be able to book another one.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            CCA recruitment is closed right now, so interview slots can’t be
            booked. If you give this one up you won’t get another time until the
            JCRC reopens recruitment.
          </p>
          <p className="mt-1 text-sm text-amber-800">
            Your application stays open either way. If you’d rather leave this
            CCA entirely, cancel first — Withdraw then appears on the CCA’s
            page.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={onConfirm}
              disabled={pending}
              className="inline-flex items-center justify-center rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50"
            >
              {pending ? "Cancelling…" : "Yes, cancel my interview"}
            </button>
            <button
              onClick={() => {
                setArmed(false);
                triggerRef.current?.focus();
              }}
              disabled={pending}
              className="rounded text-sm font-medium text-gray-600 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50"
            >
              Keep my interview
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
