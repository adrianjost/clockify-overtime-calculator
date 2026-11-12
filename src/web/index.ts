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

async function api<T>(method: string, path: string, body?: unknown, auth = token()): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  if (response.status === 401) {
    throw new Unauthorized(json?.error === "Unauthorized" ? "Please sign in again." : json?.error);
  }
  if (!response.ok) throw new Error(json?.error ?? `Server error (HTTP ${response.status})`);
  return json as T;
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
