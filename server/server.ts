import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.DB_PATH ?? "/data/time-tracking.db";

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

type User = { id: string; username: string; password_hash: string; created_at: string };
type Entry = { id: string; start: string; end: string | null };
type Row = Entry & { user_id: string; updated_at: string };

const toEntry = ({ id, start, end }: Row): Entry => ({ id, start, end });
const now = () => new Date().toISOString();
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const users = {
  byName: db.query<User, { username: string }>("SELECT * FROM users WHERE username = $username"),
  all: db.query<User, []>("SELECT * FROM users ORDER BY username"),
  insert: db.query(
    "INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, $username, $password_hash, $created_at)",
  ),
  setPassword: db.query("UPDATE users SET password_hash = $password_hash WHERE id = $id"),
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
};

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

function timerApi(user: User) {
  const user_id = user.id;

  function validated(start: string, end: string | null, id: string): Entry {
    if (end !== null && end <= start) throw new HttpError(400, "end must be after start");
    const running = entries.running.get({ user_id });
    if (end === null && running && running.id !== id) {
      throw new HttpError(409, "Another timer is already running");
    }
    return { id, start, end };
  }

  function save(entry: Entry): Entry {
    const exists = entries.byId.get({ user_id, id: entry.id });
    (exists ? entries.update : entries.insert).run({ ...entry, user_id, updated_at: now() });
    return entry;
  }

  function find(id: string): Row {
    const row = entries.byId.get({ user_id, id });
    if (!row) throw new HttpError(404, "Entry not found");
    return row;
  }

  const routes: Record<string, (request: Request, id?: string) => unknown | Promise<unknown>> = {
    "GET /api/me": () => ({ username: user.username }),
    "POST /api/logout": (request) => {
      sessions.remove.run({ token_hash: hashToken(bearerToken(request)) });
      return null;
    },
    "GET /api/entries": (request) => {
      const params = new URL(request.url).searchParams;
      const from = instant(params.get("from"), "from");
      const to = instant(params.get("to"), "to");
      return entries.range.all({ user_id, from, to }).map(toEntry);
    },
    "POST /api/entries": async (request) => {
      const input = await body(request);
      const start = instant(input.start, "start");
      const end = input.end == null ? null : instant(input.end, "end");
      return save(validated(start, end, crypto.randomUUID()));
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
      return save(validated(start, end, id));
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
      return save({ id: running.id, start: running.start, end: now() });
    },
  };
  return routes;
}

async function handleApi(request: Request, pathname: string): Promise<unknown> {
  if (request.method === "POST" && pathname === "/api/login") return login(request);
  const user = authenticate(request);
  if (!user) throw new HttpError(401, "Unauthorized");
  const match = pathname.match(/^\/api\/entries\/([^/]+)$/);
  const handler = timerApi(user)[`${request.method} ${match ? "/api/entries/:id" : pathname}`];
  if (!handler) throw new HttpError(404, "Not found");
  return handler(request, match?.[1]);
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

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
    try {
      return json(await handleApi(request, pathname));
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
