import { Temporal } from "temporal-polyfill";
import { fetchWithRetry } from "./fetch.ts";

const CLOCKIFY_API_BASE = "https://api.clockify.me/api/v1";
const TIME_ENTRIES_PAGE_SIZE = 5000;

type ActiveUser = {
  id: string;
  defaultWorkspace: string;
};

type TimeEntry = {
  timeInterval: {
    start: string;
    duration: string | null;
  };
};

/**
 * Get standard headers for Clockify API requests.
 *
 * @param apiKey - The Clockify API key
 * @returns Headers object with API key authentication
 */
const getHeaders = (apiKey: string): Record<string, string> => ({
  "X-Api-Key": apiKey,
});

/**
 * Fetch the active user's profile information.
 *
 * @param apiKey - The Clockify API key
 * @returns Promise<ActiveUser> with user ID and default workspace
 * @throws Error if the API request fails
 */
export const fetchActiveUser = async (apiKey: string): Promise<ActiveUser> => {
  const response = await fetchWithRetry(`${CLOCKIFY_API_BASE}/user`, {
    method: "GET",
    headers: getHeaders(apiKey),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch active user: ${errorText}`);
  }
  const data = (await response.json()) as ActiveUser;
  return data;
};

/**
 * Fetch time entries for a user within a date range, with pagination support.
 *
 * @param apiKey - The Clockify API key
 * @param workspaceID - The workspace ID
 * @param userID - The user ID
 * @param from - Start date (inclusive)
 * @param to - End date (inclusive)
 * @returns Promise<TimeEntry[]> with all time entries in the range
 * @throws Error if any API request fails
 */
export const fetchTimeEntries = async (
  apiKey: string,
  workspaceID: string,
  userID: string,
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): Promise<TimeEntry[]> => {
  const fromString = new Date(new Date(`${from.toString()}T00:00:00Z`).getTime()).toISOString();
  const toString = new Date(new Date(`${to.toString()}T23:59:59Z`).getTime()).toISOString();

  const timeEntries: TimeEntry[] = [];

  let page = 1;
  while (true) {
    const response = await fetchWithRetry(
      `${CLOCKIFY_API_BASE}/workspaces/${workspaceID}/user/${userID}/time-entries?start=${fromString}&end=${toString}&page-size=${TIME_ENTRIES_PAGE_SIZE}&page=${page}`,
      {
        method: "GET",
        headers: getHeaders(apiKey),
      },
    );
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch time entries (page ${page}): ${errorText}`);
    }
    const data = (await response.json()) as TimeEntry[];
    timeEntries.push(...data);
    if (data.length !== TIME_ENTRIES_PAGE_SIZE) {
      break;
    }
    page += 1;
  }
  return timeEntries;
};

/**
 * Fetch and aggregate work hours for each day in a given year.
 *
 * Handles running timers (unclosed entries) by calculating elapsed time
 * from the start until now.
 *
 * @param apiKey - The Clockify API key
 * @param workspaceID - The workspace ID
 * @param userID - The user ID
 * @param year - The year to fetch data for
 * @returns Promise<Map<string, Temporal.Duration>> mapping date strings to work hours
 * @throws Error if any API request fails
 */
export const fetchYear = async (
  apiKey: string,
  workspaceID: string,
  userID: string,
  year: number,
): Promise<Map<string, Temporal.Duration>> => {
  const firstDayOfYear = Temporal.PlainDate.from({
    year,
    month: 1,
    day: 1,
  });
  const lastDayOfYear = Temporal.PlainDate.from({
    year,
    month: 12,
    day: 31,
  });
  const timeEntries = await fetchTimeEntries(
    apiKey,
    workspaceID,
    userID,
    firstDayOfYear,
    lastDayOfYear,
  );

  const durationPerDay = new Map<string, Temporal.Duration>();
  for (const entry of timeEntries) {
    const date = Temporal.PlainDate.from(entry.timeInterval.start.slice(0, 10));
    let duration: Temporal.Duration;
    if (entry.timeInterval.duration === null) {
      const start = Temporal.Instant.from(entry.timeInterval.start);
      const end = Temporal.Now.instant();
      duration = end.since(start).round({ largestUnit: "hours" });
    } else {
      duration = Temporal.Duration.from(entry.timeInterval.duration);
    }
    const currentDuration =
      durationPerDay.get(date.toString()) || Temporal.Duration.from({ seconds: 0 });
    durationPerDay.set(date.toString(), currentDuration.add(duration));
  }
  return durationPerDay;
};
