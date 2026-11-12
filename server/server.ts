import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? "/data/time-tracking.db";
const clockifyUrl = process.env.CLOCKIFY_API_URL ?? "https://api.clockify.me/api/v1";
// The mobile web UI, built from src/web (see Dockerfile).
const publicDir = process.env.PUBLIC_DIR ?? `${import.meta.dir}/public`;

// ─── Database ────────────────────────────────────────────────────────────────

const db = new Database(dbPath, { create: true, strict: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
)`);
// Only a hash of each session token is stored.
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  start TEXT NOT NULL,
  end TEXT,
  updated_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS entries_user_start ON entries (user_id, start)");
// At most one running timer per user.
db.run(
  "CREATE UNIQUE INDEX IF NOT EXISTS entries_user_running ON entries (user_id) WHERE end IS NULL",
);
// The Clockify entry an entry was imported from, so importing again skips it.
if (
  !db
    .query<{ name: string }, []>("PRAGMA table_info(entries)")
    .all()
    .some((c) => c.name === "clockify_id")
) {
  db.run("ALTER TABLE entries ADD COLUMN clockify_id TEXT");
}
db.run(
  "CREATE UNIQUE INDEX IF NOT EXISTS entries_user_clockify ON entries (user_id, clockify_id) WHERE clockify_id IS NOT NULL",
);
// Labels say what an entry was about. A prefix gives them a kind, e.g. "project:Bugfixing" or
// "tag:Meeting". There is no UI for them yet.
db.run(`CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  clockify_id TEXT
)`);
db.run("CREATE UNIQUE INDEX IF NOT EXISTS labels_user_name ON labels (user_id, name)");
db.run(
  "CREATE UNIQUE INDEX IF NOT EXISTS labels_user_clockify ON labels (user_id, clockify_id) WHERE clockify_id IS NOT NULL",
);
db.run(`CREATE TABLE IF NOT EXISTS entry_labels (
  entry_id TEXT NOT NULL REFERENCES entries (id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, label_id)
)`);

type User = { id: string; username: string; password_hash: string; created_at: string };
type Entry = { id: string; start: string; end: string | null; labels: string[] };
type Row = { id: string; start: string; end: string | null; user_id: string; updated_at: string };
type Label = {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  clockify_id: string | null;
};
const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const users = {
  byName: db.query<User, { username: string }>("SELECT * FROM users WHERE username = $username"),
  all: db.query<User, []>("SELECT * FROM users ORDER BY username"),
  insert: db.query(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, $username, $password_hash, $created_at)",
  ),
  setPassword: db.query("UPDATE users SET password_hash = $password_hash WHERE id = $id"),
  setUsername: db.query("UPDATE users SET username = $username WHERE id = $id"),
  remove: db.query("DELETE FROM users WHERE id = $id"),
};

const sessions = {
  insert: db.query(
    "INSERT INTO sessions (token_hash, user_id, created_at, last_used_at) VALUES ($token_hash, $user_id, $now, $now)",
  ),
  user: db.query<User, { token_hash: string }>(
    "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = $token_hash",
  ),
  touch: db.query("UPDATE sessions SET last_used_at = $now WHERE token_hash = $token_hash"),
  remove: db.query("DELETE FROM sessions WHERE token_hash = $token_hash"),
  removeForUser: db.query("DELETE FROM sessions WHERE user_id = $user_id"),
  removeOthers: db.query(
    "DELETE FROM sessions WHERE user_id = $user_id AND token_hash != $token_hash",
  ),
};

const entries = {
  range: db.query<Row, { user_id: string; from: string; to: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND start < $to AND (end IS NULL OR end > $from) ORDER BY start",
  ),
  byId: db.query<Row, { user_id: string; id: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND id = $id",
  ),
  running: db.query<Row, { user_id: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND end IS NULL",
  ),
  insert: db.query(
    "INSERT INTO entries (id, user_id, start, end, updated_at) VALUES ($id, $user_id, $start, $end, $updated_at)",
  ),
  update: db.query(
    "UPDATE entries SET start = $start, end = $end, updated_at = $updated_at WHERE id = $id AND user_id = $user_id",
  ),
  remove: db.query("DELETE FROM entries WHERE id = $id AND user_id = $user_id"),
  any: db.query<{ id: string }, { user_id: string }>(
    "SELECT id FROM entries WHERE user_id = $user_id LIMIT 1",
  ),
  clockifyIds: db.query<{ clockify_id: string }, { user_id: string }>(
    "SELECT clockify_id FROM entries WHERE user_id = $user_id AND clockify_id IS NOT NULL",
  ),
  // Entries not imported from Clockify (or imported before clockify_id existed).
  inRange: db.query<Row, { user_id: string; start: string; end: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND start < $end AND (end IS NULL OR end > $start)",
  ),
  notImportedInRange: db.query<Row, { user_id: string; start: string; end: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND clockify_id IS NULL AND start < $end AND (end IS NULL OR end > $start)",
  ),
  insertImported: db.query(
    "INSERT INTO entries (id, user_id, start, end, updated_at, clockify_id) VALUES ($id, $user_id, $start, $end, $updated_at, $clockify_id)",
  ),
  setClockifyId: db.query("UPDATE entries SET clockify_id = $clockify_id WHERE id = $id"),
  byClockifyId: db.query<Row, { user_id: string; clockify_id: string }>(
    "SELECT * FROM entries WHERE user_id = $user_id AND clockify_id = $clockify_id",
  ),
};

const labels = {
  all: db.query<Label, { user_id: string }>(
    "SELECT * FROM labels WHERE user_id = $user_id ORDER BY name",
  ),
  byName: db.query<Label, { user_id: string; name: string }>(
    "SELECT * FROM labels WHERE user_id = $user_id AND name = $name",
  ),
  byClockifyId: db.query<Label, { user_id: string; clockify_id: string }>(
    "SELECT * FROM labels WHERE user_id = $user_id AND clockify_id = $clockify_id",
  ),
  insert: db.query(
    "INSERT INTO labels (id, user_id, name, color, clockify_id) VALUES ($id, $user_id, $name, $color, $clockify_id)",
  ),
  update: db.query(
    "UPDATE labels SET name = $name, color = $color, clockify_id = $clockify_id WHERE id = $id",
  ),
  ofEntry: db.query<{ name: string }, { entry_id: string }>(
    "SELECT labels.name FROM entry_labels JOIN labels ON labels.id = entry_labels.label_id WHERE entry_id = $entry_id ORDER BY labels.name",
  ),
  inRange: db.query<
    { entry_id: string; name: string },
    { user_id: string; from: string; to: string }
  >(
    "SELECT entry_labels.entry_id, labels.name FROM entry_labels JOIN labels ON labels.id = entry_labels.label_id JOIN entries ON entries.id = entry_labels.entry_id WHERE entries.user_id = $user_id AND entries.start < $to AND (entries.end IS NULL OR entries.end > $from) ORDER BY labels.name",
  ),
  link: db.query(
    "INSERT OR IGNORE INTO entry_labels (entry_id, label_id) VALUES ($entry_id, $label_id)",
  ),
  unlinkAll: db.query("DELETE FROM entry_labels WHERE entry_id = $entry_id"),
};

const toEntry = (row: Row, names?: string[]): Entry => ({
  id: row.id,
  start: row.start,
  end: row.end,
  labels: names ?? labels.ofEntry.all({ entry_id: row.id }).map((label) => label.name),
});

/** The user's label with this name, created if it doesn't exist yet. */
function labelId(user_id: string, name: string, color: string | null = null): string {
  const existing = labels.byName.get({ user_id, name });
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  labels.insert.run({ id, user_id, name, color, clockify_id: null });
  return id;
}

function addLabels(user_id: string, entry_id: string, names: string[]) {
  for (const name of names) labels.link.run({ entry_id, label_id: labelId(user_id, name) });
}

// ─── User management (CLI) ──────────────────────────────────────────────────

if (process.argv[2] === "user") {
  await manageUsers(process.argv[3], process.argv[4]);
  process.exit(0);
}

async function readPassword(): Promise<string> {
  const password = prompt("Password (at least 8 characters):")?.trim() ?? "";
  if (password.length < 8) {
    console.error("The password must have at least 8 characters.");
    process.exit(1);
  }
  return password;
}

async function manageUsers(command?: string, username?: string) {
  const usage =
    "Usage: bun server.ts user <add|passwd|remove> <username>, or: bun server.ts user list";
  if (command === "list") {
    for (const user of users.all.all()) console.log(user.username);
    return;
  }
  if (!command || !username) {
    console.error(usage);
    process.exit(1);
  }
  const existing = users.byName.get({ username });
  switch (command) {
    case "add": {
      if (existing) {
        console.error(`User ${username} already exists.`);
        process.exit(1);
      }
      const id = crypto.randomUUID();
      const password_hash = await Bun.password.hash(await readPassword());
      users.insert.run({ id, username, password_hash, created_at: now() });
      console.log(`Added ${username}.`);
      return;
    }
    case "passwd": {
      if (!existing) break;
      const password_hash = await Bun.password.hash(await readPassword());
      users.setPassword.run({ id: existing.id, password_hash });
      sessions.removeForUser.run({ user_id: existing.id });
      console.log(`Changed the password of ${username} and signed out all their devices.`);
      return;
    }
    case "remove": {
      if (!existing) break;
      users.remove.run({ id: existing.id });
      console.log(`Removed ${username} with all their time entries.`);
      return;
    }
    default:
      console.error(usage);
      process.exit(1);
  }
  console.error(`User ${username} does not exist.`);
  process.exit(1);
}

// ─── API ─────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function instant(value: unknown, field: string): string {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw new HttpError(400, `${field} must be an ISO 8601 date-time`);
  return new Date(time).toISOString();
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const json = await request.json();
    if (json && typeof json === "object") return json as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Expected a JSON object");
}

function bearerToken(request: Request): string {
  return (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
}

function authenticate(request: Request): User | null {
  const token = bearerToken(request);
  if (!token) return null;
  const token_hash = hashToken(token);
  const user = sessions.user.get({ token_hash });
  if (user) sessions.touch.run({ token_hash, now: now() });
  return user;
}

// Verified against a dummy hash for unknown users, so the response time doesn't reveal them.
const dummyHash = await Bun.password.hash(randomBytes(16).toString("hex"));

async function login(request: Request) {
  const input = await body(request);
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  const user = users.byName.get({ username });
  const valid = await Bun.password.verify(password, user?.password_hash ?? dummyHash);
  if (!user || !valid) throw new HttpError(401, "Wrong username or password");
  const token = randomBytes(32).toString("base64url");
  sessions.insert.run({ token_hash: hashToken(token), user_id: user.id, now: now() });
  return { token, username: user.username };
}

// ─── Clockify import ─────────────────────────────────────────────────────────

type ClockifyEntry = {
  id: string;
  projectId?: string | null;
  tagIds?: string[] | null;
  timeInterval: { start: string; end: string | null };
};
type ClockifyNamed = { id: string; name: string; color?: string };

/**
 * Saves Clockify projects and tags as labels ("project:…", "tag:…"), following renames.
 * Returns the label ID for each "project:<id>" / "tag:<id>".
 */
function saveClockifyLabels(
  user_id: string,
  kinds: { kind: string; found: ClockifyNamed[] }[],
): Map<string, string> {
  const ids = new Map<string, string>();
  db.transaction(() => {
    for (const { kind, found } of kinds) {
      for (const item of found) {
        const clockify_id = `${kind}:${item.id}`;
        const name = `${kind}:${item.name}`;
        const color = item.color ?? null;
        const linked = labels.byClockifyId.get({ user_id, clockify_id });
        const named = labels.byName.get({ user_id, name });
        const label = linked ?? named;
        if (label) {
          // Keep the old name when another label already has the new one.
          const free = !named || named.id === label.id;
          labels.update.run({ id: label.id, name: free ? name : label.name, color, clockify_id });
          ids.set(clockify_id, label.id);
        } else {
          const id = crypto.randomUUID();
          labels.insert.run({ id, user_id, name, color, clockify_id });
          ids.set(clockify_id, id);
        }
      }
    }
  })();
  return ids;
}

/** Reports what the import is doing; `retryAt` adds a countdown. */
type Progress = (message: string, retryAt?: number) => void;

const CLOCKIFY_PAGE_SIZE = 1000;
const CLOCKIFY_ATTEMPTS = 10;
const MAX_RETRY_WAIT_SECONDS = 5 * 60;
// Back-to-back entries often overlap by a few seconds; only a longer overlap means the same time
// is already on the server.
const DUPLICATE_OVERLAP_MS = 60 * 1000;

function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : (date - Date.now()) / 1000;
}

async function clockify<T>(
  path: string,
  apiKey: string,
  progress: Progress,
  signal: AbortSignal,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let response: Response | null = null;
    let problem: string;
    try {
      response = await fetch(`${clockifyUrl}${path}`, {
        headers: { "X-Api-Key": apiKey },
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      if (response.status === 401 || response.status === 403) {
        throw new HttpError(400, "Clockify did not accept the API key");
      }
      if (response.ok) return (await response.json()) as T;
      problem =
        response.status === 429
          ? "Clockify's rate limit is reached"
          : `Clockify answered with HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) throw new HttpError(502, problem);
    } catch (error) {
      if (error instanceof HttpError || signal.aborted) throw error;
      problem = `Clockify is unreachable (${(error as Error).message})`;
    }
    if (attempt === CLOCKIFY_ATTEMPTS) throw new HttpError(502, `${problem}. Try again later.`);
    const seconds = Math.min(
      Math.max((response && retryAfterSeconds(response)) ?? 0, 5 * 2 ** (attempt - 1)),
      MAX_RETRY_WAIT_SECONDS,
    );
    const retryAt = Date.now() + seconds * 1000;
    progress(problem, retryAt);
    await Bun.sleep(seconds * 1000);
    signal.throwIfAborted();
  }
}

