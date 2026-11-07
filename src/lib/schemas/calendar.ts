import { z } from "zod";

import { CALENDAR_MAX_YEAR, CALENDAR_MIN_YEAR } from "~/lib/calendar/month";

export const calendarMonthInput = z.object({
  year: z.number().int().min(CALENDAR_MIN_YEAR).max(CALENDAR_MAX_YEAR),
  month: z.number().int().min(1).max(12),
});
