"use client";

import { useState } from "react";

import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  feedbackSubmitInput,
  type FeedbackCategory,
} from "~/lib/schemas/feedback";
import { api } from "~/trpc/react";

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: "Bug",
  suggestion: "Suggestion",
  other: "Other",
};

/** Inert (one line of text) while `feedback.enabled` is off. */
export default function FeedbackForm() {
  const enabledQuery = api.feedback.enabled.useQuery(undefined, {
    retry: false,
  });
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = api.feedback.submit.useMutation({
    onSuccess: () => {
      setMessage("");
      setSent(true);
    },
    onError: (e) =>
      setError(
        e.message.startsWith("RATE_LIMITED")
          ? "You have sent a lot of feedback recently. Please try again later."
          : "Could not send your feedback. Try again shortly.",
      ),
  });

  if (enabledQuery.isLoading) {
    return <p className="text-sm text-gray-500">Loading…</p>;
  }
  if (enabledQuery.data?.enabled !== true) {
    return (
      <p className="text-sm text-gray-500">
        In-app feedback is not switched on yet. Please use the form linked at
        the foot of the page.
      </p>
    );
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSent(false);
    const parsed = feedbackSubmitInput.safeParse({ category, message });
    if (!parsed.success) {
      setError("Write a message of up to 2000 characters.");
      return;
    }
    setError(null);
    submit.mutate(parsed.data);
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-gray-700">Type</legend>
        <div className="flex gap-4">
          {FEEDBACK_CATEGORIES.map((c) => (
            <label key={c} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="category"
                value={c}
                checked={category === c}
                onChange={() => setCategory(c)}
              />
              {CATEGORY_LABEL[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label
          htmlFor="feedback-message"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          Message
        </label>
        <textarea
          id="feedback-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={FEEDBACK_MESSAGE_MAX}
          rows={6}
          className="w-full rounded-lg border border-gray-300 p-3 text-sm focus:border-emerald-600 focus:outline-none focus:ring-1 focus:ring-emerald-600"
        />
        <p className="mt-1 text-right text-xs text-gray-500">
          {message.length} / {FEEDBACK_MESSAGE_MAX}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {sent && (
        <p role="status" className="text-sm text-emerald-700">
          Thank you. Your feedback was sent to the admins.
        </p>
      )}
      <button
        type="submit"
        disabled={submit.isPending || message.trim() === ""}
        className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:bg-gray-300"
      >
        {submit.isPending ? "Sending…" : "Send feedback"}
      </button>
    </form>
  );
}
