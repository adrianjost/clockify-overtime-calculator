import type { TrackedEntry } from "../shared/rpc.ts";
import { bridge } from "./bridge.ts";

const DAYS_PER_PAGE = 30;
const MINUTE = 60 * 1000;

function el<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element ${selector}`);
  return element;
}

function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function timeOfDay(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function inputTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDuration(ms: number, withSeconds = false): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return withSeconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
}

function entryMs(entry: TrackedEntry): number {
  const end = entry.end ? Date.parse(entry.end) : Date.now();
  return end - Date.parse(entry.start);
}

function dayHeading(day: string): string {
  const today = isoDate(new Date());
  if (day === today) return "Today";
  if (day === isoDate(addDays(new Date(), -1))) return "Yesterday";
  return new Date(`${day}T00:00`).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Timer button, time entry list and entry editor; only active with a self-hosted server. */
export function initializeTracking() {
  const timerButton = el<HTMLButtonElement>("#timer-button");
  const entriesLink = el<HTMLAnchorElement>("#entries-link");
  const list = el<HTMLDivElement>("#entries-list");
  const moreButton = el<HTMLButtonElement>("#entries-more");
  const dialog = el<HTMLDialogElement>("#entry-dialog");
  const form = el<HTMLFormElement>("#entry-form");
  const dialogTitle = el<HTMLHeadingElement>("#entry-dialog-title");
  const dateInput = el<HTMLInputElement>("#entry-date");
  const startInput = el<HTMLInputElement>("#entry-start");
  const endInput = el<HTMLInputElement>("#entry-end");
  const durationLabel = el<HTMLSpanElement>("#entry-duration");
  const errorLabel = el<HTMLParagraphElement>("#entry-error");
  const deleteButton = el<HTMLButtonElement>("#entry-delete");
  const saveButton = el<HTMLButtonElement>("#entry-save");

  let enabled = false;
  let running: TrackedEntry | null = null;
  let entries: TrackedEntry[] = [];
  let daysShown = DAYS_PER_PAGE;
  let editing: TrackedEntry | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;

  function notifyChanged() {
    window.dispatchEvent(new Event("tracking-changed"));
  }

  // ─── Timer button ──────────────────────────────────────────────────────

  function renderTimer() {
    timerButton.hidden = !enabled;
    entriesLink.hidden = !enabled;
    timerButton.classList.toggle("is-running", running !== null);
    if (running) {
      const elapsed = formatDuration(Date.now() - Date.parse(running.start), true);
      timerButton.innerHTML = `<span class="timer-icon timer-icon--stop"></span>${elapsed}`;
      timerButton.title = `Stop timer (started ${timeOfDay(new Date(running.start))})`;
    } else {
      timerButton.innerHTML = `<span class="timer-icon timer-icon--start"></span>Start`;
      timerButton.title = "Start timer";
    }
    if (running && tick === null) {
      tick = setInterval(renderTimer, 1000);
    } else if (!running && tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  }

  timerButton.addEventListener("click", async () => {
    timerButton.disabled = true;
    try {
      const result = running ? await bridge.stopTimer({}) : await bridge.startTimer({});
      running = result.running;
      renderTimer();
      notifyChanged();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      timerButton.disabled = false;
    }
  });

  // ─── Entry list ────────────────────────────────────────────────────────

  async function loadEntries() {
    if (!enabled) return;
    const today = new Date();
    entries = await bridge.listEntries({
      startDate: isoDate(addDays(today, -(daysShown - 1))),
      endDate: isoDate(today),
    });
    renderEntries();
  }

  function renderEntries() {
    const byDay = new Map<string, TrackedEntry[]>();
    for (const entry of [...entries].sort((a, b) => b.start.localeCompare(a.start))) {
      const day = isoDate(new Date(entry.start));
      byDay.set(day, [...(byDay.get(day) ?? []), entry]);
    }

    list.replaceChildren();
    if (byDay.size === 0) {
      const empty = document.createElement("p");
      empty.className = "entries-empty";
      empty.textContent = `No entries in the last ${daysShown} days.`;
      list.append(empty);
    }
    for (const [day, dayEntries] of byDay) {
      const section = document.createElement("section");
      section.className = "group";
      const total = dayEntries.reduce((sum, entry) => sum + entryMs(entry), 0);
      const title = document.createElement("h2");
      title.className = "group-title entries-day";
      title.innerHTML = `<span></span><span class="entries-day-total"></span>`;
      title.children[0]!.textContent = dayHeading(day);
      title.children[1]!.textContent = formatDuration(total);
      const box = document.createElement("div");
      box.className = "group-box";
      for (const entry of dayEntries) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row entry-row";
        const end = entry.end ? timeOfDay(new Date(entry.end)) : "now";
        row.innerHTML = `<span class="entry-span"></span><span class="entry-total"></span>`;
        row.children[0]!.textContent = `${timeOfDay(new Date(entry.start))} – ${end}`;
        row.children[1]!.textContent = formatDuration(entryMs(entry));
        row.classList.toggle("is-running", entry.end === null);
        row.addEventListener("click", () => openEditor(entry));
        box.append(row);
      }
      section.append(title, box);
      list.append(section);
    }
  }

  moreButton.addEventListener("click", () => {
    daysShown += DAYS_PER_PAGE;
    void loadEntries();
  });
  el<HTMLButtonElement>("#add-entry").addEventListener("click", () => openEditor(null));
  el<HTMLButtonElement>("#entries-back").addEventListener("click", () => {
    location.hash = "";
  });

  // ─── Editor ────────────────────────────────────────────────────────────

  /** Start and end as dates; an end before the start is on the next day. */
  function editedTimes(): { start: Date; end: Date | null } | null {
    if (!dateInput.value || !startInput.value) return null;
    const start = new Date(`${dateInput.value}T${startInput.value}`);
    if (!endInput.value) return { start, end: null };
    let end = new Date(`${dateInput.value}T${endInput.value}`);
    if (end <= start) end = addDays(end, 1);
    return { start, end };
  }

  function updateDuration() {
    const times = editedTimes();
    durationLabel.textContent =
      times?.end != null
        ? formatDuration(times.end.getTime() - times.start.getTime()) +
          (isoDate(times.end) !== isoDate(times.start) ? " (next day)" : "")
        : "";
  }

  function openEditor(entry: TrackedEntry | null) {
    editing = entry;
    const start = entry ? new Date(entry.start) : new Date(Date.now() - 60 * MINUTE);
    const end = entry ? (entry.end ? new Date(entry.end) : null) : new Date();
    dialogTitle.textContent = entry ? "Edit time entry" : "Add time entry";
    dateInput.value = isoDate(start);
    startInput.value = inputTime(start);
    endInput.value = end ? inputTime(end) : "";
    endInput.required = entry?.end !== null;
    deleteButton.hidden = entry === null;
    errorLabel.textContent = "";
    updateDuration();
    dialog.showModal();
    startInput.focus();
  }

  for (const input of [dateInput, startInput, endInput]) {
    input.addEventListener("input", updateDuration);
  }
  el<HTMLButtonElement>("#entry-cancel").addEventListener("click", () => dialog.close());

  async function run(action: () => Promise<unknown>) {
    errorLabel.textContent = "";
    saveButton.disabled = deleteButton.disabled = true;
    try {
      await action();
      dialog.close();
      notifyChanged();
    } catch (error) {
      errorLabel.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      saveButton.disabled = deleteButton.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const times = editedTimes();
    if (!times) return;
    if (times.end && times.end.getTime() > Date.now() + MINUTE) {
      errorLabel.textContent = "The end can't be in the future.";
      return;
    }
    void run(() =>
      bridge.saveEntry({
        ...(editing ? { id: editing.id } : {}),
        start: times.start.toISOString(),
        end: times.end?.toISOString() ?? null,
      }),
    );
  });

  let confirmDelete: ReturnType<typeof setTimeout> | null = null;
  deleteButton.addEventListener("click", () => {
    if (!editing) return;
    if (confirmDelete === null) {
      deleteButton.textContent = "Click again to delete";
      deleteButton.classList.add("btn-danger-confirm");
      confirmDelete = setTimeout(resetDelete, 3000);
      return;
    }
    resetDelete();
    const id = editing.id;
    void run(() => bridge.deleteEntry({ id }));
  });
  function resetDelete() {
    if (confirmDelete !== null) clearTimeout(confirmDelete);
    confirmDelete = null;
    deleteButton.textContent = "Delete";
    deleteButton.classList.remove("btn-danger-confirm");
  }
  dialog.addEventListener("close", resetDelete);

  // ─── State ─────────────────────────────────────────────────────────────

  async function refresh() {
    try {
      enabled = (await bridge.getSetupState({})).tracking;
      running = enabled ? (await bridge.getTimer({})).running : null;
    } catch (error) {
      console.error("Loading the timer failed:", error);
    }
    renderTimer();
    if (location.hash === "#entries") {
      if (enabled) await loadEntries().catch((error) => console.error(error));
      else location.hash = "";
    }
  }

  window.addEventListener("tracking-changed", () => void refresh());
  window.addEventListener("hashchange", () => {
    if (location.hash !== "#entries") return;
    if (!enabled) {
      location.hash = "";
      return;
    }
    daysShown = DAYS_PER_PAGE;
    void loadEntries().catch((error) => console.error(error));
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  void refresh();
  return { refresh };
}
