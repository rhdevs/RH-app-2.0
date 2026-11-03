import { type Metadata } from "next";

import ItemsScreen from "../_components/ItemsScreen";

export const metadata: Metadata = {
  title: "Equipment list",
  robots: { index: false, follow: false },
};

export default function EquipmentItemsPage() {
  return <ItemsScreen />;
}
