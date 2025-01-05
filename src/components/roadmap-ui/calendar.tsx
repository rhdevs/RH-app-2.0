"use client";

import { Button } from "~/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import { cn } from "~/lib/utils";
import { getDay, getDaysInMonth, isWithinInterval } from "date-fns";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Check, ChevronsUpDown } from "lucide-react";
import { type ReactNode, createContext, useContext, useState } from "react";
import { create } from "zustand";
import { devtools } from "zustand/middleware";

export type CalendarState = {
  month: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  year: number;
  setMonth: (month: CalendarState["month"]) => void;
  setYear: (year: CalendarState["year"]) => void;
};

export const useCalendar = create<CalendarState>()(
  devtools((set) => ({
    month: new Date().getMonth() as CalendarState["month"],
    year: new Date().getFullYear(),
    setMonth: (month: CalendarState["month"]) => set(() => ({ month })),
    setYear: (year: CalendarState["year"]) => set(() => ({ year })),
  })),
);

type CalendarContextProps = {
  locale: Intl.LocalesArgument;
  startDay: number;
};

const CalendarContext = createContext<CalendarContextProps>({
  locale: "en-US",
  startDay: 0,
});

export type Status = {
  id: string;
  name: string;
  color: string;
};

export type Feature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: Status;
};

type ComboboxProps = {
  value: string;
  setValue: (value: string) => void;
  data: {
    value: string;
    label: string;
  }[];
  labels: {
    button: string;
    empty: string;
    search: string;
  };
  className?: string;
};

export const monthsForLocale = (
  localeName: Intl.LocalesArgument,
  monthFormat: Intl.DateTimeFormatOptions["month"] = "long",
) => {
  const format = (date: Date) =>
    new Intl.DateTimeFormat(localeName, { month: monthFormat }).format(date);

  return [...new Array(12).keys()].map((m) =>
    format(new Date(Date.UTC(2021, m % 12))),
  );
};

export const daysForLocale = (
  locale: Intl.LocalesArgument,
  startDay: number,
) => {
  const weekdays: string[] = [];
  const baseDate = new Date(2024, 0, startDay);

  for (let i = 0; i < 7; i++) {
    weekdays.push(
      new Intl.DateTimeFormat(locale, { weekday: "short" }).format(baseDate),
    );
    baseDate.setDate(baseDate.getDate() + 1);
  }

  return weekdays;
};

