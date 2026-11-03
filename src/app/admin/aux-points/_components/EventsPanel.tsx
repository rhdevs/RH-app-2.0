"use client";

import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, type RouterOutputs } from "~/trpc/react";
import { AttendeeList } from "./AttendeeList";
import { auxErrorCopy } from "./auxCopy";
import { ErrorLine, Panel } from "./Bits";

type AuxEvent = RouterOutputs["aux"]["sources"]["events"][number];

const SEARCH_DEBOUNCE_MS = 300;

const eventDate = (startTime: number | null) =>
  startTime
    ? new Date(startTime * 1000).toLocaleDateString("en-SG", {
        timeZone: "Asia/Singapore",
      })
    : "No date";

/**
 * AUX events: any CCA's or the hall's event that JCRC has flagged. Each
 * check-in at one is worth 1 AUX. JCRC can flag or unflag at any time, and add
 * or take people off the attendance list by hand.
 */
export default function EventsPanel({
  year,
  readOnly,
  events,
  onChanged,
}: {
  year: string;
  readOnly: boolean;
  events: readonly AuxEvent[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Panel
      title="AUX events"
      description="Every check-in at an AUX event is worth 1 AUX. Flag any CCA’s event; heads can’t."
    >
      <div className="space-y-4">
        {!readOnly && <FlagSearch onChanged={onChanged} />}
        {events.length === 0 ? (
          <p className="text-sm text-gray-500">
            No events are flagged as AUX in {year}.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
            {events.map((e) => (
              <EventRow
                key={e.eventID}
                event={e}
                readOnly={readOnly}
                isOpen={open === e.eventID}
                onToggle={() => setOpen(open === e.eventID ? null : e.eventID)}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function FlagSearch({ onChanged }: { onChanged: () => void }) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);
  const found = api.aux.flaggable.useQuery(
    { query: debounced },
    { enabled: debounced.length > 0 },
  );
  const flag = api.aux.setEventAux.useMutation();

  const add = async (eventID: number) => {
    setError(null);
    try {
      await flag.mutateAsync({ eventID, aux: true });
      setQuery("");
      setDebounced("");
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium text-gray-800">
        Flag an event as AUX
      </label>
      <Input
        id={id}
        value={query}
        placeholder="Search events by title"
        onChange={(e) => setQuery(e.target.value)}
        className="max-w-md"
      />
      {debounced && found.data && (
        <ul className="max-w-md divide-y divide-gray-100 rounded-md border border-gray-200 bg-white text-sm">
          {found.data.map((e) => (
            <li
              key={e.eventID}
              className="flex items-center justify-between gap-2 px-3 py-1.5"
            >
              <span>
                {e.title ?? `Event #${e.eventID}`}
                <span className="text-xs text-gray-500">
                  {" "}
                  · {eventDate(e.startTime)} · {e.status}
                  {e.auxYear
                    ? ` · counted in ${e.auxYear}, flag to move it here`
                    : ""}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={flag.isPending}
                onClick={() => void add(e.eventID)}
              >
                Flag as AUX
              </Button>
            </li>
          ))}
          {found.data.length === 0 && (
            <li className="px-3 py-1.5 text-gray-500">No matching events.</li>
          )}
        </ul>
      )}
      <ErrorLine message={error} />
    </div>
  );
}

function EventRow({
  event,
  readOnly,
  isOpen,
  onToggle,
  onChanged,
}: {
  event: AuxEvent;
  readOnly: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const flag = api.aux.setEventAux.useMutation();
  const list = api.aux.eventAttendees.useQuery(
    { eventID: event.eventID },
    { enabled: isOpen },
  );
  const add = api.aux.addEventAttendees.useMutation();
  const remove = api.aux.removeEventAttendee.useMutation();
  const changed = () => {
    void list.refetch();
    onChanged();
  };

  const unflag = async () => {
    if (
      !window.confirm(
        `Stop counting “${event.title}” as AUX? Its ${event.attendees} check-ins will no longer count.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await flag.mutateAsync({ eventID: event.eventID, aux: false });
      onChanged();
    } catch (e) {
      setError(auxErrorCopy(e));
    }
  };

  return (
    <li className="px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          {isOpen ? (
            <ChevronDown className="h-4 w-4" aria-hidden />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden />
          )}
          <span className="font-medium text-gray-900">{event.title}</span>
          <span className="text-xs text-gray-500">
            · {eventDate(event.startTime)} · {event.attendees} checked in
            {event.status === "canceled" ? " · cancelled" : ""}
          </span>
        </button>
        {!readOnly && (
          <Button
            size="sm"
            variant="outline"
            disabled={flag.isPending}
            onClick={() => void unflag()}
          >
            Remove AUX
          </Button>
        )}
      </div>
      <ErrorLine message={error} />
      {isOpen && (
        <div className="mt-3 pl-5">
          <AttendeeList
            people={list.data?.map((p) => ({
              ...p,
              note: p.method === "manual" ? "added by JCRC" : undefined,
            }))}
            loading={list.isLoading}
            readOnly={readOnly}
            onAdd={async (text) => {
              const r = await add.mutateAsync({ eventID: event.eventID, text });
              changed();
              return r;
            }}
            onRemove={async (userID) => {
              await remove.mutateAsync({ eventID: event.eventID, userID });
              changed();
            }}
          />
        </div>
      )}
    </li>
  );
}
