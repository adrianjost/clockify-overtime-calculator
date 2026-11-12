import type { OvertimeData } from "../shared/rpc.ts";

/** The overtime balance and this week's worked vs. target hours above the chart. */
export function renderOvertimeSummary(data: OvertimeData, overtimeValue: HTMLDivElement | null) {
  updateOvertimeDisplay(data, overtimeValue);
  updateWeekStat(data);
}

function updateOvertimeDisplay(data: OvertimeData, overtimeValue: HTMLDivElement | null) {
  if (!overtimeValue) return;

  const totalMinutes = data.totalOvertimeHours * 60 + data.totalOvertimeMinutes;
  const displayText = formatMinutes(totalMinutes);
  overtimeValue.classList.toggle("is-positive", totalMinutes > 0);
  overtimeValue.classList.toggle("is-negative", totalMinutes < 0);
  if (overtimeValue.dataset["minutes"] === undefined) {
    countUp(overtimeValue, totalMinutes, displayText);
  } else {
    overtimeValue.textContent = displayText;
  }
  overtimeValue.dataset["minutes"] = String(totalMinutes);

  const mood = document.querySelector<HTMLDivElement>("#overtime-mood");
  if (mood && mood.dataset["minutes"] !== String(totalMinutes)) {
    mood.dataset["minutes"] = String(totalMinutes);
    const { emoji, text } = describeBalance(totalMinutes);
    mood.innerHTML = "";
    const emojiSpan = document.createElement("span");
    emojiSpan.className = "emoji";
    emojiSpan.textContent = emoji;
    mood.append(emojiSpan, text);
  }
}

function mondayOf(date: Date): Date {
  const monday = new Date(date);
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return monday;
}

// Worked vs. target for the week (Monday–Sunday) containing the end of the range.
function updateWeekStat(data: OvertimeData) {
  const label = document.querySelector<HTMLElement>("#week-stat-label");
  const value = document.querySelector<HTMLElement>("#week-stat-value");
  const detail = document.querySelector<HTMLElement>("#week-stat-detail");
  const last = data.dailyData[data.dailyData.length - 1];
  if (!label || !value || !detail || !last) return;

  const end = new Date(last.date + "T00:00:00");
  const monday = mondayOf(end);
  const weekStart = formatIsoDate(monday);
  const week = data.dailyData.filter((d) => d.date >= weekStart && d.date <= last.date);

  const worked = week.reduce((sum, d) => sum + d.actualHours, 0);
  const target = week.reduce((sum, d) => sum + dayTarget(d), 0);
  const daysWorked = week.filter((d) => d.actualHours > 0).length;
  const diffMinutes = Math.round((worked - target) * 60);

  label.textContent =
    weekStart === formatIsoDate(mondayOf(new Date()))
      ? "This week"
      : `Week of ${monday.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  value.textContent =
    diffMinutes === 0
      ? "±0"
      : `${diffMinutes > 0 ? "+" : "−"}${formatHoursToHoursAndMinutes(diffMinutes / 60)}`;
  value.classList.toggle("is-positive", diffMinutes > 0);
  value.classList.toggle("is-negative", diffMinutes < 0);
  detail.textContent =
    daysWorked === 0
      ? "Nothing tracked yet"
      : `${formatHoursToHoursAndMinutes(worked)} of ${formatHoursToHoursAndMinutes(target)} · ${daysWorked} ${daysWorked === 1 ? "day" : "days"}`;
}

function formatMinutes(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? "+" : "−";
  return `${sign}${formatHoursToHoursAndMinutes(totalMinutes / 60)}`;
}

function countUp(element: HTMLElement, totalMinutes: number, finalText: string) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = finalText;
    return;
  }
  // Keep the final width while counting, so the layout around the number doesn't jump.
  element.textContent = finalText;
  element.style.minWidth = `${element.getBoundingClientRect().width}px`;
  const duration = 1300;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    element.textContent = t < 1 ? formatMinutes(Math.round(totalMinutes * eased)) : finalText;
    if (t < 1) requestAnimationFrame(step);
    else element.style.removeProperty("min-width");
  };
  requestAnimationFrame(step);
}

const WORKDAY_MINUTES = 8 * 60;

function describeBalance(totalMinutes: number): { emoji: string; text: string } {
  const days = totalMinutes / WORKDAY_MINUTES;
  if (totalMinutes === 0) return { emoji: "🎯", text: "Right on target." };
  if (totalMinutes > 0) {
    if (days >= 2) return { emoji: "🏝️", text: `About ${Math.floor(days)} days off banked.` };
    if (days >= 1) return { emoji: "🏖️", text: "A whole day off banked." };
    if (days >= 0.5) return { emoji: "🌴", text: "Half a day off banked." };
    if (totalMinutes >= 60) return { emoji: "☕️", text: "A long lunch banked." };
    return { emoji: "✨", text: "Slightly ahead." };
  }
  if (days <= -1) return { emoji: "🐢", text: "About a day to catch up." };
  if (totalMinutes <= -60) return { emoji: "⏳", text: "A few hours to catch up." };
  return { emoji: "🙂", text: "Almost there." };
}

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isWeekend(isoDate: string): boolean {
  const day = new Date(isoDate + "T00:00:00").getDay();
  return day === 0 || day === 6;
}

// Only weekdays with tracked time count towards the target, like in the overtime calculation.
export function dayTarget(day: OvertimeData["dailyData"][number]): number {
  return day.actualHours > 0 && !isWeekend(day.date) ? 8 : 0;
}

export function formatHoursToHoursAndMinutes(hours: number): string {
  const totalMinutes = Math.round(Math.abs(hours) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}min`;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}
