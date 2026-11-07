import { type Metadata } from "next";

import MilestonesHome from "./_components/MilestonesHome";

export const metadata: Metadata = {
  title: "Milestones",
  robots: { index: false, follow: false },
};

export default function MilestonesPage() {
  return <MilestonesHome />;
}
