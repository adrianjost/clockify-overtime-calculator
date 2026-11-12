import type { TrackedEntry } from "../shared/rpc.ts";
import { buildOvertime, localMidnight, secondsPerDay } from "../shared/overtime.ts";
import { setTransport } from "../mainview/bridge.ts";
import { DASHBOARD_CACHE_KEY, initializeDashboard } from "../mainview/dashboard.ts";
import { initializeTracking } from "../mainview/tracking.ts";
import { initializeThemePicker } from "../mainview/theme-picker.ts";
import { createOfflineStore, ServerError } from "./offline.ts";

// The mobile web UI served by the time tracking server. It reuses the app's views and talks to
// the server's API directly instead of through the macOS app.

const TOKEN_KEY = "server_session";
const USERNAME_KEY = "server_username";

const loginView = document.querySelector<HTMLElement>("#login-view")!;
const mainView = document.querySelector<HTMLElement>("#main-view")!;
const loginForm = document.querySelector<HTMLFormElement>("#login-form")!;
const loginUsername = document.querySelector<HTMLInputElement>("#login-username")!;
const loginPassword = document.querySelector<HTMLInputElement>("#login-password")!;
const loginError = document.querySelector<HTMLSpanElement>("#login-error")!;

class Unauthorized extends Error {}

function token(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function request(
  method: string,
  path: string,
  body?: unknown,
  auth = token(),
  signal?: AbortSignal,
) {
  return fetch(path, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
}

async function api<T>(method: string, path: string, body?: unknown, auth = token()): Promise<T> {
  const response = await request(method, path, body, auth);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (!response.ok) throw failure(response.status, json?.error);
  return json as T;
}

function failure(status: number, error?: string): Error {
  if (status === 401) {
    return new Unauthorized(error === "Unauthorized" ? "Please sign in again." : error);
  }
  return new Error(error ?? `Server error (HTTP ${status})`);
}

type ImportResult = { imported: number; skipped: number; running: number };

/** The server streams one JSON object per line: progress messages, then the result or an error. */
async function runImport(
  source: string,
  input: Record<string, unknown>,
  onProgress: (message: string) => void,
  signal: AbortSignal,
): Promise<ImportResult> {
  const response = await request("POST", `/api/import/${source}`, input, token(), signal);
  if (!response.ok || !response.body) {
    const json = await response.json().catch(() => null);
    throw failure(response.status, json?.error);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.error) throw new Error(message.error);
      if (message.result) return message.result as ImportResult;
      if (message.progress) onProgress(message.progress);
    }
  }
  throw new Error("The connection to the server was lost. Try again.");
}

function isoRange(startDate: string, endDate: string): [string, string] {
  return [localMidnight(startDate).toISOString(), localMidnight(endDate, 1).toISOString()];
}

/** A random UUID; crypto.randomUUID only exists on HTTPS pages. */
function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const syncStatus = document.querySelector<HTMLElement>("#sync-status")!;
const store = createOfflineStore(
  (method, path, body) => request(method, path, body, token(), AbortSignal.timeout(8000)),
  renderSyncStatus,
);

function renderSyncStatus() {
  const { offline, pending, error } = store.status();
  const unsynced = pending ? `${pending} ${pending === 1 ? "change" : "changes"} not synced` : "";
  syncStatus.textContent =
    error || (offline ? ["Offline", unsynced].filter(Boolean).join(" · ") : unsynced);
  syncStatus.classList.toggle("is-error", Boolean(error));
  syncStatus.hidden = !syncStatus.textContent;
}

function syncNow() {
  store
    .flush()
    .then(() => window.dispatchEvent(new Event("tracking-changed")))
    .catch((error) => {
      if (error instanceof ServerError && error.status === 401) signOut("Please sign in again.");
    });
}

renderSyncStatus();
window.addEventListener("online", syncNow);
window.addEventListener("offline", renderSyncStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && store.status().pending) syncNow();
});
setInterval(() => {
  if (store.status().pending) syncNow();
}, 15_000);

type Params = Record<string, string | null | undefined>;