/** Whether one of `others` overlaps start–end by more than a few seconds. */
function overlapsAny(others: Row[], start: string, end: string): boolean {
  return others.some((other) => {
    const overlapEnd = Math.min(Date.parse(end), other.end ? Date.parse(other.end) : Date.now());
    return overlapEnd - Math.max(Date.parse(start), Date.parse(other.start)) > DUPLICATE_OVERLAP_MS;
  });
}

/** Restores entries from this app's JSON export, skipping ones whose time is already here. */
type BackupEntry = { start: string; end: string | null; labels: string[] };

function restoreBackup(user_id: string, list: BackupEntry[]) {
  const result = { imported: 0, skipped: 0, running: 0 };
  db.transaction(() => {
    for (const { start, end, labels: names } of list) {
      if (!end) {
        result.running++;
        continue;
      }
      if (end <= start || overlapsAny(entries.inRange.all({ user_id, start, end }), start, end)) {
        result.skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      entries.insert.run({ id, user_id, start, end, updated_at: now() });
      addLabels(user_id, id, names);
      result.imported++;
    }
  })();
  return result;
}

/**
 * Copies all finished Clockify entries, except ones imported before and ones whose time is
 * already tracked on the server.
 */
async function importFromClockify(
  user_id: string,
  apiKey: string,
  progress: Progress,
  signal: AbortSignal,
) {
  progress("Connecting to Clockify…");
  const clockifyUser = await clockify<{ id: string; defaultWorkspace: string }>(
    "/user",
    apiKey,
    progress,
    signal,
  );
  const workspace = `/workspaces/${clockifyUser.defaultWorkspace}`;
  const loadAll = async <T>(path: string): Promise<T[]> => {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await clockify<T[]>(
        `${workspace}/${path}?page-size=${CLOCKIFY_PAGE_SIZE}&page=${page}`,
        apiKey,
        progress,
        signal,
      );
      all.push(...batch);
      if (batch.length < CLOCKIFY_PAGE_SIZE) return all;
    }
  };
  progress("Loading projects and tags from Clockify…");
  const labelIds = saveClockifyLabels(user_id, [
    { kind: "project", found: await loadAll<ClockifyNamed>("projects") },
    { kind: "tag", found: await loadAll<ClockifyNamed>("tags") },
  ]);
  const labelsOf = (entry: ClockifyEntry) =>
    [
      entry.projectId ? labelIds.get(`project:${entry.projectId}`) : undefined,
      ...(entry.tagIds ?? []).map((tagId) => labelIds.get(`tag:${tagId}`)),
    ].filter((id): id is string => !!id);
  const link = (entry_id: string, entry: ClockifyEntry) => {
    for (const label_id of labelsOf(entry)) labels.link.run({ entry_id, label_id });
  };

  const found: ClockifyEntry[] = [];
  for (let page = 1; ; page++) {
    progress(
      found.length
        ? `Loaded ${found.length} entries from Clockify…`
        : "Loading entries from Clockify…",
    );
    const batch = await clockify<ClockifyEntry[]>(
      `${workspace}/user/${clockifyUser.id}/time-entries?page-size=${CLOCKIFY_PAGE_SIZE}&page=${page}`,
      apiKey,
      progress,
      signal,
    );
    found.push(...batch);
    if (batch.length < CLOCKIFY_PAGE_SIZE) break;
  }

  progress(`Saving ${found.length} entries…`);
  const result = { imported: 0, skipped: 0, running: 0 };
  const imported = new Set(entries.clockifyIds.all({ user_id }).map((row) => row.clockify_id));
  const alreadyTracked = (start: string, end: string) =>
    overlapsAny(entries.notImportedInRange.all({ user_id, start, end }), start, end);
  db.transaction(() => {
    for (const entry of found) {
      const { id: clockify_id, timeInterval } = entry;
      if (!timeInterval.end) {
        result.running++;
        continue;
      }
      const start = new Date(timeInterval.start).toISOString();
      const end = new Date(timeInterval.end).toISOString();
      if (imported.has(clockify_id)) {
        const row = entries.byClockifyId.get({ user_id, clockify_id });
        if (row) link(row.id, entry);
        result.skipped++;
        continue;
      }
      // The same entry copied by an import from before entries remembered their Clockify ID.
      const copy = entries.notImportedInRange
        .all({ user_id, start, end })
        .find((row) => row.start === start && row.end === end);
      if (copy) {
        entries.setClockifyId.run({ id: copy.id, clockify_id });
        link(copy.id, entry);
        imported.add(clockify_id);
        result.skipped++;
        continue;
      }
      if (end <= start || alreadyTracked(start, end)) {
        result.skipped++;
        continue;
      }
      const id = crypto.randomUUID();
      entries.insertImported.run({ id, user_id, start, end, updated_at: now(), clockify_id });
      link(id, entry);
      imported.add(clockify_id);
      result.imported++;
    }
  })();
  return result;
}

