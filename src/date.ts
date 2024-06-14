import { Temporal } from "temporal-polyfill";

/**
 * Is `a` before `b`?
 */
export const isBefore = (
  a: Temporal.PlainDate,
  b: Temporal.PlainDate,
): boolean => Temporal.PlainDate.compare(a, b) === -1;

/**
 * Is `a` after `b`?
 */
export const isAfter = (
  a: Temporal.PlainDate,
  b: Temporal.PlainDate,
): boolean => Temporal.PlainDate.compare(a, b) === 1;

export const minDate = (...dates: Temporal.PlainDate[]): Temporal.PlainDate => {
  return dates.reduce((currentMin, candidate) =>
    isBefore(candidate, currentMin) ? candidate : currentMin,
  );
};

export const maxDate = (
  ...dates: readonly Temporal.PlainDate[]
): Temporal.PlainDate =>
  dates.reduce((currentMax, candidate) =>
    isAfter(candidate, currentMax) ? candidate : currentMax,
  );

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
