import { type Metadata } from "next";

import RemindersScreen from "./_components/RemindersScreen";

export const metadata: Metadata = {
  title: "Reminders",
  robots: { index: false, follow: false },
};

export default function RemindersPage() {
  return <RemindersScreen />;
}