/**
 * Runs the import while streaming one JSON object per line: `{progress}` every two seconds
 * (which also keeps the connection open), then `{result}` or `{error}`.
 */
type ImportResult = { imported: number; skipped: number; running: number };
type ImportRun = (
  user_id: string,
  progress: Progress,
  signal: AbortSignal,
) => Promise<ImportResult>;

/** Each import source checks its input before the import starts streaming. */
const importers: Record<string, (input: Record<string, unknown>) => ImportRun> = {
  clockify: (input) => {
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey) throw new HttpError(400, "apiKey is required");
    return (user_id, progress, signal) => importFromClockify(user_id, apiKey, progress, signal);
  },
  backup: (input) => {
    if (!Array.isArray(input.entries)) {
      throw new HttpError(400, "This is not a JSON export of this app");
    }
    const list = input.entries.map(
      (entry: { start?: unknown; end?: unknown; labels?: unknown }, index): BackupEntry => ({
        start: instant(entry?.start, `entries[${index}].start`),
        end: entry?.end == null ? null : instant(entry.end, `entries[${index}].end`),
        labels: Array.isArray(entry?.labels)
          ? entry.labels.filter((name): name is string => typeof name === "string" && !!name.trim())
          : [],
      }),
    );
    return async (user_id, progress) => {
      progress(`Restoring ${list.length} entries…`);
      return restoreBackup(user_id, list);
    };
  },
};

