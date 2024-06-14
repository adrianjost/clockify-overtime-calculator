import { Temporal } from "temporal-polyfill";
import { formatDuration, isAfter, maxDate, minDate } from "./date";

const weekendDays = [6, 7];
const durationPerWorkday = Temporal.Duration.from({ hours: 8 });

/**
 *
 * @param data A map of Temporal.PlainDate stringified to Temporal.Duration
 */
export function visualize(
  year: number,
  data: Map<string, Temporal.Duration>,
): void {
  const firstDayOfYear = Temporal.PlainDate.from({ year, month: 1, day: 1 });
  const lastDayOfYear = Temporal.PlainDate.from({ year, month: 12, day: 31 });

  let totalOvertime = Temporal.Duration.from({ hours: 0 });
  const today = Temporal.Now.plainDateISO();

  for (let i = 0; ; i++) {
    const dayOfWeek = firstDayOfYear.add({ weeks: i });
    const weekStart = maxDate(
      dayOfWeek.subtract({ days: dayOfWeek.dayOfWeek - 1 }),
      firstDayOfYear,
    );
    const unlimitedWeekEnd = weekStart.add({ days: 7 - weekStart.dayOfWeek });
    const weekEnd = minDate(unlimitedWeekEnd, today, lastDayOfYear);

    // only calculate until today
    if (isAfter(weekStart, today)) {
      break;
    }
    if (isAfter(unlimitedWeekEnd, lastDayOfYear)) {
      break;
    }

    const numberOfWorkDays =
      weekEnd.dayOfYear - weekStart.dayOfYear + 1 - weekendDays.length;
    let totalWorkDuration = Temporal.Duration.from({ hours: 0 });

    for (let j = 0; j < numberOfWorkDays; j++) {
      const day = weekStart.add({ days: j });
      const duration = data.get(day.toString());
      if (duration) {
        totalWorkDuration = totalWorkDuration.add(duration);
      }
    }

    const expectedWorkDuration = Temporal.Duration.from({
      hours: durationPerWorkday.hours * numberOfWorkDays,
    });

    const overtime = totalWorkDuration.subtract(expectedWorkDuration);
    totalOvertime = totalOvertime.add(overtime);
    console.log(
      i + 1,
      "-",
      weekStart.toString(),
      "-",
      weekEnd.toString(),
      "\t",
      formatDuration(totalWorkDuration, "hoursMinutes"),
      "\t",
      formatDuration(overtime, "hoursMinutes"),
    );

    for (let j = 0; j < numberOfWorkDays; j++) {
      const day = weekStart.add({ days: j });
      const duration = data.get(day.toString());
      if (duration) {
        console.log(
          "\t",
          day.toString(),
          "\t",
          formatDuration(duration, "hoursMinutes"),
        );
      }
    }
  }

  console.log(
    "\x1b[1m",
    "\nTotal Overtime:",
    formatDuration(totalOvertime, "daysHoursMinutes"),
    "\x1b[0m",
  );
}
