"use client";

import Link from "next/link";
import { Boxes } from "lucide-react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { equipmentNewHref } from "~/lib/equipment/links";

/**
 * "Borrow equipment" on an event's page, opening the loan form with this event
 * chosen. Shown ONLY to someone who may file for this event right now: the
 * server answers that from the stored rows (`equipment.canFile`), the same rule
 * the filing applies. When the switch is off, the answer is no, or the read
 * fails, nothing is drawn. Not a guard: filing checks again.
 */
export default function EquipmentLoanLink({ eventID }: { eventID: number }) {
  const can = api.equipment.canFile.useQuery(
    { eventID },
    { retry: false, staleTime: 60_000 },
  );
  if (can.data?.canFile !== true) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={equipmentNewHref(eventID)}>
        <Boxes className="mr-1.5 h-4 w-4" />
        Borrow equipment
      </Link>
    </Button>
  );
}
