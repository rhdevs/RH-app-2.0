import { type Metadata } from "next";

import DisposablesScreen from "./_components/DisposablesScreen";

export const metadata: Metadata = {
  title: "Disposables",
  robots: { index: false, follow: false },
};

export default function DisposablesPage() {
  return <DisposablesScreen />;
}
