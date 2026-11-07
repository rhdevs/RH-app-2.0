import { type Metadata } from "next";

import FeedbackForm from "./_components/FeedbackForm";

export const metadata: Metadata = {
  title: "Feedback",
  robots: { index: false, follow: false },
};

export default function FeedbackPage() {
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-gray-900">Feedback</h1>
      <p className="mb-4 text-sm text-gray-500">
        Report a bug or suggest an improvement. Only the admins can read it.
      </p>
      <FeedbackForm />
    </div>
  );
}
