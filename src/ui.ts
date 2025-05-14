import { Temporal } from "temporal-polyfill";
import { formatDuration, isAfter, maxDate, minDate } from "./date";

const weekendDays = [6, 7];
const durationPerWorkday = Temporal.Duration.from({ hours: 8 });

/**
 * Format overtime with color and sign
 */
function formatOvertime(overtime: Temporal.Duration): string {
  const overtimeSign = overtime.sign >= 0 ? "+" : "-";
  const overtimeFormatted = formatDuration(overtime.abs(), "hoursMinutes");
  const overtimeColor = overtime.sign >= 0 ? "\x1b[32m" : "\x1b[31m";
  const resetColor = "\x1b[0m";
  return `${overtimeColor}${overtimeSign}${overtimeFormatted}${resetColor}`;
}

/**
 *
 * @param data A map of Temporal.PlainDate stringified to Temporal.Duration
 */
export function visualize(
  year: number,
  data: Map<string, Temporal.Duration>
): void {
  // assume all days that I worked on are working days with 8h, and all others are not.
  let weekExpectedWorkDuration = Temporal.Duration.from({ hours: 0 });
  let weekActualWorkDuration = Temporal.Duration.from({ hours: 0 });
  let expectedWorkDuration = Temporal.Duration.from({ hours: 0 });
  let actualWorkDuration = Temporal.Duration.from({ hours: 0 });
  const today = Temporal.Now.plainDateISO();
  for (let i = 0; ; i++) {
    const day = Temporal.PlainDate.from({ year, month: 1, day: 1 }).add({
      days: i,
    });
    if (Temporal.PlainDate.compare(day, today) > 0) {
      break;
    }
    if (day.dayOfWeek === 7 && weekExpectedWorkDuration.hours > 0) {
      const overtime = weekActualWorkDuration.subtract(
        weekExpectedWorkDuration
      );
      const weekString = `${day.subtract({ days: 6 }).toString()} - ${day.toString()}\t${formatDuration(
        weekActualWorkDuration,
        "hoursMinutes"
      )}/${formatDuration(weekExpectedWorkDuration, "hoursMinutes")} ${formatOvertime(overtime)}`;
      console.log(weekString);

      weekExpectedWorkDuration = Temporal.Duration.from({ hours: 0 });
      weekActualWorkDuration = Temporal.Duration.from({ hours: 0 });
    }
    const workDuration = data.get(day.toString());
    if (workDuration) {
      if (day.dayOfWeek !== 6 && day.dayOfWeek !== 7) {
        expectedWorkDuration = expectedWorkDuration.add(durationPerWorkday);
        weekExpectedWorkDuration =
          weekExpectedWorkDuration.add(durationPerWorkday);
      }
      actualWorkDuration = actualWorkDuration.add(workDuration);
      weekActualWorkDuration = weekActualWorkDuration.add(workDuration);

      const dayString = `\t${day.toString()}\t${formatDuration(
        workDuration,
        "hoursMinutes"
      )}`;
      console.log(dayString);
    }
  }
  if (weekActualWorkDuration.hours > 0) {
    const startOfCurrentWeek = today.subtract({ days: today.dayOfWeek - 1 });
    const overtime = weekActualWorkDuration.subtract(weekExpectedWorkDuration);
    const weekString = `${startOfCurrentWeek.toString()} - ${today.toString()}\t${formatDuration(
      weekActualWorkDuration,
      "hoursMinutes"
    )}/${formatDuration(weekExpectedWorkDuration, "hoursMinutes")} ${formatOvertime(overtime)}`;
    console.log(weekString);
  }

  const totalOvertime = actualWorkDuration.subtract(expectedWorkDuration);

  console.log(
    "\x1b[1m",
    "\nTotal Overtime:",
    formatOvertime(totalOvertime),
    "\x1b[0m"
  );
}