async function handle(method: string, params: Params): Promise<unknown> {
  switch (method) {
    case "getStoredApiKey":
      return { apiKey: null };
    case "setContentMaxHeight":
      return null;
    case "getSetupState":
      return { dataSource: "server", configured: true, tracking: true };
    case "getTimer":
      return { running: await store.running() };
    case "startTimer": {
      const running = await store.running();
      if (running) return { running };
      const entry = { id: uuid(), start: new Date().toISOString(), end: null };
      store.put(entry);
      return { running: entry };
    }
    case "stopTimer": {
      const running = await store.running();
      if (running) store.put({ ...running, end: new Date().toISOString() });
      return { running: null };
    }
    case "discardTimer": {
      const running = await store.running();
      if (running) store.remove(running.id);
      return { running: null };
    }
    case "listEntries":
      return store.list(...isoRange(params["startDate"]!, params["endDate"]!));
    case "saveEntry": {
      const entry = {
        id: params["id"] ?? uuid(),
        start: params["start"]!,
        end: params["end"] ?? null,
      };
      store.put(entry);
      return entry;
    }
    case "deleteEntry":
      store.remove(params["id"]!);
      return null;
    case "analyzeOvertime": {
      const { startDate, endDate } = params as { startDate: string; endDate: string };
      const entries = await store.list(...isoRange(startDate, endDate));
      return buildOvertime(secondsPerDay(entries), startDate, endDate);
    }
    default:
      throw new Error(`${method} is not available in the web UI`);
  }
}

setTransport(async (method, params) => {
  try {
    return await handle(method, (params ?? {}) as Params);
  } catch (error) {
    if (error instanceof Unauthorized) signOut(error.message);
    if (error instanceof ServerError && error.status === 401) signOut("Please sign in again.");
    throw error;
  }
});

const settingsView = document.querySelector<HTMLElement>("#settings-view")!;

const usernameForm = document.querySelector<HTMLFormElement>("#username-form")!;
const usernameStatus = document.querySelector<HTMLSpanElement>("#username-status")!;
usernameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>("#settings-username")!;
  const show = (text: string, isError = false) => {
    usernameStatus.textContent = text;
    usernameStatus.className = `save-status row-label ${isError ? "is-error" : "is-success"}`;
  };
  try {
    const { username } = await api<{ username: string }>("POST", "/api/username", {
      username: input.value,
    });
    const previous = localStorage.getItem(USERNAME_KEY) ?? "";
    // The welcome card remembers its dismissal per username.
    const dismissed = localStorage.getItem(`welcome_dismissed:${previous}`);
    if (dismissed) localStorage.setItem(`welcome_dismissed:${username}`, dismissed);
    localStorage.setItem(USERNAME_KEY, username);
    input.value = username;
    document.querySelector<HTMLInputElement>("#password-username")!.value = username;
    show("✓ Saved");
  } catch (error) {
    if (error instanceof Unauthorized) signOut(error.message);
    else show(error instanceof Error ? error.message : String(error), true);
  }
});

const passwordForm = document.querySelector<HTMLFormElement>("#password-form")!;
const passwordStatus = document.querySelector<HTMLSpanElement>("#password-status")!;
passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const [current, next, repeat] = ["#password-current", "#password-new", "#password-repeat"].map(
    (selector) => document.querySelector<HTMLInputElement>(selector)!,
  );
  const show = (text: string, isError = false) => {
    passwordStatus.textContent = text;
    passwordStatus.className = `save-status row-label ${isError ? "is-error" : "is-success"}`;
  };
  if (next!.value !== repeat!.value) {
    show("The new passwords don't match.", true);
    return;
  }
  try {
    await api("POST", "/api/password", {
      currentPassword: current!.value,
      newPassword: next!.value,
    });
    passwordForm.reset();
    show("✓ Password changed");
  } catch (error) {
    if (error instanceof Unauthorized) signOut(error.message);
    else show(error instanceof Error ? error.message : String(error), true);
  }
});

function signOut(message = "") {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(DASHBOARD_CACHE_KEY);
  } catch {}
  store.clear();
  mainView.hidden = settingsView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message;
}

/** The overview, or the settings at #settings, once signed in. */
function showSignedInView() {
  const settings = location.hash === "#settings";
  loginView.hidden = true;
  mainView.hidden = settings;
  settingsView.hidden = !settings;
  window.scrollTo(0, 0);
  // The chart is sized while visible; draw it again after the overview was hidden.
  if (!settings) window.dispatchEvent(new Event("resize"));
}

window.addEventListener("hashchange", () => {
  if (token()) showSignedInView();
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  try {
    const session = await api<{ token: string; username: string }>("POST", "/api/login", {
      username: loginUsername.value.trim(),
      password: loginPassword.value,
    });
    localStorage.setItem(TOKEN_KEY, session.token);
    localStorage.setItem(USERNAME_KEY, session.username);
    loginPassword.value = "";
    showMain();
  } catch (error) {
    loginError.textContent = error instanceof Error ? error.message : String(error);
  }
});

document.querySelector("#sign-out")!.addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  history.replaceState(null, "", location.pathname);
  signOut();
});

type ImportSource = {
  id: string;
  name: string;
  description: string;
  fields: { name: string; label: string; type: "text" | "password" | "file"; accept?: string }[];
  help: string;
  /** Turns the form's values into the request body; by default they are sent as they are. */
  toInput?: (values: Record<string, string | File>) => Promise<Record<string, unknown>>;
};