function streamImport(user_id: string, run: ImportRun, requestSignal: AbortSignal): Response {
  const abort = new AbortController();
  requestSignal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  let message = "";
  let retryAt = 0;
  let ticker: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`));
      };
      const sendProgress = () => {
        const seconds = Math.ceil((retryAt - Date.now()) / 1000);
        const retry = seconds > 0 ? ` Trying again in ${seconds}s…` : " Trying again…";
        send({ progress: retryAt ? `${message}.${retry}` : message });
      };
      const progress: Progress = (text, until = 0) => {
        message = text;
        retryAt = until;
        sendProgress();
      };
      ticker = setInterval(sendProgress, 2000);
      run(user_id, progress, abort.signal)
        .then((result) => send({ result }))
        .catch((error) => {
          if (abort.signal.aborted) return;
          if (!(error instanceof HttpError)) console.error(error);
          send({ error: error instanceof HttpError ? error.message : "Internal server error" });
        })
        .finally(() => {
          clearInterval(ticker);
          if (!abort.signal.aborted) controller.close();
        });
    },
    cancel() {
      clearInterval(ticker);
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

function timerApi(user: User) {
  const user_id = user.id;

  function validated(start: string, end: string | null, id: string, names: string[] = []): Entry {
    if (end !== null && end <= start) throw new HttpError(400, "end must be after start");
    const running = entries.running.get({ user_id });
    if (end === null && running && running.id !== id) {
      throw new HttpError(409, "Another timer is already running");
    }
    return { id, start, end, labels: names };
  }

  function labelInput(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
      throw new HttpError(400, "labels must be a list of names");
    }
    const names = [...new Set(value.map((name: string) => name.trim()).filter(Boolean))];
    if (names.some((name) => name.length > 100)) {
      throw new HttpError(400, "A label can have at most 100 characters");
    }
    return names.sort();
  }

  function save(entry: Entry): Entry {
    const { id, start, end } = entry;
    db.transaction(() => {
      const exists = entries.byId.get({ user_id, id });
      (exists ? entries.update : entries.insert).run({
        id,
        start,
        end,
        user_id,
        updated_at: now(),
      });
      labels.unlinkAll.run({ entry_id: id });
      addLabels(user_id, id, entry.labels);
    })();
    return entry;
  }

  function find(id: string): Row {
    const row = entries.byId.get({ user_id, id });
    if (!row) throw new HttpError(404, "Entry not found");
    return row;
  }

  const routes: Record<string, (request: Request, id?: string) => unknown | Promise<unknown>> = {
    "GET /api/me": () => ({
      username: user.username,
      hasEntries: entries.any.get({ user_id }) !== null,
    }),
    "POST /api/username": async (request) => {
      const input = await body(request);
      const username = typeof input.username === "string" ? input.username.trim() : "";
      if (!username || username.length > 64) {
        throw new HttpError(400, "The username needs 1 to 64 characters");
      }
      const existing = users.byName.get({ username });
      if (existing && existing.id !== user_id) throw new HttpError(409, "This username is taken");
      users.setUsername.run({ id: user_id, username });
      return { username };
    },
    "POST /api/password": async (request) => {
      const input = await body(request);
      const current = typeof input.currentPassword === "string" ? input.currentPassword : "";
      const next = typeof input.newPassword === "string" ? input.newPassword.trim() : "";
      if (!(await Bun.password.verify(current, user.password_hash))) {
        throw new HttpError(400, "The current password is wrong");
      }
      if (next.length < 8) throw new HttpError(400, "The new password needs at least 8 characters");
      users.setPassword.run({ id: user_id, password_hash: await Bun.password.hash(next) });
      sessions.removeOthers.run({ user_id, token_hash: hashToken(bearerToken(request)) });
      return null;
    },
    "POST /api/logout": (request) => {
      sessions.remove.run({ token_hash: hashToken(bearerToken(request)) });
      return null;
    },
    "GET /api/labels": () =>
      labels.all.all({ user_id }).map(({ id, name, color }) => ({ id, name, color })),
    "GET /api/entries": (request) => {
      const params = new URL(request.url).searchParams;
      const from = instant(params.get("from"), "from");
      const to = instant(params.get("to"), "to");
      const names = new Map<string, string[]>();
      for (const { entry_id, name } of labels.inRange.all({ user_id, from, to })) {
        names.set(entry_id, [...(names.get(entry_id) ?? []), name]);
      }
      return entries.range
        .all({ user_id, from, to })
        .map((row) => toEntry(row, names.get(row.id) ?? []));
    },
    "POST /api/entries": async (request) => {
      const input = await body(request);
      const start = instant(input.start, "start");
      const end = input.end == null ? null : instant(input.end, "end");
      const names = "labels" in input ? labelInput(input.labels) : [];
      return save(validated(start, end, crypto.randomUUID(), names));
    },
    "PATCH /api/entries/:id": async (request, id = "") => {
      const current = find(id);
      const input = await body(request);
      const start = "start" in input ? instant(input.start, "start") : current.start;
      const end = !("end" in input)
        ? current.end
        : input.end === null
          ? null
          : instant(input.end, "end");
      const names = "labels" in input ? labelInput(input.labels) : toEntry(current).labels;
      return save(validated(start, end, id, names));
    },
    "DELETE /api/entries/:id": (_, id = "") => {
      find(id);
      entries.remove.run({ user_id, id });
      return null;
    },
    "GET /api/timer": () => {
      const running = entries.running.get({ user_id });
      return { running: running ? toEntry(running) : null };
    },
    "POST /api/timer/start": () => {
      const running = entries.running.get({ user_id });
      return {
        running: running ? toEntry(running) : save(validated(now(), null, crypto.randomUUID())),
      };
    },
    "POST /api/timer/stop": () => {
      const running = entries.running.get({ user_id });
      if (!running) throw new HttpError(409, "No timer is running");
      return save({ ...toEntry(running), end: now() });
    },
    "POST /api/import/:source": async (request, source = "") => {
      const importer = Object.hasOwn(importers, source) ? importers[source] : undefined;
      if (!importer) throw new HttpError(404, "Unknown import source");
      return streamImport(user_id, importer(await body(request)), request.signal);
    },
  };
  return routes;
}

async function handleApi(request: Request, pathname: string): Promise<unknown> {
  if (request.method === "POST" && pathname === "/api/login") return login(request);
  const user = authenticate(request);
  if (!user) throw new HttpError(401, "Unauthorized");
  const match = pathname.match(/^\/api\/(entries|import)\/([^/]+)$/);
  const route = match ? `/api/${match[1]}/${match[1] === "entries" ? ":id" : ":source"}` : pathname;
  const handler = timerApi(user)[`${request.method} ${route}`];
  if (!handler) throw new HttpError(404, "Not found");
  return handler(request, match?.[2]);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const file = Bun.file(`${publicDir}/${relative}`);
  if (relative.split("/").includes("..") || !(await file.exists())) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(file, { headers: { "cache-control": "no-cache" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(data === null ? null : JSON.stringify(data), {
    status: data === null ? 204 : status,
    headers: data === null ? {} : { "content-type": "application/json" },
  });
}

Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true });
    if (!pathname.startsWith("/api/")) {
      return request.method === "GET" ? serveStatic(pathname) : json({ error: "Not found" }, 404);
    }
    try {
      const result = await handleApi(request, pathname);
      return result instanceof Response ? result : json(result);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  },
});

if (users.all.all().length === 0) {
  console.log(
    "No users yet. Add one with: docker compose exec time-tracking bun server.ts user add <name>",
  );
}
console.log(`Time tracking server listening on port ${port}`);
