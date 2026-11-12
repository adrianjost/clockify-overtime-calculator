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
  if (!withSeconds) return `${hours}:${minutes}`;
  // A running timer shows hours only once it has run for one.
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${Number(minutes)}:${seconds}`;
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

/**
 * Timer button, time entry list and entry editor; only active with a self-hosted server.
 * The web UI shows the list all the time instead of in the #entries view.
 */
// Page padding, the dashboard at its narrowest, the gap and the sidebar.
const SIDEBAR_MIN_WIDTH = 40 + 420 + 16 + 280;

export function initializeTracking({ alwaysShowEntries = false, assumeEnabled = false } = {}) {
  const timerButton = el<HTMLButtonElement>("#timer-button");
  const discardButton = el<HTMLButtonElement>("#timer-discard");
  // The app shows the entries in a sidebar that can be turned off; the web page always shows them.
  const entriesToggle = document.querySelector<HTMLButtonElement>("#entries-toggle");
  const sidebar = document.querySelector<HTMLElement>("#entries-sidebar");
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

  // The web UI always tracks time, so it shows the Start button before the timer has loaded.
  let enabled = assumeEnabled;
  let running: TrackedEntry | null = null;
  let entries: TrackedEntry[] = [];
  let daysShown = DAYS_PER_PAGE;
  let editing: TrackedEntry | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let sidebarOpen: boolean | null = null;

  function entriesShown(): boolean {
    return alwaysShowEntries || (enabled && sidebarOpen === true);
  }

  function notifyChanged() {
    window.dispatchEvent(new Event("tracking-changed"));
  }

  // ─── Timer button ──────────────────────────────────────────────────────

  function renderTimer() {
    timerButton.hidden = !enabled;
    discardButton.hidden = !enabled || running === null;
    if (!running) resetDiscard();
    if (entriesToggle) {
      entriesToggle.hidden = !enabled;
      entriesToggle.setAttribute("aria-pressed", String(sidebarOpen === true));
      entriesToggle.title = sidebarOpen ? "Hide time entries" : "Show time entries";
    }
    if (sidebar && sidebar.hidden === entriesShown()) {
      sidebar.hidden = !entriesShown();
      // The window widens for the sidebar instead of squeezing the chart.
      void bridge.setContentMinWidth({ width: entriesShown() ? SIDEBAR_MIN_WIDTH : 0 });
      // The chart only redraws for a new width on resize.
      window.dispatchEvent(new Event("resize"));
    }
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

  let confirmDiscard: ReturnType<typeof setTimeout> | null = null;
  const discardLabel = discardButton.textContent?.trim() ?? "Discard";
  function resetDiscard() {
    if (confirmDiscard !== null) clearTimeout(confirmDiscard);
    confirmDiscard = null;
    discardButton.textContent = discardLabel;
    discardButton.classList.remove("is-confirming");
  }

  discardButton.addEventListener("click", async () => {
    if (confirmDiscard === null) {
      discardButton.textContent = "Click again to discard";
      discardButton.classList.add("is-confirming");
      confirmDiscard = setTimeout(resetDiscard, 3000);
      return;
    }
    resetDiscard();
    discardButton.disabled = timerButton.disabled = true;
    try {
      running = (await bridge.discardTimer({})).running;
      renderTimer();
      notifyChanged();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    } finally {
      discardButton.disabled = timerButton.disabled = false;
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

  // Days whose stack of entries is opened; all others show one card for the day.
  const expandedDays = new Set<string>();

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
      const rows = dayEntries.map((entry) => {
        const row = entryRow(entry.start, entry.end, entryMs(entry));
        row.classList.toggle("is-running", entry.end === null);
        row.addEventListener("click", () => openEditor(entry));
        return row;
      });
      if (rows.length > 1) {
        // Several entries collapse into one card for the whole day, like a stack of cards.
        const first = dayEntries[dayEntries.length - 1]!;
        const last = dayEntries[0]!;
        const summary = entryRow(first.start, last.end, total);
        summary.classList.add("entry-stack-summary");
        summary.classList.toggle("is-running", last.end === null);
        const count = document.createElement("span");
        count.className = "entry-count";
        count.textContent = String(rows.length);
        summary.children[0]!.prepend(count);
        const setExpanded = (expanded: boolean) => {
          section.classList.toggle("is-collapsed", !expanded);
          summary.setAttribute("aria-expanded", String(expanded));
          for (const row of rows) row.hidden = !expanded;
        };
        setExpanded(expandedDays.has(day));
        summary.addEventListener("click", () => {
          if (expandedDays.has(day)) expandedDays.delete(day);
          else expandedDays.add(day);
          setExpanded(expandedDays.has(day));
        });
        section.classList.add("entry-stack");
        box.append(summary);
      }
      box.append(...rows);
      section.append(title, box);
      list.append(section);
    }
  }

  function entryRow(start: string, end: string | null, ms: number): HTMLButtonElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row entry-row";
    row.innerHTML = `<span class="entry-span"></span><span class="entry-total"></span>`;
    const until = end ? timeOfDay(new Date(end)) : "now";
    row.children[0]!.textContent = `${timeOfDay(new Date(start))} – ${until}`;
    row.children[1]!.textContent = formatDuration(ms);
    return row;
  }

  moreButton.addEventListener("click", () => {
    daysShown += DAYS_PER_PAGE;
    void loadEntries();
  });
  el<HTMLButtonElement>("#add-entry").addEventListener("click", () => openEditor(null));
  entriesToggle?.addEventListener("click", () => {
    sidebarOpen = !sidebarOpen;
    void bridge.setEntriesSidebar({ enabled: sidebarOpen });
    renderTimer();
    if (sidebarOpen) {
      daysShown = DAYS_PER_PAGE;
      void loadEntries().catch((error) => console.error(error));
    }
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
    if (times && !times.end) {
      durationLabel.textContent = editing?.end === null ? "Running" : "";
      return;
    }
    durationLabel.textContent = times?.end
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
    if (entriesToggle && sidebarOpen === null) {
      sidebarOpen = await bridge
        .getEntriesSidebar({})
        .then(({ enabled }) => enabled)
        .catch(() => true);
    }
    renderTimer();
    if (entriesShown()) await loadEntries().catch((error) => console.error(error));
  }

  window.addEventListener("tracking-changed", () => void refresh());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  renderTimer();
  void refresh();
  return { refresh };
}
