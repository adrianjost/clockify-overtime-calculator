import type { TrackedEntry } from "../shared/rpc.ts";

// Keeps a copy of the time entries in the browser so the page works offline. Changes are saved
// here first and sent to the server in order once it can be reached.

const CACHE_KEY = "entries-cache";
const OUTBOX_KEY = "entries-outbox";

type Change = { type: "put"; entry: TrackedEntry } | { type: "delete"; id: string };

/** The server answered with an error; anything else (no network, timeout) means offline. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetcher = (method: string, path: string, body?: unknown) => Promise<Response>;

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error("Saving offline data failed:", error);
  }
}

function overlaps(entry: TrackedEntry, from: string, to: string): boolean {
  const end = entry.end ?? new Date().toISOString();
  return entry.start < to && end > from;
}

export function createOfflineStore(send: Fetcher, onStatus: () => void) {
  let cache = new Map(read<TrackedEntry[]>(CACHE_KEY, []).map((entry) => [entry.id, entry]));
  let outbox = read<Change[]>(OUTBOX_KEY, []);
  let offline = !navigator.onLine;
  let lastError = "";
  let flushing: Promise<void> | null = null;

  function save() {
    write(CACHE_KEY, [...cache.values()]);
    write(OUTBOX_KEY, outbox);
    onStatus();
  }

  function pendingIds(): Set<string> {
    return new Set(outbox.map((change) => (change.type === "put" ? change.entry.id : change.id)));
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(method, path, body);
    } catch (error) {
      if (!offline) {
        offline = true;
        onStatus();
      }
      throw error;
    }
    if (offline) {
      offline = false;
      onStatus();
    }
    const text = await response.text();
    const json = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new ServerError(
        response.status,
        json?.error ?? `Server error (HTTP ${response.status})`,
      );
    }
    return json as T;
  }

  /** Sends the saved changes in order; stops at the first one the network can't deliver. */
  function flush(): Promise<void> {
    flushing ??= sendOutbox().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function sendOutbox() {
    while (outbox.length) {
      const change = outbox[0]!;
      try {
        if (change.type === "put") {
          const { id, start, end } = change.entry;
          const saved = await call<TrackedEntry>("PUT", `/api/entries/${id}`, { start, end });
          // Unless it was changed again meanwhile, the server's copy is the current one.
          if (outbox[0] === change) cache.set(id, saved);
        } else {
          await call("DELETE", `/api/entries/${change.id}`).catch((error) => {
            if (!(error instanceof ServerError && error.status === 404)) throw error;
          });
        }
      } catch (error) {
        if (!(error instanceof ServerError) || error.status === 401) throw error;
        // The server refused the change (e.g. a timer already runs there); keep its version.
        lastError = error.message;
        if (change.type === "put") cache.delete(change.entry.id);
      }
      // A newer version of the same entry replaces the change in place; send that one next.
      if (outbox[0] === change) outbox.shift();
      save();
    }
    if (lastError) {
      // Shown once; the next sync starts without it.
      setTimeout(() => {
        lastError = "";
        onStatus();
      }, 10_000);
    }
  }

  function change(next: Change) {
    if (next.type === "put") {
      cache.set(next.entry.id, next.entry);
      const index = outbox.findIndex((c) => c.type === "put" && c.entry.id === next.entry.id);
      if (index >= 0) outbox[index] = next;
      else outbox.push(next);
    } else {
      cache.delete(next.id);
      outbox.push(next);
    }
    save();
    void flush().catch(() => {});
  }

  /** Entries overlapping the range: from the server when it can be reached, else the copy. */
  async function list(from: string, to: string): Promise<TrackedEntry[]> {
    try {
      await flush();
      const entries = await call<TrackedEntry[]>(
        "GET",
        `/api/entries?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const pending = pendingIds();
      for (const [id, entry] of cache) {
        if (!pending.has(id) && overlaps(entry, from, to)) cache.delete(id);
      }
      for (const entry of entries) if (!pending.has(entry.id)) cache.set(entry.id, entry);
      save();
    } catch (error) {
      if (error instanceof ServerError) throw error;
    }
    return [...cache.values()].filter((entry) => overlaps(entry, from, to));
  }

  async function running(): Promise<TrackedEntry | null> {
    try {
      await flush();
      const { running } = await call<{ running: TrackedEntry | null }>("GET", "/api/timer");
      const pending = pendingIds();
      for (const [id, entry] of cache) {
        if (entry.end === null && !pending.has(id) && id !== running?.id) cache.delete(id);
      }
      if (running && !pending.has(running.id)) cache.set(running.id, running);
      save();
    } catch (error) {
      if (error instanceof ServerError) throw error;
    }
    return [...cache.values()].find((entry) => entry.end === null) ?? null;
  }

  return {
    list,
    running,
    flush,
    put: (entry: TrackedEntry) => change({ type: "put", entry }),
    remove: (id: string) => change({ type: "delete", id }),
    status: () => ({
      offline: offline || !navigator.onLine,
      pending: outbox.length,
      error: lastError,
    }),
    clear() {
      cache = new Map();
      outbox = [];
      lastError = "";
      try {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(OUTBOX_KEY);
      } catch {}
      onStatus();
    },
  };
}
