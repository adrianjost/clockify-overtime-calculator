import { Temporal } from "temporal-polyfill";
import { formatDuration } from "./date.ts";

const durationPerWorkday = Temporal.Duration.from({ hours: 8 });

function formatOvertime(overtime: Temporal.Duration): string {
  const overtimeSign = overtime.sign >= 0 ? "+" : "-";
  const overtimeFormatted = formatDuration(overtime.abs(), "hoursMinutes");
  return `${overtimeSign}${overtimeFormatted}`;
}

export function buildOvertimeReport(
  year: number,
  data: Map<string, Temporal.Duration>,
): string {
  const lines: string[] = [];

  let weekExpectedWorkDuration = Temporal.Duration.from({ hours: 0 });
  let weekActualWorkDuration = Temporal.Duration.from({ hours: 0 });
  let expectedWorkDuration = Temporal.Duration.from({ hours: 0 });
  let actualWorkDuration = Temporal.Duration.from({ hours: 0 });
  const today = Temporal.Now.plainDateISO();

  for (let i = 0; ; i += 1) {
    const day = Temporal.PlainDate.from({ year, month: 1, day: 1 }).add({
      days: i,
    });
    if (Temporal.PlainDate.compare(day, today) > 0) {
      break;
    }
    if (day.dayOfWeek === 7 && weekExpectedWorkDuration.hours > 0) {
      const overtime = weekActualWorkDuration.subtract(
        weekExpectedWorkDuration,
      );
      lines.push(
        `${day.subtract({ days: 6 }).toString()} - ${day.toString()}\t${formatDuration(weekActualWorkDuration, "hoursMinutes")}/${formatDuration(weekExpectedWorkDuration, "hoursMinutes")} ${formatOvertime(overtime)}`,
      );

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

      lines.push(
        `\t${day.toString()}\t${formatDuration(workDuration, "hoursMinutes")}`,
      );
    }
  }

  if (weekActualWorkDuration.hours > 0) {
    const startOfCurrentWeek = today.subtract({ days: today.dayOfWeek - 1 });
    const overtime = weekActualWorkDuration.subtract(weekExpectedWorkDuration);
    lines.push(
      `${startOfCurrentWeek.toString()} - ${today.toString()}\t${formatDuration(weekActualWorkDuration, "hoursMinutes")}/${formatDuration(weekExpectedWorkDuration, "hoursMinutes")} ${formatOvertime(overtime)}`,
    );
  }

  const totalOvertime = actualWorkDuration.subtract(expectedWorkDuration);
  lines.push("");
  lines.push(`Total Overtime: ${formatOvertime(totalOvertime)}`);

  return lines.join("\n");
}
