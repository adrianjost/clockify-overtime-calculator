import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
 * Cache of Clockify time entries shared by the tray and the dashboard, and
 * persisted to disk so restarting the app does not refetch the full history.
 *
 * Clockify's API limits are tight, so requests are kept to a minimum:
 * - The active user is fetched once per API key (and persisted).
 * - The full requested range is fetched only when nothing is cached yet, and
 *   again every FULL_REFRESH_INTERVAL_MS to pick up edits to old entries.
 * - The last RECENT_WINDOW_DAYS days are refetched on app start and then once
 *   every RECENT_REFRESH_INTERVAL_MS (a single request / page).
 * - Widening the range into the past only fetches the newly added days.
 * - Polling in between is served from the cache. Running timers are computed
 *   locally, so the tray counter keeps ticking without API calls.
 * - If a refresh fails (e.g. rate limited) but the requested range is cached,
 *   the cached data is returned instead of an error.
 */

/** Number of days (including today) that are refetched on every refresh. */
const RECENT_WINDOW_DAYS = 14;
/** Time between two refreshes of the recent window (also done on app start). */
const RECENT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
/** Interval after which the whole cached range is refetched. */
const FULL_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly

const CACHE_FILE_VERSION = 1;

type DateRange = { start: string; end: string }; // YYYY-MM-DD, inclusive

type CacheState = {
  apiKey: string;
  user: ActiveUser | null;
  entries: Map<string, TimeEntry>;
  covered: DateRange | null;
  lastRecentRefresh: number;
  lastFullRefresh: number;
};

type PersistedCache = {
  version: number;
  apiKeyHash: string;
  user: ActiveUser | null;
  entries: TimeEntry[];
  covered: DateRange | null;
  lastFullRefresh: number;
};

let state: CacheState | null = null;
let cacheFile: string | null = null;

/**
 * Enable persisting the cache to the given file. The API key itself is never
 * written, only a hash to detect when the key changed.
 */
export function configureCacheFile(path: string): void {
  cacheFile = path;
}

// Serializes refreshes so concurrent callers (tray + dashboard) share one fetch.
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const result = queue.then(fn, fn);
  queue = result.catch(() => undefined);
  return result;
};

const hashApiKey = (apiKey: string) => createHash("sha256").update(apiKey).digest("hex");

const addDays = (date: string, days: number): string =>
  Temporal.PlainDate.from(date).add({ days }).toString();

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

const today = () => Temporal.Now.plainDateISO("UTC").toString();
const utcDateOf = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

const emptyState = (apiKey: string): CacheState => ({
  apiKey,
  user: null,
  entries: new Map(),
  covered: null,
  lastRecentRefresh: 0,
  lastFullRefresh: 0,
});

function loadState(apiKey: string): CacheState {
  if (!cacheFile) return emptyState(apiKey);
  try {
    const persisted = JSON.parse(readFileSync(cacheFile, "utf8")) as PersistedCache;
    if (persisted.version !== CACHE_FILE_VERSION || persisted.apiKeyHash !== hashApiKey(apiKey)) {
      return emptyState(apiKey);
    }
    return {
      apiKey,
      user: persisted.user,
      entries: new Map(persisted.entries.map((entry) => [entry.id, entry])),
      covered: persisted.covered,
      // Not persisted on purpose: refresh the recent days once per app start.
      lastRecentRefresh: 0,
      lastFullRefresh: persisted.lastFullRefresh,
    };
  } catch {
    return emptyState(apiKey);
  }
}

function saveState(cache: CacheState): void {
  if (!cacheFile) return;
  const persisted: PersistedCache = {
    version: CACHE_FILE_VERSION,
    apiKeyHash: hashApiKey(cache.apiKey),
    user: cache.user,
    entries: [...cache.entries.values()],
    covered: cache.covered,
    lastFullRefresh: cache.lastFullRefresh,
  };
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(persisted), "utf8");
  } catch (err) {
    console.error("Failed to persist time entry cache:", err);
  }
}

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

/**
 * Bring the cache up to date for `range`. Returns whether anything was fetched.
 */
async function refresh(cache: CacheState, range: DateRange): Promise<boolean> {
  const now = Date.now();
  // Always fetch up to today, so days that were still in the future at fetch
  // time are known to be empty and don't need their own request later.
  const fetchEnd = maxDate(range.end, today());

  // Nothing cached yet or periodic full refresh: fetch the whole range.
  if (cache.covered === null || now - cache.lastFullRefresh >= FULL_REFRESH_INTERVAL_MS) {
    const full = { start: range.start, end: fetchEnd };
    const fresh = await fetchRange(cache, full);
    cache.entries = new Map(fresh.map((entry) => [entry.id, entry]));
    cache.covered = full;
    cache.lastFullRefresh = now;
    cache.lastRecentRefresh = now;
    return true;
  }

  let fetched = false;

  // Range widened into the past: only fetch the missing days.
  if (range.start < cache.covered.start) {
    const missing = { start: range.start, end: addDays(cache.covered.start, -1) };
    replaceRange(cache, missing, await fetchRange(cache, missing));
    cache.covered.start = range.start;
    fetched = true;
  }

  const recentStart = maxDate(cache.covered.start, addDays(today(), -(RECENT_WINDOW_DAYS - 1)));
  const isRecentDue = now - cache.lastRecentRefresh >= RECENT_REFRESH_INTERVAL_MS;

  if (range.end > cache.covered.end) {
    const gapStart = addDays(cache.covered.end, 1);
    const lastFetchDate = cache.lastRecentRefresh > 0 ? utcDateOf(cache.lastRecentRefresh) : "";
    if (cache.covered.end >= lastFetchDate && !isRecentDue) {
      // The missing days (e.g. after midnight) were in the future when we last
      // fetched, so they were empty then. They get picked up with the next
      // scheduled refresh of the recent window — no extra request needed.
      cache.covered.end = range.end;
    } else if (gapStart < recentStart) {
      // Gap reaches outside the recent window: fetch it explicitly.
      const missing = { start: gapStart, end: fetchEnd };
      replaceRange(cache, missing, await fetchRange(cache, missing));
      cache.covered.end = fetchEnd;
      fetched = true;
    } else {
      // Gap is inside the recent window: covered by the refresh below.
      cache.covered.end = fetchEnd;
    }
  }

  // Refresh the recent days where entries are typically added or edited.
  if (isRecentDue) {
    const end = maxDate(cache.covered.end, today());
    const recent = { start: minDate(recentStart, end), end };
    replaceRange(cache, recent, await fetchRange(cache, recent));
    cache.covered.end = end;
    cache.lastRecentRefresh = now;
    fetched = true;
  }

  return fetched;
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
      state = loadState(apiKey);
    }
    const cache = state;

    try {
      if (await refresh(cache, range)) {
        saveState(cache);
      }
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
