"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useSession } from "next-auth/react";
import { CalendarDays, MapPin, Users, Check, ArrowLeft } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from "~/components/ui/carousel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { formatDateRange } from "~/app/events/_lib/format";
import { ownerLabel } from "~/lib/schemas/event";
import MyCheckInQr from "./MyCheckInQr";
import {
  EVENT_ANSWER_RETENTION_DAYS,
  validateAnswers,
  type EventAnswerValue,
} from "~/lib/schemas/eventQuestion";
import EventSignupQuestions, {
  type EventAnswerDraft,
} from "~/app/events/_components/EventSignupQuestions";

/**
 * The resident's event page: banner, photo gallery, description and signup.
 * getPublic never returns the proposal — this view has no way to reach it.
 * Signup requires a matric on file (matricProcedure); a resident without one is
 * pointed at onboarding instead of the button.
 */
export default function EventDetail({ eventID }: { eventID: number }) {
  const { data: session } = useSession();
  const utils = api.useUtils();
  const query = api.event.getPublic.useQuery({ eventID }, { retry: false });
  const [error, setError] = useState<string | null>(null);

  // The custom-question dialog. NO MUTATION LIVES IN EventSignupQuestions —
  // this component owns `answers`/`formErrors` and the `signup` call itself,
  // exactly as the plan requires.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [answers, setAnswers] = useState<EventAnswerDraft>({});
  const [formErrors, setFormErrors] = useState<Record<number, string>>({});

  const hasMatric = Boolean(session?.user?.hasMatric);

  async function invalidate() {
    await Promise.all([
      utils.event.getPublic.invalidate({ eventID }),
      utils.event.listPublished.invalidate(),
    ]);
  }

  const signup = api.event.signup.useMutation({
    onSuccess: async () => {
      setDialogOpen(false);
      setAnswers({});
      setFormErrors({});
      await invalidate();
    },
    onError: (e) =>
      setError(
        e.message === "MATRIC_REQUIRED"
          ? "Add your matric number to sign up."
          : e.message === "EVENT_FULL"
            ? "This event just filled up."
            : e.message === "SIGNUP_CLOSED"
              ? "Signups have closed for this event."
              : e.message === "ANSWERS_INVALID"
                ? "Some answers need fixing — check the form above."
                : "That didn’t work. Try again.",
      ),
  });
  const cancel = api.event.cancelSignup.useMutation({ onSuccess: invalidate });

  if (query.isPending) {
    return (
      <div className="px-4 py-6 sm:px-6 lg:px-8">
        <div className="aspect-[16/6] max-h-96 w-full animate-pulse rounded-2xl bg-gray-200" />
        <div className="mt-6 h-9 w-64 animate-pulse rounded-lg bg-gray-200" />
        <div className="mt-6 h-20 w-full animate-pulse rounded-xl bg-gray-200" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return (
      <div className="px-4 py-16 text-center sm:px-6">
        <p className="text-sm font-medium text-gray-900">
          This event isn’t available.
        </p>
        <Link
          href="/events"
          className="mt-2 inline-block text-sm text-emerald-700 hover:underline"
        >
          ← All events
        </Link>
      </div>
    );
  }

  const e = query.data;
  const busy = signup.isPending || cancel.isPending;
  // A canceled event may still carry questions (someone kept the link) — the
  // dialog must never render under "Signups are closed.", so it is gated on
  // the same not-cancelled fact as the button, not just on questions.length.
  const hasQuestions = e.questions.length > 0 && !e.canceled;

  function submitAnswers() {
    const answerList: EventAnswerValue[] = Object.entries(answers).map(
      ([questionID, values]) => ({ questionID: Number(questionID), values }),
    );
    // Convenience only — the server runs this SAME function against the
    // stored questions, inside the lock, and is the real gate.
    const v = validateAnswers(e.questions, answerList);
    if (!v.ok) {
      setFormErrors(v.errors);
      return;
    }
    setFormErrors({});
    setError(null);
    signup.mutate({ eventID, answers: v.normalized });
  }

  /* One label utility, used by the fact strip below and by the section
     headings under it, so every small caps label on the page is the same
     typographic idea rather than three near-misses. */
  const LABEL = "text-xs font-semibold uppercase tracking-wider text-gray-400";

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8">
      <Link
        href="/events"
        className="inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> All events
      </Link>

      {/* CAPPED HEIGHT, not just an aspect ratio. At full width a bare
          aspect-[16/6] becomes a letterbox on a wide monitor and pushes the
          title below the fold, which is the opposite of what a banner is for. */}
      {e.bannerUrl && (
        <div className="relative mt-4 aspect-[16/6] max-h-96 w-full overflow-hidden rounded-2xl bg-gray-100">
          <Image
            src={e.bannerUrl}
            alt={e.title ?? "Event banner"}
            fill
            className="object-cover"
            sizes="100vw"
            priority
            unoptimized
          />
        </div>
      )}

      {e.canceled && (
        <div className="mt-4 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2 text-sm font-medium text-gray-600">
          This event has been cancelled.
        </div>
      )}

      <header className="mt-6">
        {/* Unconditional: a hall-wide event has ccaName null, and the old
            `{e.ccaName && (...)}` guard made the owner line silently
            vanish instead of falling back to "Hall". ownerLabel always
            returns a non-empty string. */}
        <p className="text-xs font-semibold uppercase tracking-widest text-emerald-700">
          {ownerLabel(e.ccaID, e.ccaName)}
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          {e.title?.trim() || "Untitled event"}
        </h1>
      </header>

      {/* THE FACT STRIP. When, where and how many are the three things somebody
          scans for before deciding, so they get equal weight and sit side by
          side instead of stacking as a vertical icon list that wasted the
          width. The hairlines are a 1px grid gap over a gray background, which
          keeps the three cells one rounded object rather than three boxes. */}
      <dl className="mt-6 grid gap-px overflow-hidden rounded-xl border border-gray-200 bg-gray-200 sm:grid-cols-3">
        <div className="bg-white px-4 py-3">
          <dt className={`flex items-center gap-1.5 ${LABEL}`}>
            <CalendarDays className="h-3.5 w-3.5" /> When
          </dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">
            {formatDateRange(e.startTime, e.endTime)}
          </dd>
        </div>
        <div className="bg-white px-4 py-3">
          <dt className={`flex items-center gap-1.5 ${LABEL}`}>
            <MapPin className="h-3.5 w-3.5" /> Where
          </dt>
          {/* A CELL RATHER THAN A MISSING ROW. The old markup dropped the
              location line entirely when there was none, which reads as "this
              page forgot" rather than "nobody set one". */}
          <dd
            className={
              e.location
                ? "mt-1 text-sm font-medium text-gray-900"
                : "mt-1 text-sm text-gray-400"
            }
          >
            {e.location ?? "Not set"}
          </dd>
        </div>
        <div className="bg-white px-4 py-3">
          <dt className={`flex items-center gap-1.5 ${LABEL}`}>
            <Users className="h-3.5 w-3.5" /> Going
          </dt>
          <dd className="mt-1 text-sm font-medium text-gray-900">
            {e.capacity != null
              ? `${e.signupCount} of ${e.capacity}`
              : e.signupCount}{" "}
            signed up
          </dd>
        </div>
      </dl>

      {/* TWO COLUMNS THAT BOTH CARRY CONTENT. The description and photos used
          to sit in a third band BELOW the signup box, which left the entire
          height of that box empty beside a two-line title. Moving them into
          the left column removes the gap by construction rather than by
          tuning margins, and gives the aside something to be beside. */}
      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        {/* Second on a phone: the thing you came to do is sign up, and that
            lives in the aside. First from lg up, where they sit side by side. */}
        <div className="order-2 min-w-0 lg:order-1">
          {e.publicDescription && (
            <section>
              <h2 className={LABEL}>About</h2>
              {/* max-w-prose INSIDE a full-width page. Full width is right for
                  the layout and wrong for a paragraph — 200 characters to a
                  line is unreadable. The column stretches; the sentence does
                  not. */}
              <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                {e.publicDescription}
              </p>
            </section>
          )}

          {e.photoUrls.length > 0 && (
            <section className={e.publicDescription ? "mt-8" : ""}>
              <h2 className={LABEL}>Photos</h2>
              <Carousel className="mt-3 w-full">
                <CarouselContent>
                  {e.photoUrls.map((url, i) => (
                    <CarouselItem
                      key={url}
                      className="sm:basis-1/2 xl:basis-1/3"
                    >
                      <div className="relative aspect-video overflow-hidden rounded-xl bg-gray-100">
                        <Image
                          src={url}
                          alt={`Photo ${i + 1}`}
                          fill
                          className="object-cover"
                          sizes="(min-width: 1280px) 25vw, (min-width: 640px) 40vw, 100vw"
                          unoptimized
                        />
                      </div>
                    </CarouselItem>
                  ))}
                </CarouselContent>
                {e.photoUrls.length > 1 && (
                  <>
                    <CarouselPrevious />
                    <CarouselNext />
                  </>
                )}
              </Carousel>
            </section>
          )}
        </div>

        {/* STICKY FROM lg UP. The check-in code is the one thing on this page
            somebody holds up to another person, and hunting for it by scrolling
            while standing at a door is the moment it must not be missed.
            top-24 clears the sticky header. */}
        <aside className="order-1 lg:order-2 lg:sticky lg:top-24">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            {e.canceled ? (
              <p className="text-sm text-gray-500">Signups are closed.</p>
            ) : e.mySignup ? (
              <div className="space-y-4">
                <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
                  <Check className="h-4 w-4" /> You&rsquo;re going
                </p>
                {/*
                  THE CHECK-IN CODE, SHOWN ONLY TO SOMEONE WHO IS GOING and only
                  once the door layer is switched on. MyCheckInQr renders its own
                  honest empty state when attendance is off or unconfigured, so
                  this does not have to guess — and a resident who is not signed
                  up has nothing to check in to.

                  It sits ABOVE Cancel signup deliberately: at a door the code is
                  what someone is reaching for, and putting a destructive control
                  above the thing everyone taps invites the wrong one. The note
                  about saved answers now sits BELOW it for the same reason — it
                  is reference, not what anyone opened this page for.
                */}
                <MyCheckInQr />
                {e.questions.length > 0 && (
                  <p className="text-xs leading-relaxed text-gray-500">
                    Your answers are saved. To change them, cancel your signup
                    and sign up again.
                  </p>
                )}
                {/* Ruled off. Cancelling is the only destructive control on the
                    page and must not read as the next step after the code. */}
                <div className="border-t border-gray-100 pt-4">
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      cancel.mutate({ eventID });
                    }}
                  >
                    {cancel.isPending ? "Cancelling…" : "Cancel signup"}
                  </Button>
                </div>
              </div>
            ) : e.started ? (
              <p className="text-sm text-gray-500">Signups have closed.</p>
            ) : e.full ? (
              <p className="text-sm font-medium text-gray-700">
                This event is full.
              </p>
            ) : !hasMatric ? (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">
                  Add your matric number to sign up.
                </p>
                <Button asChild className="w-full">
                  <Link href="/onboarding/matric">Add matric &amp; sign up</Link>
                </Button>
              </div>
            ) : (
              <Button
                className="w-full"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  // Phase 1 behaviour, BYTE-FOR-BYTE, when there are no
                  // questions: one tap, no dialog.
                  if (e.questions.length === 0) {
                    signup.mutate({ eventID });
                  } else {
                    setFormErrors({});
                    setDialogOpen(true);
                  }
                }}
              >
                {signup.isPending ? "Signing up…" : "Sign up"}
              </Button>
            )}
            {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          </div>
        </aside>
      </div>

      {hasQuestions && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>A few questions first</DialogTitle>
              <DialogDescription>
                {ownerLabel(e.ccaID, e.ccaName)} needs these before you can
                sign up.
              </DialogDescription>
            </DialogHeader>

            <p className="text-xs text-gray-500">
              Your answers go to this event’s organisers and to JCRC. They
              stop being available {EVENT_ANSWER_RETENTION_DAYS} days after
              the event ends.
            </p>

            <EventSignupQuestions
              questions={e.questions}
              value={answers}
              onChange={(questionID, values) =>
                setAnswers((prev) => ({ ...prev, [questionID]: values }))
              }
              errors={formErrors}
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button disabled={busy} onClick={submitAnswers}>
                {signup.isPending ? "Signing up…" : "Sign up"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