const importSources: ImportSource[] = [
  {
    id: "clockify",
    name: "Clockify",
    description: "Copies all your Clockify time entries to this server.",
    fields: [{ name: "apiKey", label: "Clockify API key", type: "password" }],
    help:
      "In Clockify: profile menu → Preferences → Advanced → Manage API keys → Generate new. " +
      "The key is only used for this import and not stored.",
  },
  {
    id: "backup",
    name: "Backup",
    description: "Restores entries from a JSON export of this app.",
    fields: [
      { name: "file", label: "JSON export", type: "file", accept: ".json,application/json" },
    ],
    help: "Export one under Settings → Export → JSON.",
    toInput: async ({ file }) => {
      try {
        return { entries: JSON.parse(await (file as File).text()).entries };
      } catch {
        throw new Error("This file is not a JSON export of this app.");
      }
    },
  },
];

const importDialog = document.querySelector<HTMLDialogElement>("#import-dialog")!;
const importChoose = document.querySelector<HTMLElement>("#import-choose")!;
const importForm = document.querySelector<HTMLFormElement>("#import-form")!;
const importFields = document.querySelector<HTMLElement>("#import-fields")!;
const importResult = document.querySelector<HTMLParagraphElement>("#import-result")!;
const importSubmit = document.querySelector<HTMLButtonElement>("#import-submit")!;
let importSource: ImportSource | null = null;
let importRun: AbortController | null = null;

function renderSources(container: HTMLElement) {
  container.replaceChildren(
    ...importSources.map((source) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "import-source";
      button.innerHTML = `<span class="import-source-name"></span><span class="import-source-hint"></span>`;
      button.children[0]!.textContent = source.name;
      button.children[1]!.textContent = source.description;
      button.addEventListener("click", () => openImport(source));
      return button;
    }),
  );
}

function showImportStep(source: ImportSource | null) {
  importRun?.abort();
  importSource = source;
  importChoose.hidden = source !== null;
  importForm.hidden = source === null;
  importResult.textContent = "";
  importResult.classList.remove("is-success");
  if (!source) return;
  document.querySelector("#import-title")!.textContent = `Import from ${source.name}`;
  document.querySelector("#import-description")!.textContent = source.description;
  document.querySelector("#import-help")!.textContent = source.help;
  importFields.replaceChildren(
    ...source.fields.map((field) => {
      const row = document.createElement("div");
      row.className = "row row--stacked";
      const label = document.createElement("label");
      label.htmlFor = `import-field-${field.name}`;
      label.textContent = field.label;
      const input = document.createElement("input");
      input.id = `import-field-${field.name}`;
      input.name = field.name;
      input.type = field.type;
      if (field.accept) input.accept = field.accept;
      input.required = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      row.append(label, input);
      return row;
    }),
  );
}

function openImport(source: ImportSource | null = null) {
  showImportStep(source);
  if (!importDialog.open) importDialog.showModal();
}

renderSources(document.querySelector<HTMLElement>("#import-sources")!);
document.querySelector("#import-back")!.addEventListener("click", () => showImportStep(null));
for (const button of Array.from(document.querySelectorAll("[data-import-close]"))) {
  button.addEventListener("click", () => importDialog.close());
}
importDialog.addEventListener("close", () => importRun?.abort());
importForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!importSource) return;
  const source = importSource;
  const inputs = Array.from(importFields.querySelectorAll("input"));
  importSubmit.disabled = true;
  importResult.classList.add("is-success");
  importResult.textContent = "Importing…";
  const run = (importRun = new AbortController());
  try {
    const { imported, skipped, running } = await runImport(
      source.id,
      await (source.toInput ?? (async (values) => values))(
        Object.fromEntries(
          inputs.map((input) => [input.name, input.files?.[0] ?? input.value] as const),
        ),
      ),
      (message) => (importResult.textContent = message),
      run.signal,
    );
    for (const input of inputs) input.value = "";
    importResult.textContent =
      `Imported ${imported} ${imported === 1 ? "entry" : "entries"}` +
      (skipped ? `, skipped ${skipped} that are already on the server` : "") +
      (running ? `. A running ${source.name} timer was not imported.` : ".");
    window.dispatchEvent(new Event("tracking-changed"));
  } catch (error) {
    if (run.signal.aborted) return;
    if (error instanceof Unauthorized) {
      importDialog.close();
      signOut(error.message);
      return;
    }
    importResult.classList.remove("is-success");
    importResult.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (importRun === run) importRun = null;
    importSubmit.disabled = false;
  }
});

