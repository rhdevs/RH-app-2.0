"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";

/**
 * THE HALL-WIDE RECRUITMENT SWITCH.
 *
 * One control, and it freezes CCA intake for every resident and every head at
 * once, so it is built like a kill switch rather than a preference: the current
 * state is stated in words before any control is offered, the destructive
 * direction goes through a dialog that lists the consequences and takes a reason
 * for the audit row, and the reversible direction (starting) is one click.
 *
 * IT NEVER RENDERS OPTIMISTICALLY. A card that says CLOSED before the write
 * landed is the one lie that matters here — someone reads it, walks away, and
 * recruitment is still running. On success it invalidates and re-reads. (Same
 * shape as SystemHealthPanel.tsx's setEnforcementMode handler, which also
 * invalidates rather than optimistically setting.)
 *
 * The 15s flag cache means a Stop is NOT instant across lambdas. That window is
 * accepted (see the plan §7 R2) and it is stated in the copy rather than hidden.
 * Do not "fix" it by shortening the TTL — the TTL is shared reasoning with four
 * other flags — and do not remove the sentence that admits it.
 *
 * WHAT THIS COMPONENT IS NOT: a guard. `/admin/ccas/page.tsx` only renders it
 * when `cap.manageCcaRecruitment` is true, and that gate is cosmetic — both
 * `ccaRecruitment.status` and `ccaRecruitment.setState` re-check the capability
 * server-side, which is where the actual boundary is. Hiding UI is never a
 * guard; AdminCapabilityContext's own header states the same rule.
 *
 * No `dark:` variants anywhere in this file, deliberately: nothing in this app
 * can ever set the `.dark` class (`src/app/layout.tsx` hardcodes the <html>
 * class and no ThemeProvider is mounted), so a dark variant here would be dead
 * code that only makes the palette harder to read. No toasts either — three
 * toast systems are installed and <Toaster> is never mounted, so a toast on
 * this surface would be a silent no-op.
 */

/**
 * The state dot. `aria-hidden` on purpose: colour is never the only signal —
 * the headline right next to it says "open" or "closed" in words, and this is
 * decoration on top of that. Announcing it would only duplicate the sentence.
 *
 * The ping ring is on the OPEN state only. Motion here means "live, intake is
 * running"; a frozen hall should look still.
 */
