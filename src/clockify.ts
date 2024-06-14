import { Temporal } from "temporal-polyfill";
import { fetchWithRetry } from "./fetch";
import { options } from "./cli";

const apiKey = options.apiKey;

export const fetchActiveUser = async () => {
  const response = await fetchWithRetry("https://api.clockify.me/api/v1/user", {
    method: "GET",
    headers: {
      "X-Api-Key": apiKey,
    },
  });
  if (!response.ok) {
    console.log(await response.text());
    throw new Error("Failed to fetch user");
  }
  const data = await response.json();
  return data;
};

export const fetchTimeEntries = async (
  workspaceID: string,
  userID: string,
  from: Temporal.PlainDate,
  to: Temporal.PlainDate,
): Promise<Record<string, unknown>[]> => {
  const fromString = new Date(
    new Date(`${from.toString()}T00:00:00Z`).getTime(),
  ).toISOString();
  const toString = new Date(
    new Date(`${to.toString()}T23:59:59Z`).getTime(),
  ).toISOString();

  const pageSize = 5000;
  const timeEntries: Record<string, unknown>[] = [];

  let page = 0;
  while (true) {
    const response = await fetchWithRetry(
      `https://api.clockify.me/api/v1/workspaces/${workspaceID}/user/${userID}/time-entries?start=${fromString}&end=${toString}&page-size=${pageSize}&page=${page}`,
      {
        method: "GET",
        headers: {
          "X-Api-Key": apiKey,
        },
      },
    );
    if (!response.ok) {
      console.log(await response.text());
      throw new Error("Failed to fetch time entries");
    }
    const data = await response.json();
    for (const timeEntry of data) {
      timeEntries.push(timeEntry);
    }
    console.log(`Fetched ${timeEntries.length} time entries`);
    if (data.length !== pageSize) {
      break;
    }
    page += 1;
  }
  return timeEntries;
};

export const fetchYear = async (
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
    workspaceID,
    userID,
    firstDayOfYear,
    lastDayOfYear,
  );

  const durationPerDay = new Map<string, Temporal.Duration>();
  for (const entry of timeEntries as any) {
    const date = Temporal.PlainDate.from(entry.timeInterval.start.slice(0, 10));
    const duration = Temporal.Duration.from(entry.timeInterval.duration);
    const currentDuration =
      durationPerDay.get(date.toString()) ||
      Temporal.Duration.from({ seconds: 0 });
    durationPerDay.set(date.toString(), currentDuration.add(duration));
  }
  return durationPerDay;
};
