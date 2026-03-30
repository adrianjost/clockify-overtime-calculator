import { Temporal } from "temporal-polyfill";
import { formatDuration } from "./date.ts";

const WORKDAY_HOURS = 8;
const durationPerWorkday = Temporal.Duration.from({ hours: WORKDAY_HOURS });

export interface OvertimeData {
  totalOvertimeHours: number;
  totalOvertimeMinutes: number;
  dailyData: Array<{
    date: string;
    actualHours: number;
    expectedHours: number;
    cumulativeOvertimeHours: number;
  }>;
}

/**
 * Build overtime data for a given year from time entries.
 *
 * Calculates daily and cumulative overtime by comparing actual work hours
 * to expected 8-hour workdays (excluding weekends).
 *
 * @param year - The year to analyze
 * @param data - Map of date strings to Temporal.Duration of work hours
 * @returns OvertimeData with daily breakdowns and totals
 */
export function buildOvertimeData(
  year: number,
  data: Map<string, Temporal.Duration>,
): OvertimeData {
  const dailyData: OvertimeData["dailyData"] = [];
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

    const workDuration = data.get(day.toString());
    if (workDuration) {
      let expectedHours = 0;
      if (day.dayOfWeek !== 6 && day.dayOfWeek !== 7) {
        expectedWorkDuration = expectedWorkDuration.add(durationPerWorkday);
        expectedHours = WORKDAY_HOURS;
      }
      actualWorkDuration = actualWorkDuration.add(workDuration);
      const cumulativeOvertime =
        actualWorkDuration.subtract(expectedWorkDuration);
      dailyData.push({
        date: day.toString(),
        actualHours: workDuration.hours + workDuration.minutes / 60,
        expectedHours,
        cumulativeOvertimeHours:
          cumulativeOvertime.hours + cumulativeOvertime.minutes / 60,
      });
    }
  }

  const totalOvertime = actualWorkDuration.subtract(expectedWorkDuration);
  return {
    totalOvertimeHours: totalOvertime.hours,
    totalOvertimeMinutes: totalOvertime.minutes,
    dailyData,
  };
}

/**
 * Format an overtime duration with sign and spacing.
 *
 * @param overtime - The overtime duration
 * @returns Formatted string with sign, e.g., "+8h 30min" or "-2h 0min"
 */
function formatOvertime(overtime: Temporal.Duration): string {
  const overtimeSign = overtime.sign >= 0 ? "+" : "-";
  const overtimeFormatted = formatDuration(overtime.abs(), "hoursMinutes");
  return `${overtimeSign}${overtimeFormatted}`;
}

/**
 * Build a human-readable overtime report for a year.
 *
 * Generates a report with weekly and daily breakdowns of actual vs. expected hours
 * and cumulative overtime.
 *
 * @param year - The year to report on
 * @param data - Map of date strings to Temporal.Duration of work hours
 * @returns Multi-line string report
 */
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
