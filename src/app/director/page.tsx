import { type Metadata } from "next";

import DirectorHome from "./_components/DirectorHome";

export const metadata: Metadata = {
  title: "Director",
  robots: { index: false, follow: false },
};

export default function DirectorPage() {
  return <DirectorHome />;
}
