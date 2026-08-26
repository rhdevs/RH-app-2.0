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
import { formatDateRange } from "~/app/events/_lib/format";
import { ownerLabel } from "~/lib/schemas/event";

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

  const hasMatric = Boolean(session?.user?.hasMatric);

  async function invalidate() {
    await Promise.all([
      utils.event.getPublic.invalidate({ eventID }),
      utils.event.listPublished.invalidate(),
    ]);
  }

  const signup = api.event.signup.useMutation({
    onSuccess: invalidate,
    onError: (e) =>
      setError(
        e.message === "MATRIC_REQUIRED"
          ? "Add your matric number to sign up."
          : e.message === "EVENT_FULL"
            ? "This event just filled up."
            : e.message === "SIGNUP_CLOSED"
              ? "Signups have closed for this event."
              : "That didn’t work. Try again.",
      ),
  });
  const cancel = api.event.cancelSignup.useMutation({ onSuccess: invalidate });

  if (query.isPending) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="h-64 animate-pulse rounded-2xl bg-gray-200" />
      </div>
    );
  }
  if (query.error || !query.data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-center">
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

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <Link
        href="/events"
        className="mb-4 inline-flex items-center gap-1 text-sm text-emerald-700 hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> All events
      </Link>

      {e.bannerUrl && (
        <div className="relative mb-5 aspect-[16/6] w-full overflow-hidden rounded-2xl bg-gray-100">
          <Image
            src={e.bannerUrl}
            alt={e.title ?? "Event banner"}
            fill
            className="object-cover"
            sizes="768px"
            priority
            unoptimized
          />
        </div>
      )}

      {e.canceled && (
        <div className="mb-4 rounded-lg border border-gray-300 bg-gray-100 px-4 py-2 text-sm font-medium text-gray-600">
          This event has been cancelled.
        </div>
      )}

      <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Unconditional: a hall-wide event has ccaName null, and the old
              `{e.ccaName && (...)}` guard made the owner line silently
              vanish instead of falling back to "Hall". ownerLabel always
              returns a non-empty string. */}
          <p className="text-sm font-medium text-emerald-700">
            {ownerLabel(e.ccaID, e.ccaName)}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-gray-900">
            {e.title?.trim() || "Untitled event"}
          </h1>
          <div className="mt-3 space-y-1.5 text-sm text-gray-600">
            <p className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-gray-400" />
              {formatDateRange(e.startTime, e.endTime)}
            </p>
            {e.location && (
              <p className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-gray-400" />
                {e.location}
              </p>
            )}
            <p className="flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-400" />
              {e.signupCount}
              {e.capacity != null ? `/${e.capacity}` : ""} going
            </p>
          </div>
        </div>

        {/* Signup box */}
        <div className="w-full shrink-0 rounded-xl border border-gray-200 bg-white p-4 sm:w-64">
          {e.canceled ? (
            <p className="text-sm text-gray-500">Signups are closed.</p>
          ) : e.mySignup ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <Check className="h-4 w-4" /> You&rsquo;re going
              </p>
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
          ) : e.started ? (
            <p className="text-sm text-gray-500">Signups have closed.</p>
          ) : e.full ? (
            <p className="text-sm font-medium text-gray-700">
              This event is full.
            </p>
          ) : !hasMatric ? (
            <div className="space-y-2">
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
                signup.mutate({ eventID });
              }}
            >
              {signup.isPending ? "Signing up…" : "Sign up"}
            </Button>
          )}
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        </div>
      </div>

      {e.publicDescription && (
        <div className="mt-6 whitespace-pre-wrap border-t border-gray-100 pt-6 text-sm leading-relaxed text-gray-700">
          {e.publicDescription}
        </div>
      )}

      {e.photoUrls.length > 0 && (
        <div className="mt-8">
          <Carousel className="w-full">
            <CarouselContent>
              {e.photoUrls.map((url, i) => (
                <CarouselItem key={url} className="sm:basis-1/2">
                  <div className="relative aspect-video overflow-hidden rounded-xl bg-gray-100">
                    <Image
                      src={url}
                      alt={`Photo ${i + 1}`}
                      fill
                      className="object-cover"
                      sizes="384px"
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
        </div>
      )}
    </div>
  );
}
