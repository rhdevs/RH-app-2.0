"use client";

import { EVENT_PUBLIC_DESCRIPTION_MAX } from "~/lib/schemas/event";
import EventImageField from "./EventImageField";
import EventGalleryField from "./EventGalleryField";

export type PublicFieldsValue = {
  bannerUrl: string | null;
  photoUrls: string[];
  publicDescription: string;
};

/**
 * Banner, gallery and public description: what residents see on the event
 * page. Shared by the draft editor and the live editor so the two can never
 * word or validate them differently.
 */
export default function EventPublicFields({
  eventID,
  value,
  onChange,
  disabled,
}: {
  eventID: number;
  value: PublicFieldsValue;
  onChange: (patch: Partial<PublicFieldsValue>) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-5">
      <EventImageField
        eventID={eventID}
        label="Banner"
        help="The wide image residents see first. Required before it goes live."
        value={value.bannerUrl}
        onChange={(bannerUrl) => onChange({ bannerUrl })}
        disabled={disabled}
      />

      <EventGalleryField
        eventID={eventID}
        value={value.photoUrls}
        onChange={(photoUrls) => onChange({ photoUrls })}
        disabled={disabled}
      />

      <div className="space-y-1.5">
        <label
          htmlFor={`event-${eventID}-public-description`}
          className="block text-sm font-medium text-gray-700"
        >
          Public description
        </label>
        <p className="text-xs text-gray-500">
          What residents read on the event page. Required before it goes live.
        </p>
        <textarea
          id={`event-${eventID}-public-description`}
          value={value.publicDescription}
          maxLength={EVENT_PUBLIC_DESCRIPTION_MAX}
          rows={6}
          disabled={disabled}
          onChange={(e) => onChange({ publicDescription: e.target.value })}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          placeholder="Tell residents what to expect…"
        />
        <p className="text-right text-xs text-gray-500">
          {value.publicDescription.length}/{EVENT_PUBLIC_DESCRIPTION_MAX}
        </p>
      </div>
    </div>
  );
}
