import { Temporal } from "temporal-polyfill";

export const formatDuration = (
  duration: Temporal.Duration,
  style: "hoursMinutes" | "daysHoursMinutes",
): string => {
  const roundedDuration = duration.round({
    smallestUnit: "minutes",
    largestUnit: "hours",
  });
  if (style === "hoursMinutes") {
    return `${roundedDuration.hours}h ${roundedDuration.minutes}min`;
  }
  if (style === "daysHoursMinutes") {
    const days = Math.floor(roundedDuration.hours / 8);
    const hours = roundedDuration.hours % 8;
    return `${days}days ${hours}h ${roundedDuration.minutes}min`;
  }
  throw new Error("invalid style");
};
