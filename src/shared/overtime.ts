import type { OvertimeData, TrackedEntry } from "./rpc.ts";

// Mirrors macos/ClockifyOvertime/Clockify/OvertimeReport.swift for the web UI.

const WORKDAY_SECONDS = 8 * 3600;

export function localIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Midnight at the start of the day, `days` later, in the local time zone. */
export function localMidnight(isoDate: string, days = 0): Date {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return date;
}

/** Seconds worked per local day, counting each entry on the day it started. */
export function secondsPerDay(entries: TrackedEntry[], now = Date.now()): Map<string, number> {
  const result = new Map<string, number>();
  for (const entry of entries) {
    const start = Date.parse(entry.start);
    const end = entry.end ? Date.parse(entry.end) : now;
    const day = localIsoDate(new Date(start));
    result.set(day, (result.get(day) ?? 0) + Math.max(0, end - start) / 1000);
  }
  return result;
}

/**
 * Compares worked hours to expected 8-hour workdays (excluding weekends).
 * Days without any time entry count neither as worked nor as expected.
 */
export function buildOvertime(
  worked: Map<string, number>,
  startDate: string,
  endDate: string,
): OvertimeData {
  const truncatedHours = (seconds: number) => Math.trunc(seconds / 60) / 60;
  const dailyData: OvertimeData["dailyData"] = [];
  let expected = 0;
  let actual = 0;

  for (let day = startDate; day <= endDate; day = localIsoDate(localMidnight(day, 1))) {
    const seconds = worked.get(day);
    if (seconds !== undefined) {
      const weekday = localMidnight(day).getDay();
      const expectedHours = weekday === 0 || weekday === 6 ? 0 : WORKDAY_SECONDS / 3600;
      expected += expectedHours * 3600;
      actual += seconds;
      dailyData.push({
        date: day,
        actualHours: truncatedHours(seconds),
        expectedHours,
        cumulativeOvertimeHours: truncatedHours(actual - expected),
      });
    } else if ((day === startDate && dailyData.length === 0) || day === endDate) {
      // Anchor entries for start/end date so the range is complete.
      dailyData.push({
        date: day,
        actualHours: 0,
        expectedHours: 0,
        cumulativeOvertimeHours: truncatedHours(actual - expected),
      });
    }
  }

  const totalMinutes = Math.trunc((actual - expected) / 60);
  return {
    totalOvertimeHours: Math.trunc(totalMinutes / 60),
    totalOvertimeMinutes: totalMinutes % 60,
    dailyData,
  };
}