// Until a user has any entries, the main view offers to import them.
const welcome = document.querySelector<HTMLElement>("#welcome")!;
const welcomeDismissedKey = () => `welcome_dismissed:${localStorage.getItem(USERNAME_KEY) ?? ""}`;
renderSources(document.querySelector<HTMLElement>("#welcome-sources")!);
renderSources(document.querySelector<HTMLElement>("#settings-import-sources")!);

// Kept per browser; theme.js applies it before the page is drawn.
const THEME_KEY = "theme";
initializeThemePicker(
  (document.documentElement.dataset["theme"] as "light" | "dark" | undefined) ?? "system",
  (theme) => {
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {}
    if (theme === "system") delete document.documentElement.dataset["theme"];
    else document.documentElement.dataset["theme"] = theme;
  },
);
document.querySelector("#welcome-dismiss")!.addEventListener("click", () => {
  localStorage.setItem(welcomeDismissedKey(), "true");
  welcome.hidden = true;
});

async function updateWelcome() {
  if (localStorage.getItem(welcomeDismissedKey())) {
    welcome.hidden = true;
    return;
  }
  try {
    const { hasEntries } = await api<{ hasEntries: boolean }>("GET", "/api/me");
    welcome.hidden = hasEntries;
  } catch {}
}

// ─── Export ──────────────────────────────────────────────────────────────

function pad(n: number) {
  return String(n).padStart(2, "0");
}
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// Spreadsheets run a cell starting with one of these as a formula, so names get a leading '.
function asText(value: string) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function csvValue(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row per entry in the browser's time zone, plus ISO times; a running entry has no end. */
const PROJECT_PREFIX = "project:";

function toCsv(entries: TrackedEntry[]) {
  const header = [
    "Project",
    "Labels",
    "Start Date",
    "Start Time",
    "End Date",
    "End Time",
    "Duration",
    "Duration (hours)",
    "Start (ISO 8601)",
    "End (ISO 8601)",
  ];
  const rows = entries.map(({ start, end, labels = [] }) => {
    const from = new Date(start);
    const to = end ? new Date(end) : null;
    const seconds = to ? Math.round((to.getTime() - from.getTime()) / 1000) : null;
    const project = labels.find((label) => label.startsWith(PROJECT_PREFIX));
    return [
      asText(project?.slice(PROJECT_PREFIX.length) ?? ""),
      asText(labels.join("; ")),
      localDate(from),
      localTime(from),
      to ? localDate(to) : "",
      to ? localTime(to) : "",
      seconds === null
        ? ""
        : `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`,
      seconds === null ? "" : (seconds / 3600).toFixed(2),
      start,
      end ?? "",
    ];
  });
  return [header, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}

async function exportEntries(format: "csv" | "json") {
  const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const entries = await api<TrackedEntry[]>(
    "GET",
    `/api/entries?from=1970-01-01T00:00:00.000Z&to=${encodeURIComponent(to)}`,
  );
  const body =
    format === "csv"
      ? toCsv(entries)
      : JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            entries: entries.map(({ id, start, end, labels = [] }) => ({
              id,
              start,
              end,
              labels,
              durationSeconds: end
                ? Math.round((Date.parse(end) - Date.parse(start)) / 1000)
                : null,
            })),
          },
          null,
          2,
        );
  const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `time-entries-${localDate(new Date())}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-export]"))) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await exportEntries(button.dataset["export"] as "csv" | "json");
    } catch (error) {
      if (error instanceof Unauthorized) signOut(error.message);
      else alert(error instanceof Error ? error.message : String(error));
    } finally {
      button.disabled = false;
    }
  });
}

let started = false;

function showMain() {
  showSignedInView();
  const username = localStorage.getItem(USERNAME_KEY) ?? "";
  document.querySelector<HTMLInputElement>("#settings-username")!.value = username;
  document.querySelector<HTMLInputElement>("#password-username")!.value = username;
  void updateWelcome();
  if (started) {
    window.dispatchEvent(new Event("tracking-changed"));
    return;
  }
  started = true;
  window.addEventListener("tracking-changed", () => void updateWelcome());

  initializeDashboard(() => {});
  initializeTracking({ alwaysShowEntries: true, assumeEnabled: true });
}

if (token()) showMain();
else signOut();

// Keeps the page working offline and lets browsers install it. Browsers only allow this on
// HTTPS pages (and localhost).
if ("serviceWorker" in navigator) {
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register("sw.js").catch((error) => console.error(error));
  // A new version took over: reload once nothing is being edited.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    const reload = () => {
      if (!document.querySelector("dialog[open]")) location.reload();
    };
    reload();
    document.addEventListener("visibilitychange", reload);
  });
}
