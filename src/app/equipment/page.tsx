import { type Metadata } from "next";

import EquipmentBoard from "./_components/EquipmentBoard";

export const metadata: Metadata = {
  title: "Equipment",
  robots: { index: false, follow: false },
};

export default function EquipmentPage() {
  return <EquipmentBoard />;
}
