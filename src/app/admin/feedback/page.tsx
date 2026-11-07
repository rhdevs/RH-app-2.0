"use client";

import FeedbackList from "./_components/FeedbackList";

export default function AdminFeedbackPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Feedback</h1>
        <p className="text-sm text-gray-500">
          Reports sent from the in-app form, newest first.
        </p>
      </div>
      <FeedbackList />
    </div>
  );
}
