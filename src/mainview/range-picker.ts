const START_DATE_KEY = "clockify_viewed_start_date";

type IsoDate = string; // YYYY-MM-DD

export type RangePicker = {
  /** The selected range; the end is today's date while it follows today. */
  current(): { startDate: IsoDate; endDate: IsoDate };
};

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date): IsoDate =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (iso: IsoDate) => new Date(`${iso}T00:00:00`);
const todayIso = () => toIso(new Date());

function addMonths(iso: IsoDate, months: number): IsoDate {
  const d = fromIso(iso);
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  return toIso(d);
}

function formatDay(iso: IsoDate, withYear: boolean): string {
  return fromIso(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

const PRESETS: Array<{ label: string; start: () => IsoDate }> = [
  { label: "This year", start: () => `${new Date().getFullYear()}-01-01` },
  { label: "Last 12 months", start: () => addDays(addMonths(todayIso(), -12), 1) },
  { label: "Last 3 months", start: () => addDays(addMonths(todayIso(), -3), 1) },
  { label: "This month", start: () => todayIso().slice(0, 8) + "01" },
];

function addDays(iso: IsoDate, days: number): IsoDate {
  const d = fromIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

const CALENDAR_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2.5"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>`;

export function initRangePicker(root: HTMLElement, onChange: () => void): RangePicker {
  let start: IsoDate = localStorage.getItem(START_DATE_KEY) || `${new Date().getFullYear()}-01-01`;
  let fixedEnd: IsoDate | null = null; // null = follows today
  let pendingStart: IsoDate | null = null;
  let visibleMonth: IsoDate = todayIso().slice(0, 8) + "01";

  root.innerHTML = `
    <button type="button" class="range-button" aria-haspopup="dialog" aria-expanded="false">
      ${CALENDAR_ICON}<span class="range-label"></span>${CHEVRON_ICON}
    </button>
    <button type="button" class="range-today" hidden>Today</button>
    <div class="range-popover" role="dialog" aria-label="Date range" hidden>
      <div class="range-presets"></div>
      <div class="calendar">
        <div class="calendar-header">
          <button type="button" class="calendar-nav" data-step="-1" aria-label="Previous month">‹</button>
          <span class="calendar-title"></span>
          <button type="button" class="calendar-nav" data-step="1" aria-label="Next month">›</button>
        </div>
        <div class="calendar-grid"></div>
      </div>
      <p class="range-hint"></p>
      <label class="range-follow">
        <span>End date follows today</span>
        <input type="checkbox" switch />
      </label>
    </div>`;

  const button = root.querySelector<HTMLButtonElement>(".range-button")!;
  const label = root.querySelector<HTMLSpanElement>(".range-label")!;
  const todayButton = root.querySelector<HTMLButtonElement>(".range-today")!;
  const popover = root.querySelector<HTMLDivElement>(".range-popover")!;
  const presets = root.querySelector<HTMLDivElement>(".range-presets")!;
  const title = root.querySelector<HTMLSpanElement>(".calendar-title")!;
  const grid = root.querySelector<HTMLDivElement>(".calendar-grid")!;
  const hint = root.querySelector<HTMLParagraphElement>(".range-hint")!;
  const follow = root.querySelector<HTMLInputElement>(".range-follow input")!;

  const end = () => fixedEnd ?? todayIso();

  function commit(newStart: IsoDate, newFixedEnd: IsoDate | null) {
    const changed = newStart !== start || (newFixedEnd ?? todayIso()) !== end();
    start = newStart;
    fixedEnd = newFixedEnd;
    localStorage.setItem(START_DATE_KEY, start);
    render();
    if (changed) onChange();
  }

  function renderButton() {
    const currentYear = new Date().getFullYear();
    const endYear = fromIso(end()).getFullYear();
    const startLabel = formatDay(start, fromIso(start).getFullYear() !== endYear);
    label.textContent = "";
    label.append(`${startLabel} – `);
    if (fixedEnd === null) {
      const live = document.createElement("span");
      live.className = "range-live";
      live.textContent = "Today";
      label.append(live);
    } else {
      label.append(formatDay(fixedEnd, endYear !== currentYear));
    }
    root.classList.toggle("is-fixed", fixedEnd !== null);
    todayButton.hidden = fixedEnd === null;
    button.title =
      fixedEnd === null
        ? "The range ends today and moves along with the date."
        : "The range ends on a fixed date.";
    todayButton.title = "Let the range end follow today again";
  }

  function renderCalendar() {
    const month = fromIso(visibleMonth);
    title.textContent = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    const today = todayIso();
    const rangeStart = pendingStart ?? start;
    const rangeEnd = pendingStart ? pendingStart : end();
    // Monday-first grid
    const firstWeekday = (month.getDay() + 6) % 7;
    const gridStart = addDays(visibleMonth, -firstWeekday);

    grid.innerHTML = "";
    for (const name of ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]) {
      const cell = document.createElement("span");
      cell.className = "calendar-weekday";
      cell.textContent = name;
      grid.append(cell);
    }
    for (let i = 0; i < 42; i++) {
      const day = addDays(gridStart, i);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "calendar-day";
      cell.textContent = String(fromIso(day).getDate());
      cell.dataset["date"] = day;
      cell.disabled = day > today;
      cell.classList.toggle("is-outside", day.slice(0, 7) !== visibleMonth.slice(0, 7));
      cell.classList.toggle("is-today", day === today);
      cell.classList.toggle("is-in-range", day > rangeStart && day < rangeEnd);
      cell.classList.toggle("is-range-start", day === rangeStart);
      cell.classList.toggle("is-range-end", day === rangeEnd);
      grid.append(cell);
    }

    hint.textContent = pendingStart
      ? "Now pick the end date."
      : "Pick a start date, then an end date.";
    follow.checked = fixedEnd === null;
  }

  function renderPresets() {
    presets.innerHTML = "";
    for (const preset of PRESETS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "range-preset";
      chip.textContent = preset.label;
      chip.classList.toggle("is-active", fixedEnd === null && start === preset.start());
      chip.addEventListener("click", () => {
        pendingStart = null;
        commit(preset.start(), null);
        close();
      });
      presets.append(chip);
    }
  }

  function render() {
    renderButton();
    renderPresets();
    if (!popover.hidden) renderCalendar();
  }

  function open() {
    pendingStart = null;
    visibleMonth = end().slice(0, 8) + "01";
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    renderCalendar();
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("keydown", onKeyDown);
  }

  function close() {
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    pendingStart = null;
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("keydown", onKeyDown);
  }

  function onOutsidePointer(event: PointerEvent) {
    if (!root.contains(event.target as Node)) close();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") close();
  }

  button.addEventListener("click", () => (popover.hidden ? open() : close()));

  todayButton.addEventListener("click", () => commit(start, null));

  root.querySelectorAll<HTMLButtonElement>(".calendar-nav").forEach((nav) =>
    nav.addEventListener("click", () => {
      visibleMonth = addMonths(visibleMonth, Number(nav.dataset["step"]));
      renderCalendar();
    }),
  );

  grid.addEventListener("click", (event) => {
    const day = (event.target as HTMLElement).closest<HTMLButtonElement>(".calendar-day");
    if (!day || day.disabled) return;
    const date = day.dataset["date"]!;
    if (pendingStart === null) {
      pendingStart = date;
      renderCalendar();
      return;
    }
    const [from, to] = pendingStart <= date ? [pendingStart, date] : [date, pendingStart];
    pendingStart = null;
    commit(from, to === todayIso() ? null : to);
    close();
  });

  follow.addEventListener("change", () => {
    commit(start, follow.checked ? null : todayIso());
  });

  render();

  return {
    current: () => ({ startDate: start, endDate: end() }),
  };
}
