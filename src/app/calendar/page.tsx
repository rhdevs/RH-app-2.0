import { type Metadata } from "next";

import CalendarFeedPanel from "./_components/CalendarFeedPanel";
import CalendarView from "./_components/CalendarView";

export const metadata: Metadata = {
  title: "Calendar",
  robots: { index: false, follow: false },
};

export default function CalendarPage() {
  return (
    <div className="space-y-8">
      <CalendarView />
      <CalendarFeedPanel />
    </div>
  );
}
