import type { TrackedEntry } from "../shared/rpc.ts";
import { buildOvertime, localMidnight, secondsPerDay } from "../shared/overtime.ts";
import { bridge, setTransport } from "../mainview/bridge.ts";
import { renderOvertimeSummary } from "../mainview/overtime-summary.ts";
import { initRangePicker } from "../mainview/range-picker.ts";
import { initializeTracking } from "../mainview/tracking.ts";

// The mobile web UI served by the time tracking server. It reuses the app's views and talks to
// the server's API directly instead of through the macOS app.

const TOKEN_KEY = "server_session";
const USERNAME_KEY = "server_username";
const REFRESH_MS = 60 * 1000;

const loginView = document.querySelector<HTMLElement>("#login-view")!;
const mainView = document.querySelector<HTMLElement>("#main-view")!;
const loginForm = document.querySelector<HTMLFormElement>("#login-form")!;
const loginUsername = document.querySelector<HTMLInputElement>("#login-username")!;
const loginPassword = document.querySelector<HTMLInputElement>("#login-password")!;
const loginError = document.querySelector<HTMLSpanElement>("#login-error")!;
const status = document.querySelector<HTMLSpanElement>("#web-status")!;

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
  input: Record<string, string>,
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

function rangeQuery(startDate: string, endDate: string): string {
  const from = localMidnight(startDate).toISOString();
  const to = localMidnight(endDate, 1).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

type Params = Record<string, string | null | undefined>;
type Timer = { running: TrackedEntry | null };

async function handle(method: string, params: Params): Promise<unknown> {
  switch (method) {
    case "getSetupState":
      return { configured: true, tracking: true };
    case "getTimer":
      return api<Timer>("GET", "/api/timer");
    case "startTimer":
      return api<Timer>("POST", "/api/timer/start");
    case "stopTimer":
      await api("POST", "/api/timer/stop");
      return { running: null };
    case "discardTimer": {
      const { running } = await api<Timer>("GET", "/api/timer");
      if (running) await api("DELETE", `/api/entries/${running.id}`);
      return { running: null };
    }
    case "listEntries":
      return api("GET", `/api/entries?${rangeQuery(params["startDate"]!, params["endDate"]!)}`);
    case "saveEntry": {
      const body = { start: params["start"], end: params["end"] ?? null };
      return params["id"]
        ? api("PATCH", `/api/entries/${params["id"]}`, body)
        : api("POST", "/api/entries", body);
    }
    case "deleteEntry":
      return api("DELETE", `/api/entries/${params["id"]}`);
    case "analyzeOvertime": {
      const { startDate, endDate } = params as { startDate: string; endDate: string };
      const entries = await api<TrackedEntry[]>(
        "GET",
        `/api/entries?${rangeQuery(startDate, endDate)}`,
      );
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
    throw error;
  }
});

function signOut(message = "") {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {}
  mainView.hidden = true;
  loginView.hidden = false;
  loginError.textContent = message;
}

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
  signOut();
});

type ImportSource = {
  id: string;
  name: string;
  description: string;
  fields: { name: string; label: string; type: "text" | "password" }[];
  help: string;
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
document.querySelector("#import-open")!.addEventListener("click", () => openImport());
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
      Object.fromEntries(inputs.map((input) => [input.name, input.value])),
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

let started = false;
let refreshSummary = async () => {};

function showMain() {
  loginView.hidden = true;
  mainView.hidden = false;
  document.querySelector("#signed-in-as")!.textContent =
    `Signed in as ${localStorage.getItem(USERNAME_KEY) ?? ""} ·`;
  if (started) {
    window.dispatchEvent(new Event("tracking-changed"));
    return;
  }
  started = true;

  const overtimeValue = document.querySelector<HTMLDivElement>("#overtime-value");
  const content = document.querySelector<HTMLDivElement>("#content")!;
  const picker = initRangePicker(document.querySelector<HTMLElement>("#range-picker")!, () => {
    void refreshSummary();
  });

  refreshSummary = async () => {
    const { startDate, endDate } = picker.current();
    try {
      const data = await bridge.analyzeOvertime({ apiKey: "", startDate, endDate });
      renderOvertimeSummary(data, overtimeValue);
      content.style.removeProperty("display");
      status.textContent = "";
    } catch (error) {
      if (!(error instanceof Unauthorized)) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }
  };

  initializeTracking({ alwaysShowEntries: true });
  window.addEventListener("tracking-changed", () => void refreshSummary());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshSummary();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") void refreshSummary();
  }, REFRESH_MS);
  void refreshSummary();
}

if (token()) showMain();
else signOut();
