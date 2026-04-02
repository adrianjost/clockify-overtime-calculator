import { Temporal } from "temporal-polyfill";

const HOURS_PER_WORKDAY = 8;

type DurationFormat = "hoursMinutes" | "daysHoursMinutes";

/**
 * Format a Temporal.Duration into a human-readable string.
 *
 * @param duration - The duration to format
 * @param style - The format style: "hoursMinutes" (e.g., "8h 30min") or "daysHoursMinutes" (e.g., "1days 0h 30min")
 * @returns Formatted duration string
 */
export const formatDuration = (duration: Temporal.Duration, style: DurationFormat): string => {
  const roundedDuration = duration.round({
    smallestUnit: "minutes",
    largestUnit: "hours",
  });

  if (style === "hoursMinutes") {
    return `${roundedDuration.hours}h ${roundedDuration.minutes}min`;
  }

  if (style === "daysHoursMinutes") {
    const days = Math.floor(roundedDuration.hours / HOURS_PER_WORKDAY);
    const hours = roundedDuration.hours % HOURS_PER_WORKDAY;
    return `${days}days ${hours}h ${roundedDuration.minutes}min`;
  }

  // This should never happen due to TypeScript's exhaustiveness checking,
  // but we keep it as a runtime safety net.
  const exhaustive: never = style;
  throw new Error(`Invalid duration format style: ${exhaustive}`);
};