const Combobox = ({
  value,
  setValue,
  data,
  labels,
  className,
}: ComboboxProps) => {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          aria-expanded={open}
          className={cn("w-40 justify-between capitalize", className)}
        >
          {value
            ? data.find((item) => item.value === value)?.label
            : labels.button}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-0">
        <Command
          filter={(value, search) => {
            const label = data.find((item) => item.value === value)?.label;

            return label?.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput placeholder={labels.search} />
          <CommandList>
            <CommandEmpty>{labels.empty}</CommandEmpty>
            <CommandGroup>
              {data.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  onSelect={(currentValue) => {
                    setValue(currentValue === value ? "" : currentValue);
                    setOpen(false);
                  }}
                  className="capitalize"
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === item.value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

type OutOfBoundsDayProps = {
  day: number;
};

const OutOfBoundsDay = ({ day }: OutOfBoundsDayProps) => (
  <div className="relative h-full w-full bg-secondary p-1 text-xs text-muted-foreground">
    {day}
  </div>
);

export type CalendarBodyProps = {
  features: Feature[];
};

export const CalendarBody = ({ features }: CalendarBodyProps) => {
  const { month, year } = useCalendar();
  const { startDay } = useContext(CalendarContext);
  const daysInMonth = getDaysInMonth(new Date(year, month, 1));
  const firstDay = (getDay(new Date(year, month, 1)) - startDay + 7) % 7;
  const days: ReactNode[] = [];

  const prevMonth = month === 0 ? 11 : month - 1;
  const prevMonthYear = month === 0 ? year - 1 : year;
  const prevMonthDays = getDaysInMonth(new Date(prevMonthYear, prevMonth, 1));
  const prevMonthDaysArray = Array.from(
    { length: prevMonthDays },
    (_, i) => i + 1,
  );

  const [selectedDay, setSelectedDay] = useState(new Date());
  const [selectedFeatures, setSelectedFeatures] = useState<Feature[]>([]);
  const handleDayClick = (day: Date) => {
    const featuresForDay = features.filter((feature) =>
      isWithinInterval(day, {
        start: new Date(feature.startAt),
        end: new Date(feature.endAt),
      }),
    );
    setSelectedDay(day);
    setSelectedFeatures(featuresForDay);
  };

  for (let i = 0; i < firstDay; i++) {
    const day = prevMonthDaysArray[prevMonthDays - firstDay + i];

    if (day) {
      days.push(<OutOfBoundsDay key={`prev-${i}`} day={day} />);
    }
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month, day);
    const featuresForDay = features.filter((feature) => {
      return isWithinInterval(currentDate, {
        start: new Date(feature.startAt),
        end: new Date(feature.endAt),
      });
    });

    days.push(
      <div
        key={day}
        className="relative flex h-full w-full flex-col gap-1 p-1 text-xs text-muted-foreground"
        onClick={() => handleDayClick(currentDate)}
      >
        <span>{day}</span>
        <div className="flex flex-wrap gap-1">
          {featuresForDay.slice(0, 3).map((feature) => (
            <>
              {/* Dot for small screens */}
              <div
                className={`block h-2 w-2 rounded-full md:hidden`}
                style={{ backgroundColor: feature.status.color }}
              />

              {/* Full item for larger screens */}
              <CalendarItem
                feature={feature}
                className="hidden bg-[hsl(280,100%,70%)] text-white md:flex"
              />
            </>
          ))}
        </div>
        {featuresForDay.length > 3 && (
          <span className="block text-xs text-muted-foreground">
            +{featuresForDay.length - 3} more
          </span>
        )}
      </div>,
    );
  }

  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  const nextMonthDays = getDaysInMonth(new Date(nextMonthYear, nextMonth, 1));
  const nextMonthDaysArray = Array.from(
    { length: nextMonthDays },
    (_, i) => i + 1,
  );

  const remainingDays = 7 - ((firstDay + daysInMonth) % 7);
  if (remainingDays < 7) {
    for (let i = 0; i < remainingDays; i++) {
      const day = nextMonthDaysArray[i];

      if (day) {
        days.push(<OutOfBoundsDay key={`next-${i}`} day={day} />);
      }
    }
  }

  return (
    <div className="flex flex-col">
      <div className="grid grid-cols-7 grid-rows-1 sm:grid-rows-3">
        {days.map((day, index) => (
          <div key={index} className="col-span-1 row-span-3 sm:row-span-1">
            {day}
          </div>
        ))}
      </div>
      <SelectedDayDetails
        selectedDate={selectedDay}
        features={selectedFeatures}
      />
    </div>
  );
};

export type CalendarDatePickerProps = {
  className?: string;
  children: ReactNode;
};

export const CalendarDatePicker = ({
  className,
  children,
}: CalendarDatePickerProps) => (
  <div className={cn("flex items-center gap-1", className)}>{children}</div>
);

export type CalendarMonthPickerProps = {
  className?: string;
};

export const CalendarMonthPicker = ({
  className,
}: CalendarMonthPickerProps) => {
  const { month, setMonth } = useCalendar();
  const { locale } = useContext(CalendarContext);

  return (
    <Combobox
      className={className}
      value={month.toString()}
      setValue={(value) =>
        setMonth(Number.parseInt(value) as CalendarState["month"])
      }
      data={monthsForLocale(locale).map((month, index) => ({
        value: index.toString(),
        label: month,
      }))}
      labels={{
        button: "Select month",
        empty: "No month found",
        search: "Search month",
      }}
    />
  );
};

export type CalendarYearPickerProps = {
  className?: string;
  start: number;
  end: number;
};

export const CalendarYearPicker = ({
  className,
  start,
  end,
}: CalendarYearPickerProps) => {
  const { year, setYear } = useCalendar();

  return (
    <Combobox
      className={className}
      value={year.toString()}
      setValue={(value) => setYear(Number.parseInt(value))}
      data={Array.from({ length: end - start + 1 }, (_, i) => ({
        value: (start + i).toString(),
        label: (start + i).toString(),
      }))}
      labels={{
        button: "Select year",
        empty: "No year found",
        search: "Search year",
      }}
    />
  );
};

export type CalendarDatePaginationProps = {
  className?: string;
};

export const CalendarDatePagination = ({
  className,
}: CalendarDatePaginationProps) => {
  const { month, year, setMonth, setYear } = useCalendar();

  const handlePreviousMonth = () => {
    if (month === 0) {
      setMonth(11);
      setYear(year - 1);
    } else {
      setMonth((month - 1) as CalendarState["month"]);
    }
  };

  const handleNextMonth = () => {
    if (month === 11) {
      setMonth(0);
      setYear(year + 1);
    } else {
      setMonth((month + 1) as CalendarState["month"]);
    }
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Button onClick={() => handlePreviousMonth()} variant="ghost" size="icon">
        <ChevronLeftIcon size={16} />
      </Button>
      <Button onClick={() => handleNextMonth()} variant="ghost" size="icon">
        <ChevronRightIcon size={16} />
      </Button>
    </div>
  );
};

export type CalendarDateProps = {
  children: ReactNode;
};

export const CalendarDate = ({ children }: CalendarDateProps) => (
  <div className="flex items-center justify-between p-3">{children}</div>
);

export type CalendarHeaderProps = {
  className?: string;
};

export const CalendarHeader = ({ className }: CalendarHeaderProps) => {
  const { locale, startDay } = useContext(CalendarContext);

  return (
    <div className={cn("grid flex-grow grid-cols-7", className)}>
      {daysForLocale(locale, startDay).map((day) => (
        <div key={day} className="p-3 text-right text-xs text-muted-foreground">
          {day}
        </div>
      ))}
    </div>
  );
};

export type CalendarItemProps = {
  feature: Feature;
  className?: string;
};

export const CalendarItem = ({ feature, className }: CalendarItemProps) => (
  <div
    className={`flex min-h-8 items-center justify-between rounded-lg px-2 py-1 text-white ${className}`}
    style={{ backgroundColor: feature.status.color }}
    key={feature.id}
  >
    <span className="truncate text-xs">{feature.name}</span>
  </div>
);

export type CalendarProviderProps = {
  locale?: Intl.LocalesArgument;
  startDay?: number;
  children: ReactNode;
  className?: string;
};

export const CalendarProvider = ({
  locale = "en-US",
  startDay = 0,
  children,
  className,
}: CalendarProviderProps) => (
  <CalendarContext.Provider value={{ locale, startDay }}>
    <div className={cn("relative flex flex-col", className)}>{children}</div>
  </CalendarContext.Provider>
);

export type SelectedDayDetailsProps = {
  selectedDate: Date | null;
  features: Feature[];
};

export const SelectedDayDetails = ({
  selectedDate,
  features,
}: SelectedDayDetailsProps) => {
  if (!selectedDate || features.length === 0) {
    return (
      <div className="mt-2 rounded-lg bg-background p-4 shadow-md">
        <h2 className="text-lg font-semibold text-foreground">
          No events on this day
        </h2>
      </div>
    );
  }

  const formatDateTime = (date: Date) => {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(date);
  };

  // Remove if db is sorted
  const sortedFeatures = features.sort(
    (a, b) => a.startAt.getTime() - b.startAt.getTime(),
  );

  return (
    <div className="mt-2 rounded-lg bg-background p-4 shadow-md">
      <h2 className="text-lg font-semibold text-foreground">
        Events on{" "}
        {new Intl.DateTimeFormat("en-US", {
          month: "long",
          day: "2-digit",
        }).format(selectedDate)}
      </h2>
      <ul className="mt-2 space-y-2">
        {sortedFeatures.map((feature) => (
          <li
            key={feature.id}
            className="mt-1 rounded p-2"
            style={{ backgroundColor: feature.status.color }}
          >
            <div className="font-semibold text-white">{feature.name}</div>
            <div className="text-sm text-white opacity-75">
              {formatDateTime(feature.startAt)} to{" "}
              {formatDateTime(feature.endAt)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};