function Dot({ open }: { open: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
      {open && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
      )}
      <span
        className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
          open ? "bg-emerald-500" : "bg-gray-400"
        }`}
      />
    </span>
  );
}

/**
 * The micro-label / value pair used across these admin surfaces. Kept local
 * rather than shared: it is four lines, and the one thing worse than a repeated
 * four-line component is a "design system" grown out of one.
 */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
        {label}
      </p>
      <p className="text-sm text-gray-800">{value}</p>
    </div>
  );
}

/**
 * Server denials arrive as FORBIDDEN with a SCREAMING_SNAKE sentinel in the
 * message. The sanitizer middleware only rewrites INTERNAL_SERVER_ERROR, so
 * those strings reach us verbatim — but they are not English, so they never go
 * on screen raw.
 *
 * FIVE SENTINELS CAN ARRIVE HERE. Every one is handled, because the fallback
 * copy is actively harmful for all of them: "That didn't save. Try again."
 * invites an operator to retry something that will fail identically every time,
 * forever. The list is the whole middleware stack of `roleManagerProcedure`
 * read from the outside in — do not trust it from memory, walk the chain:
 *
 *   UNAUTHORIZED            protectedProcedure: no session at all (trpc.ts).
 *                           Thrown with NO message, which TRPCError turns into
 *                           the literal "UNAUTHORIZED" — its constructor is
 *                           `opts.message ?? cause?.message ?? opts.code`. So it
 *                           could be matched on the message like the other four;
 *                           it is matched on the tRPC CODE instead because that
 *                           is the authoritative channel and does not depend on
 *                           tRPC's message-defaulting, which is an
 *                           implementation detail of a dependency.
 *   NUS_ACCOUNT_REQUIRED    protectedProcedure: signed in, but the account is
 *                           not eligible to hold an identity (trpc.ts)
 *   NO_CANONICAL_IDENTITY   roleProcedure's narrowing middleware: the session
 *                           carries no canonical userID at all
 *   INSUFFICIENT_ROLE       requireRoles refused you — you are neither admin
 *                           nor jcrc any more (trpc.ts)
 *   CAPABILITY_REQUIRED:…   the live role read says you no longer hold
 *                           manageCcaRecruitment (routers/ccaRecruitment.ts)
 *
 * The last two are one event seen from two layers — a demotion that landed
 * while this tab was open — so they say the same thing, and both point at
 * reloading, because the page's own capability gate was computed at render time
 * and is now equally stale. The first three are all "your session is not what
 * this surface needs", and all point at signing in again.
 *
 * `sanitizeErrors` (trpc.ts) rewrites only INTERNAL_SERVER_ERROR, so every one
 * of these reaches the client verbatim.
 *
 * `startsWith` for the capability one, not equality: that sentinel carries the
 * capability name after a colon.
 */
function setStateErrorCopy(message: string, code?: string): string {
  if (code === "UNAUTHORIZED") {
    return "You’re signed out. Sign in again to change this.";
  }
  if (
    message.startsWith("CAPABILITY_REQUIRED") ||
    message === "INSUFFICIENT_ROLE"
  ) {
    return "You don’t have permission to change this any more. Reload the page.";
  }
  if (
    message === "NO_CANONICAL_IDENTITY" ||
    message === "NUS_ACCOUNT_REQUIRED"
  ) {
    return "Your account isn’t fully set up, so this can’t be changed. Sign out and back in.";
  }
  return "That didn’t save. Try again.";
}

export default function RecruitmentControlPanel() {
  const utils = api.useUtils();
  const { data, isLoading, isError, refetch } =
    api.ccaRecruitment.status.useQuery();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");

  /**
   * WHERE FOCUS GOES AFTER ANY STATE CHANGE, and it has to be a ref because
   * there is no element in this card that both (a) survives the state flip and
   * (b) is focusable by default.
   *
   * THREE CALLERS, not one — do not read the dialog discussion below as the
   * whole story: `onCloseAutoFocus` (the Stop direction, which has a dialog),
   * `setState.onSuccess` (the Start direction, which does not), and
   * `setState.onError` (a failed Start, where `disabled` blurred the button and
   * nothing else would ever restore it). Each fires on exactly one path, so
   * they never compete.
   *
   * Radix AlertDialog hard-codes `modal: true`, and the modal content path in
   * react-dialog installs an onCloseAutoFocus that calls `event.preventDefault()`
   * and then `context.triggerRef.current?.focus()`. Two things go wrong if you
   * leave that alone. Without an AlertDialogTrigger, `triggerRef` is null, the
   * optional call is a no-op — and the preventDefault() on the line above has
   * ALREADY cancelled FocusScope's own fallback restore, because
   * onCloseAutoFocus is wired straight into onUnmountAutoFocus. Focus lands on
   * <body>, on all three close paths (Cancel, Escape, success), and the next
   * Tab restarts from the top of the admin shell.
   *
   * Adding the Trigger below fixes Cancel and Escape. It does NOT fix success:
   * the mutation flips `data.state`, the `isOpen ? Stop : Start` ternary
   * unmounts the trigger, and focus falls off the removed node anyway. Note the timing
   * makes it worse than it looks — the dialog closes when `confirming` flips,
   * which is BEFORE the invalidation resolves, so even focusing the trigger at
   * close time only parks focus on an element that is about to be destroyed.
   *
   * So the close handler below aims at this ref instead: the status block, which
   * is mounted for the whole life of the card and only swaps its text. Landing
   * there puts a screen reader on the sentence that states the new state, and
   * one Tab from there reaches the primary button. `tabIndex={-1}` makes it
   * programmatically focusable without adding a stop to the tab order.
   *
   * Note our own onCloseAutoFocus runs FIRST — composeEventHandlers calls the
   * caller's handler before Radix's and skips Radix's if defaultPrevented — so
   * preventing default here suppresses the triggerRef path entirely and this is
   * the only focus move that happens.
   */
  const statusRef = useRef<HTMLDivElement>(null);

  /**
   * WHETHER THE NEXT DIALOG CLOSE SHOULD OVERRIDE RADIX'S FOCUS RESTORE.
   *
   * Round 2 preventDefault()ed unconditionally in onCloseAutoFocus, which was
   * right for the success path and wrong for the other two. Now that an
   * AlertDialogTrigger exists, Cancel and Escape have a CORRECT restore
   * available — Radix focuses `triggerRef`, i.e. the Stop button, which on
   * those paths is still mounted because nothing changed `data.state`. Stealing
   * that and dumping the operator on a non-interactive text block is worse than
   * doing nothing: they thought better of a freeze, pressed Escape, and now have
   * to Tab forward to get back to where they were.
   *
   * The success path needs the override because only there has the state
   * flipped and unmounted the trigger. It is NOT the only such path — if
   * somebody else stops recruitment while this dialog is open the trigger is
   * gone too, and nothing writes this ref on that path; that case is caught by
   * the `isOpen` term in the handler instead. So: false by default, set true on
   * a successful mutation, and reset every time the dialog opens so a stale
   * `true` can never leak into a later Cancel.
   */
  const focusStatusOnCloseRef = useRef(false);

  const setState = api.ccaRecruitment.setState.useMutation({
    onSuccess: async () => {
      // TWO PATHS, AND EACH RESTORES FOCUS EXACTLY ONCE. Which one we are on is
      // decided by whether a dialog is open, because only the Stop direction has
      // one.
      if (confirming) {
        // STOP. Closing the dialog is what moves focus: setConfirming(false)
        // unmounts the Content, and its onCloseAutoFocus (below) lands on the
        // status block. The ref must be set BEFORE the close, because that
        // handler reads it. Nothing else here may touch focus — a second move
        // would fight the first.
        focusStatusOnCloseRef.current = true;
        setConfirming(false);
      } else {
        // START. There is no dialog, so onCloseAutoFocus never fires and this is
        // the only restore there will be. Focus is genuinely lost on this path:
        // `disabled={setState.isPending}` blurs the focused button the instant
        // the write begins (browsers blur a focused element that becomes
        // disabled), and on success the open/closed ternary swaps an
        // <AlertDialogTrigger>-wrapped Button for a bare one, so the element
        // TYPE at that position changes and React unmounts the node rather than
        // reusing it. Either alone lands focus on <body>.
        //
        // SYNCHRONOUSLY, BEFORE THE AWAIT, and that placement is the fix for a
        // real defect rather than a style preference. `invalidate()` resolves
        // only after the refetch SETTLES, and src/trpc/query-client.ts overrides
        // only `staleTime`, so react-query's default `retry: 3` with 1s/2s/4s
        // backoff applies: on a flaky connection the promise can take ~7
        // seconds. Focusing after it would yank the operator out of whatever
        // they had moved on to and started typing in — trading "focus dropped"
        // for "focus stolen", which is worse and is an unexpected context
        // change. Here, the status block is already mounted (it never unmounts)
        // and the write has already succeeded, so there is nothing to wait for.
        statusRef.current?.focus();
      }
      setReason("");
      // Re-read rather than patch the cache. See the header: server truth only.
      await utils.ccaRecruitment.status.invalidate();
    },
    onError: () => {
      // A FAILED START ALSO LOSES FOCUS, and nothing else would restore it:
      // `disabled` blurred the button when the write began, onSuccess never
      // runs, and there is no dialog to close. The card-level error renders
      // just below the status block, so this puts the operator next to the
      // explanation with the retry one Tab away.
      //
      // The STOP path is deliberately untouched here: its dialog stays open on
      // failure with focus still inside it and the error shown in place, which
      // is correct — moving focus out of a dialog that is still open would be
      // the bug.
      if (!confirming) statusRef.current?.focus();
    },
  });

  /**
   * Both entry points to the dialog clear any previous mutation error, because
   * the two paths share one mutation object. Without this, a failed *Start*
   * leaves `setState.error` set, and the very next click on *Stop* would open a
   * dialog already showing a red line about an attempt the operator has already
   * seen and moved on from — an error about the opposite action, at that.
   */
  const openStopDialog = () => {
    setState.reset();
    // Every open starts from "let Radix restore to the trigger"; only a
    // successful mutation flips it to true. The OTHER case that needs the
    // override — somebody else stopped recruitment while this dialog was open —
    // is not handled by this ref at all but by the `isOpen` term in
    // onCloseAutoFocus, because nothing writes the ref on that path.
    focusStatusOnCloseRef.current = false;
    setConfirming(true);
    // The dialog's third bullet quotes a live count of what is in flight, and
    // that number is the whole reason the counts exist — an operator is meant
    // to decide with it. `status` has the default 30s staleTime and no refetch
    // interval, so a JCRC who has had /admin/ccas open in a background tab all
    // afternoon would otherwise be shown a figure hours old and told it is
    // what will be preserved. Fire-and-forget: the dialog opens immediately
    // either way, and the number updates under it if the refetch lands.
    void refetch();
  };

  /**
   * Closing discards the draft reason and the error with it, matching
   * JcrcRosterPanel.tsx's dialog. It also stops a stop-path error leaking into
   * the card body: the card-level error line renders only when the dialog is
   * shut, so an un-reset error would reappear underneath the card the moment
   * someone cancelled.
   *
   * Guarded on `isPending` so the dialog cannot be dismissed mid-write — the
   * write still lands, and a dialog that vanishes while the request is in
   * flight leaves the operator with no idea whether it took.
   */
  const closeStopDialog = () => {
    if (setState.isPending) return;
    setConfirming(false);
    setReason("");
    setState.reset();
  };

  /**
   * Skeleton inside the real card chrome, not a bare grey slab: this card sits
   * at the top of the page and everything else on /admin/ccas is laid out
   * beneath it, so a placeholder of a different shape makes the whole page jump
   * when the query lands. The shapes below match the real rows one for one.
   */
  if (isLoading) {
    return (
      <section
        className="rounded-xl bg-white p-6 shadow-lg"
        role="status"
        aria-label="Loading the recruitment switch"
      >
        <div className="h-3.5 w-32 animate-pulse rounded bg-gray-200" />
        <div className="mt-3 h-3 w-full max-w-xl animate-pulse rounded bg-gray-100" />
        <div className="mt-5 flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-gray-300" />
            <div className="h-5 w-52 animate-pulse rounded bg-gray-200" />
          </div>
          <div className="h-9 w-40 animate-pulse rounded-md bg-gray-200" />
        </div>
        <div className="mt-5 flex flex-wrap gap-6 border-t border-gray-100 pt-4">
          <div className="h-8 w-24 animate-pulse rounded bg-gray-100" />
          <div className="h-8 w-24 animate-pulse rounded bg-gray-100" />
          <div className="h-8 w-24 animate-pulse rounded bg-gray-100" />
        </div>
      </section>
    );
  }

  /**
   * `!data`, NOT `isError || !data`, and the distinction is not pedantry.
   *
   * react-query KEEPS `data` across a failed BACKGROUND refetch. Testing
   * `isError` first therefore tore the whole card down on a transient blip:
   * the JCRC opens the Stop dialog, types a 300-character reason, a background
   * `status` refetch fails, `isError` flips true, this early return fires — and
   * the entire <AlertDialog> below UNMOUNTS while `confirming` is still true.
   * The typed reason is gone, focus is dropped, and a card that was fully
   * populated and perfectly usable a moment earlier is replaced by "Couldn't
   * read the recruitment switch."
   *
   * So this branch now means only what it says: we have NO reading of the flag
   * at all. Nothing is guessed here — the control is withheld rather than
   * defaulted to OPEN, which is the reading a stopped hall would be most
   * damaged by. A refetch failure on top of good data renders the far less
   * violent strip further down instead, and leaves everything else alone.
   */
  if (!data) {
    return (
      <div
        className="rounded-lg border border-red-200 bg-red-50 px-4 py-3"
        role="alert"
      >
        <p className="text-sm text-red-800">
          Couldn’t read the recruitment switch.{" "}
          <button
            type="button"
            onClick={() => void refetch()}
            className="rounded font-medium underline underline-offset-2 hover:text-red-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  // NOT named `open`. The AlertDialog root further down takes its own
  // `open={confirming}` prop, and two unrelated `open`s in one scope on a
  // hall-wide kill switch is how somebody eventually reads one for the other.
  const isOpen = data.state === "open";

  // R2-M4: the refetch fired by openStopDialog can come back saying somebody
  // else — another manager, or the break-glass script — already stopped
  // recruitment. When that happens the modal in front is asking a question that
  // no longer has an answer ("Stop recruitment?" when it is already stopped),
  // while the card behind it has silently flipped to CLOSED with a green Start
  // button, invisible under the overlay and the aria-hidden.
  //
  // The dialog is NOT auto-closed on this. Yanking a modal out from under
  // somebody mid-decision is its own defect, and the refetch can land at any
  // moment including between "reads the sentence" and "clicks confirm". Instead
  // the dialog SAYS what happened and withdraws the confirm button, which is
  // strictly more informative and needs no race guard at all. Confirming anyway
  // would have been harmless — the upsert is idempotent by design — but the
  // panel had authoritative news and would have thrown it away.
  //
  // `!setState.isPending` IS LOAD-BEARING. Without it a fourth state is
  // reachable and it is the worst one: the refetch fired on open can resolve
  // WHILE the operator's own Stop is in flight (it retries with backoff, which
  // is why the stale-figures strip below exists at all). `isOpen` flips false,
  // this flips true mid-write, and the confirm button AND ITS SPINNER unmount
  // while Cancel is disabled and closeStopDialog is refusing Escape and overlay
  // clicks — an inert, undismissable kill-switch dialog asserting "there is
  // nothing left to do here" while a hall-wide write is actually running. It
  // self-heals when the mutation resolves, but on a cold lambda that is several
  // seconds of an apparently hung dialog with no working control.
  //
  // Reading `setState.isPending` here is safe where a race guard inside a
  // callback would not have been: this is computed during render, so the value
  // is current by construction and there is no stale closure to capture.
  const alreadyStopped = confirming && !isOpen && !setState.isPending;

  /*
   * THE ROOT WRAPS THE WHOLE CARD, not just the dialog markup at the bottom.
   * AlertDialogTrigger lives up in the header row beside the status block, and
   * Radix Triggers read the Root through React context — a Trigger rendered
   * outside its Root throws "`AlertDialogTrigger` must be used within
   * `AlertDialog`" at render time, which TypeScript cannot see. The Root
   * renders no DOM of its own (ui/alert-dialog.tsx aliases it straight to
   * AlertDialogPrimitive.Root) and the Content is portalled, so hoisting it
   * costs nothing in layout.
   */
  return (
    <AlertDialog
      open={confirming}
      onOpenChange={(o) => {
        if (!o) closeStopDialog();
      }}
    >
      <section className="rounded-xl bg-white p-6 shadow-lg">
        <h3 className="mb-1 text-sm font-semibold text-gray-900">
          CCA recruitment
        </h3>
        <p className="mb-5 max-w-3xl text-xs text-gray-500">
          One switch for the whole hall. While recruitment is closed, residents
          can’t apply to any CCA, nobody can book an interview, and heads can’t
          accept new members. Stored as the{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5">
            {data.flagKey}
          </code>{" "}
          system flag.
        </p>

        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* aria-live so a screen reader hears the flip, not just sighted users.
              `polite`, not `assertive`: it is a state change the user just asked
              for, not an interruption. The region is mounted with the card, so
              the first render is not announced — only the change is, which is
              exactly the intent. */}
          <div
            aria-live="polite"
            ref={statusRef}
            tabIndex={-1}
            // `focus:`, NOT `focus-visible:`. This element is only ever focused
            // programmatically (tabIndex -1 keeps it out of the tab order), and
            // whether :focus-visible matches after a scripted .focus() depends
            // on the browser's heuristic and on whether the last input was a
            // pointer — so on the mouse-driven Cancel path a focus-visible ring
            // would definitively not render, and the operator would be left with
            // an invisible focus position. A plain focus ring always shows.
            className="rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
          >
            <p className="flex items-center gap-2 text-lg font-semibold text-gray-900">
              <Dot open={isOpen} />
              {isOpen ? "Recruitment is open" : "Recruitment is closed"}
            </p>
            <p className="mt-1 max-w-lg text-sm text-gray-600">
              {isOpen
                ? "Residents can apply and heads can accept members."
                : "New applications and interview bookings are refused, and heads can’t accept members. Interviews already booked still go ahead; denials, cancellations and withdrawals still work."}
            </p>
          </div>

          {isOpen ? (
            // Red OUTLINE rather than a solid red button: this is the destructive
            // direction, but the click that does the damage is the one inside the
            // dialog, and that one is solid red. Two solid red buttons in a row
            // would flatten the difference between "open the question" and
            // "answer it".
            //
            // WRAPPED IN AlertDialogTrigger even though the dialog is fully
            // controlled by `confirming`. Two things this buys that a bare
            // <Button onClick> does not: the correct `aria-haspopup="dialog"` /
            // `aria-expanded` / `aria-controls` wiring for a screen reader, and a
            // populated `triggerRef` so that if anyone later removes the
            // onCloseAutoFocus on AlertDialogContent, focus degrades to the
            // trigger rather than to <body>. Radix composes its own onOpenToggle
            // AFTER our onClick, and toggling a controlled root to `true` when
            // openStopDialog has already set it true is a no-op.
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                onClick={openStopDialog}
                disabled={setState.isPending}
                className="border-red-200 text-red-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700"
              >
                Stop recruitment
              </Button>
            </AlertDialogTrigger>
          ) : (
            // Reopening is the SAFE direction and gets no dialog: it restores the
            // app's normal behaviour, and a confirmation on the harmless half is
            // how people learn to click through the one that matters.
            //
            // No `mr-*` on the spinner: buttonVariants already sets `gap-2`, so a
            // margin here would double the gap against every other button in the
            // app.
            <Button
              onClick={() => setState.mutate({ state: "open" })}
              disabled={setState.isPending}
              className="bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
            >
              {setState.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Starting…
                </>
              ) : (
                "Start recruitment"
              )}
            </Button>
          )}
        </div>

        {/* What is actually in flight right now. It is here so that the number in
            the dialog's third bullet is not the first time the operator sees it —
            they decide with the figures already on screen. */}
        <div className="mt-5 flex flex-wrap items-end gap-6 border-t border-gray-100 pt-4">
          <Stat label="Awaiting review" value={data.counts.submitted} />
          <Stat label="Interviews booked" value={data.counts.scheduled} />
          <Stat label="Interviewed" value={data.counts.interviewed} />
          <p className="text-xs text-gray-500">
            across {data.counts.ccas} CCAs
          </p>
        </div>

        {/* Provenance. `updatedByName ?? updatedBy` deliberately falls through to
            the raw id: an unresolvable account or a `script:` literal is still a
            more useful record than "someone". A missing `updatedAt` means the row
            has never been written, which — because an absent row reads as OPEN —
            is not the same fact as "it was set to open", and the copy says so. */}
        <p className="mt-3 text-xs text-gray-500">
          {data.updatedAt
            ? `Last changed by ${data.updatedByName ?? data.updatedBy} on ${new Date(
                data.updatedAt,
              ).toLocaleString("en-SG", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}.`
            : "Never changed — recruitment has been open since this feature shipped."}
        </p>
        {/* Shown in BOTH states, and the second sentence is not decoration: it is
            the honest statement of the stale-open window (plan §7 R2), and it is
            what stops a JCRC believing the freeze is instantaneous. */}
        <p className="mt-1 text-xs text-gray-500">
          Changes take effect within about 15 seconds. Someone mid-way through
          applying may still get through in that window.
        </p>

        {/* A background refetch failed but we still hold a previous reading. The
            card stays exactly as it was — every control still works, and the
            state shown is the last one the server actually confirmed — with this
            strip admitting the figures may have moved. Compare the `!data`
            branch far above, which is the genuinely unreadable case. */}
        {isError && (
          <p className="mt-3 text-sm text-amber-800" role="status">
            Couldn’t refresh just now, so these figures may be out of date.{" "}
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded font-medium underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
            >
              Try again
            </button>
          </p>
        )}

        {/* Errors from the START path have no dialog to live in, so they render
            here. The STOP path's errors render inside the dialog, which stays
            open — see the confirm button below. */}
        {setState.error && !confirming && (
          <p className="mt-3 text-sm text-red-700" role="alert">
            {setStateErrorCopy(
              setState.error.message,
              setState.error.data?.code,
            )}
          </p>
        )}

        {/* Radix owns the focus TRAP, and that is the reason the primitive is
              used rather than a hand-rolled modal. It does not always own the
              RESTORE correctly, which is why this handler exists — but it is
              CONDITIONAL, and that condition is the fix for a defect the
              unconditional version introduced.

              On CANCEL and ESCAPE, Radix's own restore is right: it focuses
              `triggerRef`, i.e. the Stop button, which on those paths is still
              mounted because nothing changed `data.state`. So we return early
              WITHOUT calling preventDefault, and Radix's handler runs. (It is
              only reachable at all because round 2 added the AlertDialogTrigger;
              before that `triggerRef` was null.)

              On SUCCESS, the trigger has been destroyed by the open/closed
              ternary and there is nothing to go back to, so we take over and
              land on the status block instead. preventDefault() is what
              suppresses Radix's handler AND FocusScope's fallback:
              composeEventHandlers runs ours first and skips theirs when default
              is prevented. */}
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            // Defer to Radix ONLY when there is something for it to restore to.
            // The trigger is rendered only while `isOpen`, so `isOpen` is the
            // test for "does the Stop button still exist". Both terms are
            // needed and neither is redundant:
            //   - the ref catches the SUCCESS path, where the dialog closes on
            //     setConfirming(false) BEFORE the invalidation resolves, so
            //     `isOpen` is still true at this instant even though the flip
            //     that unmounts the trigger is moments away;
            //   - `isOpen` catches the case where somebody ELSE stopped
            //     recruitment while this dialog was open (see `alreadyStopped`),
            //     where the trigger is already gone and the ref was never set.
            // Cancel and Escape on an unchanged card satisfy neither and fall
            // through to Radix's own restore, which puts focus back on the Stop
            // button — exactly where it should go.
            if (!focusStatusOnCloseRef.current && isOpen) return;
            focusStatusOnCloseRef.current = false;
            event.preventDefault();
            statusRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Stop CCA recruitment for the whole hall?
            </AlertDialogTitle>
            {/* `asChild` because the description is a list, and Radix's
                  Description renders a <p> by default — a <ul> inside a <p> is
                  invalid HTML and React will warn. The child keeps the
                  aria-describedby wiring. */}
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-gray-600">
                <p>While recruitment is stopped:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Residents can’t apply to any CCA. The Apply button is
                    disabled hall-wide.
                  </li>
                  <li>
                    Nobody can book or reschedule an interview. Slots stay
                    visible but can’t be claimed.
                  </li>
                  <li>
                    CCA heads can’t accept anyone. The Accept button is disabled
                    in every review queue.
                  </li>
                  <li>
                    Nothing already in flight is lost.{" "}
                    <strong className="font-semibold text-gray-900">
                      {data.counts.openApplications}
                    </strong>{" "}
                    open applications stay exactly where they are, interviews
                    already booked still go ahead, and heads can still deny
                    applications, open slots and add notes.
                  </li>
                </ul>
                <p>
                  You can start recruitment again at any time from this page.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          {/* R2-M3. openStopDialog fires a refetch precisely so the count in the
              bullet above is fresh. When that refetch FAILS, the card's own
              "couldn't refresh" strip is useless here: it lives inside the
              <section>, which Radix has marked aria-hidden and pointer-events:
              none for as long as this dialog is open (hideOthers is keyed on the
              Content node). So it is behind the overlay, silent to a screen
              reader, and its Try-again button is neither clickable nor tabbable
              — invisible in exactly the moment it matters. The admission has to
              live in here, next to the number it is about. */}
          {isError && (
            <p
              role="status"
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
            >
              Couldn’t refresh just now, so that figure may be out of date. The
              freeze itself is unaffected — it does not depend on this number.
            </p>
          )}

          {/* R2-M4. Somebody else stopped recruitment while this dialog was
              open. Saying so and withdrawing the confirm is better than either
              alternative: letting them confirm discards authoritative news the
              panel already has in hand, and auto-closing yanks a modal out from
              under someone mid-decision. Confirming would in fact have been
              harmless — the upsert is idempotent by design — but "harmless" is
              not the same as "honest". */}
          {alreadyStopped && (
            <p
              role="status"
              className="rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              Recruitment has already been stopped — by another manager, or by
              the break-glass script — since you opened this. There is nothing
              left to do here.
            </p>
          )}

          {/* Withdrawn along with the confirm button when the action is moot:
              a field inviting a reason for something that can no longer be done
              contradicts the notice directly above it. */}
          {!alreadyStopped && (
            <div className="space-y-1.5">
              <label
                htmlFor="recruitment-reason"
                className="block text-sm font-medium text-gray-700"
              >
                Why (optional)
              </label>
              {/* Goes into the audit row. Optional because the server treats it
                  as optional; asking for it here is what makes the record
                  readable six months later. Disabled mid-write so the text
                  cannot drift out of sync with what was actually submitted. */}
              <textarea
                id="recruitment-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={setState.isPending}
                maxLength={500}
                rows={2}
                placeholder="e.g. Recruitment window closed for AY26/27"
                aria-describedby="recruitment-reason-help"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:bg-gray-50 disabled:text-gray-500"
              />
              <p id="recruitment-reason-help" className="text-xs text-gray-500">
                Saved to the audit log with your name.
              </p>
            </div>
          )}

          {setState.error && (
            <p className="text-sm text-red-700" role="alert">
              {setStateErrorCopy(
                setState.error.message,
                setState.error.data?.code,
              )}
            </p>
          )}

          <AlertDialogFooter>
            {/* Label flips with the situation: "keep it open" is a lie once it
                is already closed, and Cancel is the only control left then. */}
            <AlertDialogCancel disabled={setState.isPending}>
              {alreadyStopped ? "Close" : "Keep recruitment open"}
            </AlertDialogCancel>
            {/* A PLAIN <button>, NOT AlertDialogAction. Action closes the dialog
                  the instant it is clicked, before the mutation resolves — which
                  throws away the error message on failure and leaves the operator
                  looking at an unchanged card with no explanation. Same reasoning,
                  same fix, and the same hand-written class string, as the confirm
                  button in src/app/scrc/_components/JcrcRosterPanel.tsx. */}
            {!alreadyStopped && (
              <button
                type="button"
                disabled={setState.isPending}
                onClick={() =>
                  setState.mutate({
                    state: "closed",
                    reason: reason.trim() || undefined,
                  })
                }
                className="inline-flex h-10 items-center justify-center rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:pointer-events-none disabled:opacity-50"
              >
                {setState.isPending ? (
                  <>
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    Stopping…
                  </>
                ) : (
                  "Yes, stop recruitment"
                )}
              </button>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </section>
    </AlertDialog>
  );
}
