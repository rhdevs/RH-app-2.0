import { type Metadata } from "next";

import NotificationList from "./_components/NotificationList";

export const metadata: Metadata = {
  title: "Notifications",
  robots: { index: false, follow: false },
};

export default function NotificationsPage() {
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold text-gray-900">
        Notifications
      </h1>
      <NotificationList />
    </div>
  );
}
