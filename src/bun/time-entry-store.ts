import { Temporal } from "temporal-polyfill";
import {
  aggregateDurationPerDay,
  entryDate,
  fetchActiveUser,
  fetchTimeEntries,
  type ActiveUser,
  type TimeEntry,
} from "./clockify.ts";

/**
 * In-memory cache of Clockify time entries shared by the tray and the
 * dashboard, so both consumers trigger at most one set of API requests.
 *
 * Strategy:
 * - The active user is fetched once per API key.
 * - The requested date range is fetched once; widening the range only fetches
 *   the newly added days.
 * - On subsequent calls only the most recent days (where entries are actually
 *   added/edited) are refetched, at most once per RECENT_REFRESH_INTERVAL_MS.
 * - The complete range is refetched every FULL_REFRESH_INTERVAL_MS to pick up
 *   rare edits to older entries.
 * - If a refresh fails (e.g. rate limited) but the requested range is already
 *   cached, the cached data is returned instead of an error.
 */

/** Number of days (including today) that are refetched on every refresh. */
const RECENT_WINDOW_DAYS = 14;
/** Minimum time between two refreshes of the recent window. */
const RECENT_REFRESH_INTERVAL_MS = 55 * 1000; // slightly below the 1 min poll interval
/** Interval after which the whole cached range is refetched. */
const FULL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

type DateRange = { start: string; end: string }; // YYYY-MM-DD, inclusive

type CacheState = {
  apiKey: string;
  user: ActiveUser | null;
  entries: Map<string, TimeEntry>;
  covered: DateRange | null;
  lastRecentRefresh: number;
  lastFullRefresh: number;
};

let state: CacheState | null = null;

// Serializes refreshes so concurrent callers (tray + dashboard) share one fetch.
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = queue.then(fn, fn);
  queue = result.catch(() => undefined);
  return result;
};

const addDays = (date: string, days: number): string =>
  Temporal.PlainDate.from(date).add({ days }).toString();

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

const today = () => Temporal.Now.plainDateISO("UTC").toString();

const isCovered = (cache: CacheState, range: DateRange): boolean =>
  cache.covered !== null && cache.covered.start <= range.start && cache.covered.end >= range.end;

async function fetchRange(cache: CacheState, range: DateRange): Promise<TimeEntry[]> {
  if (!cache.user) {
    cache.user = await fetchActiveUser(cache.apiKey);
  }
  return fetchTimeEntries(
    cache.apiKey,
    cache.user.defaultWorkspace,
    cache.user.id,
    Temporal.PlainDate.from(range.start),
    Temporal.PlainDate.from(range.end),
  );
}

/**
 * Replace all cached entries that start within `range` with `fresh` entries.
 * Removing first ensures entries deleted in Clockify disappear from the cache.
 */
function replaceRange(cache: CacheState, range: DateRange, fresh: TimeEntry[]): void {
  for (const [id, entry] of cache.entries) {
    const date = entryDate(entry);
    if (date >= range.start && date <= range.end) {
      cache.entries.delete(id);
    }
  }
  for (const entry of fresh) {
    cache.entries.set(entry.id, entry);
  }
}

async function refresh(cache: CacheState, range: DateRange): Promise<void> {
  const now = Date.now();

  // Initial load or periodic full refresh: fetch exactly the requested range.
  if (cache.covered === null || now - cache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS) {
    const fresh = await fetchRange(cache, range);
    cache.entries = new Map(fresh.map((entry) => [entry.id, entry]));
    cache.covered = { ...range };
    cache.lastFullRefresh = now;
    cache.lastRecentRefresh = now;
    return;
  }

  // Range widened: only fetch the missing days.
  if (range.start < cache.covered.start) {
    const missing = { start: range.start, end: addDays(cache.covered.start, -1) };
    replaceRange(cache, missing, await fetchRange(cache, missing));
    cache.covered.start = range.start;
  }
  if (range.end > cache.covered.end) {
    const missing = { start: addDays(cache.covered.end, 1), end: range.end };
    replaceRange(cache, missing, await fetchRange(cache, missing));
    cache.covered.end = range.end;
  }

  // Refresh recent days where entries are typically added or edited.
  if (now - cache.lastRecentRefresh >= RECENT_REFRESH_INTERVAL_MS) {
    const recent = {
      start: maxDate(cache.covered.start, addDays(today(), -(RECENT_WINDOW_DAYS - 1))),
      end: cache.covered.end,
    };
    if (recent.start <= recent.end) {
      replaceRange(cache, recent, await fetchRange(cache, recent));
    }
    cache.lastRecentRefresh = now;
  }
}

/**
 * Get work hours per day for the given range, using cached data where possible.
 *
 * @param apiKey - The Clockify API key
 * @param startDate - Start date (YYYY-MM-DD), inclusive
 * @param endDate - End date (YYYY-MM-DD), inclusive
 */
export function getDurationPerDay(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<Map<string, Temporal.Duration>> {
  const range = { start: minDate(startDate, endDate), end: maxDate(startDate, endDate) };

  return serialized(async () => {
    if (!state || state.apiKey !== apiKey) {
      state = {
        apiKey,
        user: null,
        entries: new Map(),
        covered: null,
        lastRecentRefresh: 0,
        lastFullRefresh: 0,
      };
    }
    const cache = state;

    try {
      await refresh(cache, range);
    } catch (err) {
      if (!isCovered(cache, range)) {
        throw err;
      }
      console.warn("Clockify refresh failed, using cached data:", err);
    }

    const entries = [...cache.entries.values()].filter((entry) => {
      const date = entryDate(entry);
      return date >= range.start && date <= range.end;
    });
    return aggregateDurationPerDay(entries);
  });
}
