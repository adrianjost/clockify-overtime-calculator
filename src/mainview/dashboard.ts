import type { OvertimeData } from "../shared/rpc.ts";
import { bridge } from "./bridge.ts";
import { initRangePicker } from "./range-picker.ts";
import {
  formatHoursToHoursAndMinutes,
  formatIsoDate,
  isWeekend,
  dayTarget,
  renderOvertimeSummary,
} from "./overtime-summary.ts";

type CumulativeMode = "daily" | "weekly";

// Zoom/pan state — indices into lastFilledData. null = full range.
let focusRange: { start: number; end: number } | null = null;
// Cached full dataset so interaction handlers can compute zoomed slices.
let lastFilledData: OvertimeData["dailyData"] = [];
// Animate the chart once when data is first shown, not on every poll, zoom or resize.
let animateNextRender = true;

type DayRange = { start: number; end: number };
const ZOOM_ANIMATION_MS = 240;
// Range shown by the last render, and the running zoom animation (if any).
let renderedRange: DayRange | null = null;
let zoomAnimation: { from: DayRange; to: DayRange; startedAt: number } | null = null;
// Set right before a zoom/pan re-render that should animate from the current view.
let animateZoomFrom: DayRange | null = null;
// Daily/weekly bars, switched with some hysteresis so zooming near the threshold doesn't flip-flop.
let useWeeklyBars = false;
const MAX_CHART_HEIGHT = 400;
// The last analysis, shown right away on the next start while fresh data loads.
export const DASHBOARD_CACHE_KEY = "dashboard-cache";
type CachedAnalysis = { startDate: string; endDate: string; data: OvertimeData };
// Per mouse wheel notch: zoom by 8%, pan by 5% of the visible range.
const ZOOM_STEP = 0.92;
const PAN_STEP = 0.05;
let lastMaxContentHeight = 0;

/** The range currently on screen, taking a running zoom animation into account. */
function visibleRangeNow(): DayRange | null {
  if (!zoomAnimation) return renderedRange;
  const t = Math.min(1, (performance.now() - zoomAnimation.startedAt) / ZOOM_ANIMATION_MS);
  const eased = 1 - Math.pow(1 - t, 3);
  const { from, to } = zoomAnimation;
  return {
    start: from.start + (to.start - from.start) * eased,
    end: from.end + (to.end - from.end) * eased,
  };
}

function requestAnimatedZoom() {
  animateZoomFrom = visibleRangeNow();
}

export function initializeDashboard(onNavigateToSettings: () => void) {
  const rangePickerEl = document.querySelector<HTMLElement>("#range-picker");
  const lastFetchedEl = document.querySelector<HTMLDivElement>("#last-fetched");
  const fetchSpinner = document.querySelector<HTMLElement>("#fetch-spinner");
  const content = document.querySelector<HTMLDivElement>("#content");
  const overtimeValue = document.querySelector<HTMLDivElement>("#overtime-value");
  let lastData: OvertimeData | null = null;
  let resizeRafId: number | null = null;

  if (!rangePickerEl) {
    throw new Error("Dashboard range picker is missing");
  }

  const rangePicker = initRangePicker(rangePickerEl, () => {
    focusRange = null; // Reset zoom when changing date range
    runAnalysis();
  });

  // Polling state — declared before runAnalysis so the closure can reference them
  const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
  const MIN_REFETCH_ON_VISIBILITY_MS = 60 * 1000;
  let lastFetchTime = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function getStoredApiKey(): Promise<string> {
    const state = await bridge.getStoredApiKey({});
    return (state?.apiKey ?? "").trim();
  }

  async function runAnalysis() {
    const [apiKey, { configured }] = await Promise.all([
      getStoredApiKey(),
      bridge.getSetupState({}),
    ]);
    if (!configured) {
      onNavigateToSettings();
      return;
    }

    const { startDate, endDate } = rangePicker.current();

    setLoading(true);
    lastFetchTime = Date.now();

    try {
      console.log("🔍 Analyzing overtime from:", startDate, "to:", endDate);
      const data = await bridge.analyzeOvertime({
        apiKey,
        startDate,
        endDate,
      });
      lastData = data;
      try {
        localStorage.setItem(
          DASHBOARD_CACHE_KEY,
          JSON.stringify({ startDate, endDate, data } satisfies CachedAnalysis),
        );
      } catch {}
      console.log("📊 Analysis complete:", {
        totalHours: data.totalOvertimeHours,
        totalMinutes: data.totalOvertimeMinutes,
        dayCount: data.dailyData.length,
      });
      renderDashboard(data, overtimeValue, content);
      setLoading(false);
      if (lastFetchedEl) {
        lastFetchedEl.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
        lastFetchedEl.appendChild(fetchSpinner!);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setLoading(false);
      if (lastFetchedEl) lastFetchedEl.textContent = `Error: ${message}`;
    }
  }

  const cached = readCachedAnalysis(rangePicker.current());
  if (cached) {
    lastData = cached;
    // The numbers are already on screen, so the fresh data replaces them without animation.
    animateNextRender = false;
    if (overtimeValue) overtimeValue.dataset["minutes"] = "";
    renderDashboard(cached, overtimeValue, content);
  }

  // Auto-fetch on initial load
  runAnalysis();

  async function fetchIfApiKeyPresent() {
    const { configured } = await bridge.getSetupState({});
    if (!configured) return;
    await runAnalysis();
  }

  window.addEventListener("tracking-changed", () => void runAnalysis());

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = setInterval(fetchIfApiKeyPresent, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - lastFetchTime >= MIN_REFETCH_ON_VISIBILITY_MS) {
        fetchIfApiKeyPresent();
      }
      startPolling();
    } else {
      stopPolling();
    }
  });

  if (document.visibilityState === "visible") {
    startPolling();
  }

  window.addEventListener("resize", () => {
    if (!lastData) {
      return;
    }
    if (resizeRafId !== null) {
      cancelAnimationFrame(resizeRafId);
    }
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      renderDashboard(lastData!, overtimeValue, content);
    });
  });

  function setLoading(loading: boolean) {
    if (fetchSpinner) fetchSpinner.hidden = !loading;
  }

  // Register chart zoom/pan interaction once (persists across re-renders).
  const chartContainer = document.querySelector<HTMLDivElement>("#daily-chart");
  if (chartContainer) {
    setupChartInteraction(chartContainer);
  }

  // chart-interaction: wheel/drag changed focusRange, re-render.
  document.addEventListener("chart-interaction", () => {
    if (lastData) renderDashboard(lastData, overtimeValue, content);
  });

  // zoom-reset: reset button or dblclick, back to full range.
  document.addEventListener("zoom-reset", () => {
    requestAnimatedZoom();
    focusRange = null;
    if (lastData) renderDashboard(lastData, overtimeValue, content);
  });

  return { runAnalysis };
}

function readCachedAnalysis(range: { startDate: string; endDate: string }): OvertimeData | null {
  try {
    const cached = JSON.parse(
      localStorage.getItem(DASHBOARD_CACHE_KEY) ?? "null",
    ) as CachedAnalysis | null;
    return cached?.startDate === range.startDate && cached.endDate === range.endDate
      ? cached.data
      : null;
  } catch {
    return null;
  }
}

function renderDashboard(
  data: OvertimeData,
  overtimeValue: HTMLDivElement | null,
  content: HTMLDivElement | null,
) {
  if (!overtimeValue || !content) return;

  content.style.removeProperty("display");
  renderOvertimeSummary(data, overtimeValue);

  // Render charts
  renderCharts(data);
}

function renderCharts(data: OvertimeData) {
  try {
    console.log("Rendering charts with data:", {
      totalOvertimeHours: data.totalOvertimeHours,
      dailyDataLength: data.dailyData.length,
    });

    const dailyContainer = document.querySelector<HTMLDivElement>("#daily-chart");

    if (!dailyContainer) {
      console.error("Daily chart container not found");
      return;
    }

    // Clear container
    dailyContainer.innerHTML = "";

    // Fill missing calendar days with zero-hour entries.
    const trackedDays = fillMissingDays(data.dailyData);
    // Leave room for the rest of the last week, so the chart doesn't end abruptly mid-week.
    const filledDailyData = padToWeekEnd(trackedDays);
    lastFilledData = filledDailyData;

    // Apply focus range (zoom/pan). Full year when null.
    const totalLen = filledDailyData.length;
    const effective = focusRange
      ? {
          start: Math.max(0, focusRange.start),
          end: Math.min(totalLen - 1, focusRange.end),
        }
      : { start: 0, end: totalLen - 1 };
    // The range may be fractional while zooming; bars are positioned by date anyway.
    const visibleData = filledDailyData.slice(
      Math.floor(effective.start),
      Math.ceil(effective.end) + 1,
    );
    const visibleCount = effective.end - effective.start + 1;

    // Render bar chart
    const chartWidth = Math.max(280, Math.floor(dailyContainer.clientWidth || 800));

    // Get available height from the charts-container flex space
    const chartsContainer = document.querySelector<HTMLDivElement>(".charts-container");
    let chartHeight = 300; // default
    if (chartsContainer) {
      const h2 = dailyContainer.parentElement?.querySelector("h2");
      const h2Height = h2 ? h2.offsetHeight + 8 : 0;
      const spaceForChart = chartsContainer.clientHeight - h2Height - 16;
      chartHeight = Math.min(MAX_CHART_HEIGHT, Math.max(200, spaceForChart));
      // Don't let the window grow taller than the chart can use.
      const maxContentHeight = Math.ceil(window.innerHeight + MAX_CHART_HEIGHT - spaceForChart);
      if (Math.abs(maxContentHeight - lastMaxContentHeight) > 1) {
        lastMaxContentHeight = maxContentHeight;
        void bridge.setContentMaxHeight({ height: maxContentHeight });
      }
    }

    const pixelsPerDay = chartWidth / visibleCount;
    useWeeklyBars = useWeeklyBars ? pixelsPerDay < 11 : pixelsPerDay < 8;
    const shouldUseWeekly = useWeeklyBars;

    // Bars for the whole range, positioned by date. The chart is a window onto them,
    // like a large image, so nothing changes shape while zooming or panning.
    const cumulativeMode: CumulativeMode = shouldUseWeekly ? "weekly" : "daily";
    const fullCumulative = buildCumulativeSeries(filledDailyData, cumulativeMode);
    const allBars = shouldUseWeekly
      ? weeklyBars(filledDailyData, fullCumulative)
      : dailyBars(trackedDays, fullCumulative, visibleCount <= 60);
    const firstVisible = allBars.findIndex((bar) => bar.start + bar.span > effective.start);
    let lastVisible = allBars.length - 1;
    while (lastVisible > 0 && allBars[lastVisible].start > effective.end) lastVisible--;
    // Two extra bars on each side keep the balance curve's shape stable at the edges.
    const shownBars = allBars.slice(Math.max(0, firstVisible - 2), lastVisible + 3);

    const yDomain: YDomain = {
      maxHours: Math.max(...allBars.map((bar) => Math.max(bar.hours, bar.detail.target)), 8),
      cumulativeMin: Math.min(...allBars.map((bar) => bar.cumulative), 0),
      cumulativeMax: Math.max(...allBars.map((bar) => bar.cumulative), 0),
    };

    // Update chart title; show date range + reset button when zoomed
    const h2Title = dailyContainer.parentElement?.querySelector("h2");
    if (h2Title) {
      const titleText = shouldUseWeekly ? "Weekly Working Hours" : "Daily Working Hours";
      h2Title.innerHTML = "";
      const textSpan = document.createElement("span");
      textSpan.textContent = titleText;
      h2Title.appendChild(textSpan);

      if (focusRange !== null) {
        const startDate = new Date(visibleData[0].date);
        const endDate = new Date(visibleData[visibleData.length - 1].date);
        const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const rangeSpan = document.createElement("span");
        rangeSpan.className = "chart-range-label";
        rangeSpan.textContent = `· ${fmt(startDate)} – ${fmt(endDate)}`;
        h2Title.appendChild(rangeSpan);

        const resetBtn = document.createElement("button");
        resetBtn.className = "zoom-reset-btn";
        resetBtn.textContent = "Reset zoom";
        resetBtn.title = "Reset zoom";
        resetBtn.addEventListener("click", () => {
          dailyContainer!.dispatchEvent(new CustomEvent("zoom-reset", { bubbles: true }));
        });
        h2Title.appendChild(resetBtn);
      }
    }

    // Show grab cursor when zoomed (draggable)
    dailyContainer.style.cursor = focusRange !== null ? "grab" : "";

    const barSvg = createBarChart(
      shownBars,
      effective.start,
      visibleCount,
      chartWidth,
      chartHeight,
      shouldUseWeekly,
      yDomain,
    );
    let intro: HTMLElement | null = null;
    if (animateNextRender) {
      animateNextRender = false;
      // Start once the window has painted, so the first frames aren't dropped.
      barSvg.classList.add("is-entering", "is-paused");
      intro = buildBarIntro(barSvg);
      const start = () => {
        barSvg.classList.remove("is-paused");
        intro?.classList.remove("is-paused");
      };
      requestAnimationFrame(() => requestAnimationFrame(start));
      setTimeout(start, 250);
    }
    if (intro) dailyContainer.appendChild(intro);
    dailyContainer.appendChild(barSvg);
    animateZoom(barSvg, effective);
    addScrollButtons(dailyContainer, barSvg, effective, totalLen);
    const balanceLine = barSvg.querySelector<SVGPathElement>(".chart-balance");
    if (balanceLine) {
      barSvg.style.setProperty("--length", String(Math.ceil(balanceLine.getTotalLength())));
    }

    console.log("Charts created successfully");
  } catch (error) {
    console.error("Error rendering charts:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
  }
}

/**
 * FLIP-style zoom: start the new plot with an x-transform that reproduces the previous
 * view, then transition to identity. Both views map calendar days linearly to x.
 */
/**
 * SVG shapes can't be composited, so the bars grow in as HTML elements (scaleY on their own
 * layers) underneath the chart, which then switches back to its own SVG bars.
 */
function buildBarIntro(svg: SVGSVGElement): HTMLElement {
  const left = Number(svg.dataset["plotLeft"]);
  const intro = document.createElement("div");
  intro.className = "chart-bar-intro is-paused";
  intro.style.left = `${left}px`;
  intro.style.width = `${svg.dataset["plotWidth"]}px`;
  intro.style.height = `${svg.getAttribute("height")}px`;

  for (const slot of Array.from(svg.querySelectorAll<SVGGElement>(".chart-bar-slot"))) {
    const rect = slot.querySelector("rect");
    if (!rect) continue;
    const attr = (element: Element, name: string) => Number(element.getAttribute(name));
    const y = attr(rect, "y");
    const bar = document.createElement("div");
    bar.className = "chart-bar-intro__bar";
    bar.style.left = `${attr(rect, "x") - left}px`;
    bar.style.top = `${y}px`;
    bar.style.width = `${attr(rect, "width")}px`;
    bar.style.height = `${attr(rect, "height")}px`;
    bar.style.borderRadius = `${attr(rect, "rx")}px`;
    bar.style.animationDelay = slot.style.animationDelay;
    intro.appendChild(bar);
  }

  svg.classList.add("is-bar-intro");
  const finish = () => {
    svg.classList.remove("is-bar-intro");
    intro.remove();
  };
  const lastBar = intro.lastElementChild;
  if (lastBar) lastBar.addEventListener("animationend", finish, { once: true });
  else finish();
  setTimeout(finish, 3000); // in case the animation never runs, e.g. in a hidden window
  return intro;
}

function animateZoom(svg: SVGSVGElement, to: DayRange) {
  const from = animateZoomFrom;
  animateZoomFrom = null;
  renderedRange = to;
  const plot = svg.querySelector<SVGGElement>(".chart-plot");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!from || !plot || reduceMotion) {
    zoomAnimation = null;
    return;
  }
  const left = Number(svg.dataset["plotLeft"]);
  const width = Number(svg.dataset["plotWidth"]);
  const fromCount = from.end - from.start + 1;
  const toCount = to.end - to.start + 1;
  const scale = toCount / fromCount;
  const offset = left - scale * left + ((to.start - from.start) * width) / fromCount;
  if (Math.abs(scale - 1) < 0.001 && Math.abs(offset) < 0.5) return;

  zoomAnimation = { from, to, startedAt: performance.now() };
  plot.style.transform = `matrix(${scale}, 0, 0, 1, ${offset}, 0)`;
  plot.getBoundingClientRect(); // commit the start state before transitioning
  plot.style.transition = `transform ${ZOOM_ANIMATION_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
  plot.style.transform = "";
}

function addScrollButtons(
  container: HTMLElement,
  svg: SVGSVGElement,
  range: DayRange,
  totalLen: number,
) {
  if (!focusRange) return;
  const left = Number(svg.dataset["plotLeft"]);
  const width = Number(svg.dataset["plotWidth"]);
  const visibleCount = range.end - range.start + 1;

  for (const direction of [-1, 1] as const) {
    const canScroll = direction < 0 ? range.start > 0.01 : range.end < totalLen - 1.01;
    if (!canScroll) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chart-scroll-button chart-scroll-button--${direction < 0 ? "left" : "right"}`;
    button.setAttribute("aria-label", direction < 0 ? "Show earlier" : "Show later");
    button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${direction < 0 ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"}"/></svg>`;
    button.style.left = `${direction < 0 ? left + 6 : left + width - 34}px`;
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("dblclick", (e) => e.stopPropagation());
    button.addEventListener("click", () => {
      const step = Math.max(1, Math.round(visibleCount * 0.8));
      const start = Math.min(Math.max(0, range.start + direction * step), totalLen - visibleCount);
      requestAnimatedZoom();
      focusRange = { start, end: start + visibleCount - 1 };
      container.dispatchEvent(new CustomEvent("chart-interaction", { bubbles: true }));
    });
    container.appendChild(button);
  }
}

function aggregateToWeekly(
  filledDailyData: OvertimeData["dailyData"],
  cumulativeData: number[],
): {
  hours: number[];
  cumulative: number[];
  labels: string[];
  dates: string[];
  endDates: string[];
  referenceHours: number[];
  daysWorked: number[];
  starts: number[];
  spans: number[];
} {
  // Group daily data by ISO week (Monday-based)
  const weekKeyToData = new Map<
    string,
    { indices: number[]; startDate: string; endDate: string }
  >();
  const weekOrder: string[] = [];

  filledDailyData.forEach((d, index) => {
    const weekKey = getWeekKey(d.date);
    if (!weekKeyToData.has(weekKey)) {
      weekKeyToData.set(weekKey, {
        indices: [],
        startDate: d.date,
        endDate: d.date,
      });
      weekOrder.push(weekKey);
    }
    const weekData = weekKeyToData.get(weekKey)!;
    weekData.indices.push(index);
    weekData.endDate = d.date; // Update to latest date in week
  });

  // Aggregate hours for each week
  const hours: number[] = [];
  const dates: string[] = [];
  const endDates: string[] = [];
  const cumulative: number[] = [];
  const referenceHours: number[] = [];
  const daysWorked: number[] = [];
  const starts: number[] = [];
  const spans: number[] = [];

  for (const weekKey of weekOrder) {
    const weekData = weekKeyToData.get(weekKey)!;
    const indices = weekData.indices;
    starts.push(indices[0]);
    spans.push(indices.length);

    // Sum actual hours for the week
    const weekHours = indices.reduce((sum, i) => sum + filledDailyData[i].actualHours, 0);
    hours.push(weekHours);

    // Use Monday (first day of week) as the representative date
    dates.push(weekData.startDate);
    endDates.push(weekData.endDate);

    // Same rule as the overtime calculation: 8h for each weekday with tracked time.
    const workedIndices = indices.filter((i) => filledDailyData[i].actualHours > 0);
    referenceHours.push(workedIndices.reduce((sum, i) => sum + dayTarget(filledDailyData[i]), 0));
    daysWorked.push(workedIndices.length);

    // Cumulative is taken from the provided cumulative array (respects mode: daily/weekly)
    // Use the last index of the week to get the cumulative at week's end
    cumulative.push(cumulativeData[indices[indices.length - 1]]);
  }

  // Create labels (show first week only, or month changes)
  const labels = dates.map((date, index) => {
    const current = new Date(date + "T00:00:00");
    let previousMonth = -1;

    if (index > 0) {
      const previous = new Date(dates[index - 1] + "T00:00:00");
      previousMonth = previous.getMonth();
    }

    const currentMonth = current.getMonth();
    const isNewMonth = currentMonth !== previousMonth;
    const isFirstEntry = index === 0;

    if (isFirstEntry || isNewMonth) {
      return current.toLocaleDateString("en-US", {
        month: "short",
      });
    }
    return "";
  });

  return { hours, cumulative, labels, dates, endDates, referenceHours, daysWorked, starts, spans };
}

/** A bar spanning `span` calendar days from day index `start` of the filled data. */
type ChartBar = {
  start: number;
  span: number;
  date: string;
  endDate?: string;
  hours: number;
  cumulative: number;
  label: string;
  detail: BarDetail;
};

function weeklyBars(days: OvertimeData["dailyData"], cumulative: number[]): ChartBar[] {
  const weeks = aggregateToWeekly(days, cumulative);
  return weeks.hours.map((hours, i) => ({
    start: weeks.starts[i],
    span: weeks.spans[i],
    date: weeks.dates[i],
    endDate: weeks.endDates[i],
    hours,
    cumulative: weeks.cumulative[i],
    label: weeks.labels[i],
    detail: { target: weeks.referenceHours[i], daysWorked: weeks.daysWorked[i] },
  }));
}

function dailyBars(
  days: OvertimeData["dailyData"],
  cumulative: number[],
  showDayLabels: boolean,
): ChartBar[] {
  return days.map((day, i) => {
    const current = new Date(day.date + "T00:00:00");
    const isNewMonth =
      i === 0 || current.getMonth() !== new Date(days[i - 1].date + "T00:00:00").getMonth();
    let label = "";
    if (isNewMonth) {
      label = current.toLocaleDateString(
        "en-US",
        showDayLabels ? { month: "short", day: "numeric" } : { month: "short" },
      );
    } else if (showDayLabels && current.getDay() === 1) {
      label = current.toLocaleDateString("en-US", { day: "numeric" });
    }
    return {
      start: i,
      span: 1,
      date: day.date,
      hours: day.actualHours,
      cumulative: cumulative[i],
      label,
      detail: { target: dayTarget(day), isWeekend: isWeekend(day.date) },
    };
  });
}

function buildCumulativeSeries(
  filledDailyData: OvertimeData["dailyData"],
  mode: CumulativeMode,
): number[] {
  if (mode === "daily") {
    return filledDailyData.map((d) => d.cumulativeOvertimeHours);
  }

  // Weekly mode: flat before first worked day and after last worked day of each week,
  // linearly interpolated between them so buildSmoothPath produces a gentle curve.
  const n = filledDailyData.length;
  const result = new Array<number>(n).fill(0);

  // Group array indices by week key, preserving order.
  const weekKeyToIndices = new Map<string, number[]>();
  const weekOrder: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = getWeekKey(filledDailyData[i].date);
    if (!weekKeyToIndices.has(key)) {
      weekKeyToIndices.set(key, []);
      weekOrder.push(key);
    }
    weekKeyToIndices.get(key)!.push(i);
  }

  let prevCumulative = 0;

  for (const key of weekOrder) {
    const indices = weekKeyToIndices.get(key)!;
    const workedIndices = indices.filter((i) => filledDailyData[i].actualHours > 0);

    if (workedIndices.length === 0) {
      // No work this week – hold flat at the previous cumulative.
      for (const i of indices) {
        result[i] = prevCumulative;
      }
      continue;
    }

    const firstWorked = workedIndices[0];
    const lastWorked = workedIndices[workedIndices.length - 1];
    const weekEndCumulative = filledDailyData[lastWorked].cumulativeOvertimeHours;

    for (const i of indices) {
      if (i < firstWorked) {
        // Before the week's first worked day – flat.
        result[i] = prevCumulative;
      } else if (i > lastWorked) {
        // After the week's last worked day – flat at new level.
        result[i] = weekEndCumulative;
      } else {
        // Between first and last worked day – linear interpolation so the
        // smooth path can curve through this range.
        const span = lastWorked - firstWorked;
        const t = span === 0 ? 1 : (i - firstWorked) / span;
        result[i] = prevCumulative + t * (weekEndCumulative - prevCumulative);
      }
    }

    prevCumulative = weekEndCumulative;
  }

  return result;
}

function setupChartInteraction(container: HTMLDivElement): void {
  let isDragging = false;
  let dragStartX = 0;
  let dragStartRange: { start: number; end: number } | null = null;
  let interactionRafId: number | null = null;

  function dispatchRerender() {
    container.dispatchEvent(new CustomEvent("chart-interaction", { bubbles: true }));
  }

  // One gesture either pans or zooms, decided by its first event.
  let gestureAxis: "x" | "y" | null = null;
  let gestureTimer: ReturnType<typeof setTimeout> | undefined;

  /** The plot area on screen; zoom and pan are relative to it, not the padded container. */
  function plotBox(): { left: number; width: number } {
    const svg = container.querySelector<SVGSVGElement>("svg");
    const box = (svg ?? container).getBoundingClientRect();
    const left = Number(svg?.dataset["plotLeft"] ?? 0);
    const width = Number(svg?.dataset["plotWidth"] ?? box.width);
    return { left: box.left + left, width };
  }

  function clampPan(start: number, count: number, len: number): DayRange {
    const clamped = Math.min(Math.max(0, start), len - count);
    return { start: clamped, end: clamped + count - 1 };
  }

  function rerenderNextFrame() {
    if (interactionRafId !== null) return;
    interactionRafId = requestAnimationFrame(() => {
      interactionRafId = null;
      dispatchRerender();
    });
  }

  function zoomRange(range: DayRange, factor: number, relX: number, len: number): DayRange | null {
    const count = range.end - range.start + 1;
    const newCount = Math.max(14, Math.min(len, count * factor));
    if (newCount > len - 0.5) return null; // snap to the full range
    const pivot = range.start + relX * count;
    const start = Math.max(0, Math.min(len - newCount, pivot - relX * newCount));
    return { start, end: start + newCount - 1 };
  }

  let pinchBase: DayRange | null = null;

  // Ctrl/⌘ + wheel zooms, Shift + wheel pans, a horizontal trackpad swipe pans.
  container.addEventListener(
    "wheel",
    (e) => {
      // The fingers of a pinch also produce scroll events; the pinch handles them.
      if (pinchBase) {
        e.preventDefault();
        return;
      }
      const len = lastFilledData.length;
      if (!len) return;

      // A mouse wheel notch moves a small fixed step, however large its delta is.
      const delta = e.deltaX || e.deltaY;
      const isNotch = e.deltaMode !== 0 || (Math.abs(delta) >= 40 && Number.isInteger(delta));

      // Shift + wheel pans (mouse wheels have no horizontal axis).
      if (e.shiftKey) {
        e.preventDefault();
        if (!focusRange) return;
        const count = focusRange.end - focusRange.start + 1;
        const days = isNotch
          ? Math.sign(delta) * count * PAN_STEP
          : (delta * count) / plotBox().width;
        if (isNotch) requestAnimatedZoom();
        focusRange = clampPan(focusRange.start + days, count, len);
        if (isNotch) dispatchRerender();
        else rerenderNextFrame();
        return;
      }

      // Ctrl/⌘ + wheel always zooms.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const plot = plotBox();
        const relX = Math.max(0, Math.min(1, (e.clientX - plot.left) / plot.width));
        const current = focusRange ?? { start: 0, end: len - 1 };
        // Wheel up (away from you) zooms in, as in maps and design tools.
        const factor = isNotch
          ? e.deltaY < 0
            ? ZOOM_STEP
            : 1 / ZOOM_STEP
          : Math.exp(Math.max(-50, Math.min(50, e.deltaY)) * 0.01);
        if (isNotch) requestAnimatedZoom();
        focusRange = zoomRange(current, factor, relX, len);
        if (isNotch) dispatchRerender();
        else rerenderNextFrame();
        return;
      }

      // Without a modifier only a horizontal swipe pans; vertical scrolling is left alone.
      clearTimeout(gestureTimer);
      gestureTimer = setTimeout(() => {
        gestureAxis = null;
      }, 180);
      gestureAxis ??= Math.abs(e.deltaX) > Math.abs(e.deltaY) ? "x" : "y";
      if (gestureAxis !== "x" || !focusRange) return;
      e.preventDefault();
      const count = focusRange.end - focusRange.start + 1;
      focusRange = clampPan(focusRange.start + (e.deltaX * count) / plotBox().width, count, len);
      rerenderNextFrame();
    },
    { passive: false },
  );

  // Trackpad pinch. The app forwards it natively (see ChartWebView.swift), as WebKit's
  // gesture events stop once a re-render replaces the element under the fingers.
  let pinchScale = 1;
  function pinch(phase: "start" | "change" | "end", scale: number, clientX: number) {
    const len = lastFilledData.length;
    if (phase === "end" || !len) {
      pinchBase = null;
      return;
    }
    if (phase === "start") {
      pinchBase = focusRange ?? { start: 0, end: len - 1 };
      pinchScale = 1;
    }
    if (!pinchBase) return;
    pinchScale = scale;
    const plot = plotBox();
    const relX = Math.max(0, Math.min(1, (clientX - plot.left) / plot.width));
    focusRange = zoomRange(pinchBase, 1 / Math.max(pinchScale, 0.01), relX, len);
    rerenderNextFrame();
  }
  (window as Window & { nativePinch?: typeof nativePinch }).nativePinch = nativePinch;
  function nativePinch(
    phase: "start" | "change" | "end",
    magnification: number,
    x: number,
    y: number,
  ) {
    if (phase === "start") {
      const box = container.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
      pinch("start", 1, x);
    } else if (pinchBase) {
      pinch(phase, pinchScale * (1 + magnification), x);
    }
  }
  const pinchEvent = (e: Event) => e as Event & { scale: number; clientX: number };
  container.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    pinch("start", 1, pinchEvent(e).clientX);
  });
  container.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const { scale, clientX } = pinchEvent(e);
    pinch("change", scale, clientX);
  });
  container.addEventListener("gestureend", (e) => {
    e.preventDefault();
    pinch("end", 1, 0);
  });

  // Arrow keys: ←/→ pan, ↑/↓ zoom around the centre; Esc resets the zoom.
  // ⌘+ / ⌘- zoom and ⌘0 resets, like page zoom elsewhere.
  document.addEventListener("keydown", (e) => {
    const command = e.metaKey || e.ctrlKey;
    const zoomShortcut = command && ["+", "=", "-", "0"].includes(e.key);
    if (e.defaultPrevented || e.altKey || (command && !zoomShortcut)) return;
    if (!container.offsetParent || document.querySelector('[aria-expanded="true"]')) return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) {
      return;
    }
    const len = lastFilledData.length;
    if (!len) return;
    const current = focusRange ?? { start: 0, end: len - 1 };
    const count = current.end - current.start + 1;
    let next: DayRange | null;
    switch (zoomShortcut ? `Cmd${e.key}` : e.key) {
      case "Cmd+":
      case "Cmd=":
        next = zoomRange(current, 0.8, 0.5, len);
        break;
      case "Cmd-":
        next = zoomRange(current, 1.25, 0.5, len);
        break;
      case "Cmd0":
        if (!focusRange) return;
        next = null;
        break;
      case "ArrowLeft":
      case "ArrowRight":
        if (!focusRange) return;
        next = clampPan(current.start + (e.key === "ArrowLeft" ? -0.15 : 0.15) * count, count, len);
        break;
      case "ArrowUp":
        next = zoomRange(current, 0.8, 0.5, len);
        break;
      case "ArrowDown":
        next = zoomRange(current, 1.25, 0.5, len);
        break;
      case "Escape":
        if (!focusRange) return;
        next = null;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (!next && !focusRange) return;
    requestAnimatedZoom();
    focusRange = next;
    dispatchRerender();
  });

  // Drag to pan when zoomed in
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !focusRange) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartRange = { ...focusRange };
    container.setPointerCapture(e.pointerId);
    container.style.cursor = "grabbing";
  });

  container.addEventListener("pointermove", (e) => {
    if (!isDragging || !dragStartRange) return;
    const len = lastFilledData.length;
    const visibleCount = dragStartRange.end - dragStartRange.start + 1;
    const deltaDays = (-(e.clientX - dragStartX) * visibleCount) / plotBox().width;
    focusRange = clampPan(dragStartRange.start + deltaDays, visibleCount, len);

    rerenderNextFrame();
  });

  const endDrag = (_e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    dragStartRange = null;
    container.style.cursor = focusRange !== null ? "grab" : "";
  };
  container.addEventListener("pointerup", endDrag);
  container.addEventListener("pointercancel", endDrag);

  // Double-click to reset to full range
  container.addEventListener("dblclick", () => {
    requestAnimatedZoom();
    focusRange = null;
    container.dispatchEvent(new CustomEvent("zoom-reset", { bubbles: true }));
  });
}

function getWeekKey(isoDate: string): string {
  const date = new Date(isoDate + "T00:00:00");
  const day = date.getDay();
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + offsetToMonday);
  return formatIsoDate(date);
}

type YDomain = { maxHours: number; cumulativeMin: number; cumulativeMax: number };

function createBarChart(
  chartBars: ChartBar[],
  firstDay: number,
  dayCount: number,
  width: number,
  height: number,
  isWeeklyView: boolean,
  yDomain: YDomain,
): SVGSVGElement {
  const padding = { top: 20, right: 25, bottom: 22, left: 25 };
  const chartWidth = width - padding.left - padding.right;
  const data = chartBars.map((bar) => bar.hours);
  const cumulativeData = chartBars.map((bar) => bar.cumulative);
  const dayWidth = chartWidth / dayCount;
  const slotX = (index: number) => padding.left + (chartBars[index].start - firstDay) * dayWidth;
  const slotWidth = (index: number) => chartBars[index].span * dayWidth;
  const slotCenter = (index: number) => slotX(index) + slotWidth(index) / 2;
  const chartHeight = height - padding.top - padding.bottom;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.dataset["plotLeft"] = String(padding.left);
  svg.dataset["plotWidth"] = String(chartWidth);

  // Everything that moves when zooming lives in the clipped plot group.
  const plotClip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
  plotClip.setAttribute("id", "chart-plot-clip");
  const plotClipRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  plotClipRect.setAttribute("x", String(padding.left));
  plotClipRect.setAttribute("y", "0");
  plotClipRect.setAttribute("width", String(chartWidth));
  plotClipRect.setAttribute("height", String(height));
  plotClip.appendChild(plotClipRect);
  svg.appendChild(plotClip);
  const clipGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  clipGroup.setAttribute("clip-path", "url(#chart-plot-clip)");
  const plot = document.createElementNS("http://www.w3.org/2000/svg", "g");
  plot.setAttribute("class", "chart-plot");
  clipGroup.appendChild(plot);
  svg.appendChild(clipGroup);

  const rawMax = Math.max(yDomain.maxHours, 1);
  // Coarser ticks on narrow widths or short heights
  const maxLeftTicks = width < 640 ? 5 : height < 250 ? 5 : 8;
  // Step must be a divisor of 8 so both 0 and the reference line value fit cleanly.
  const leftStep = ([2, 4, 8] as const).find((s) => Math.ceil(rawMax / s) <= maxLeftTicks) ?? 8;
  const leftMax = Math.ceil(rawMax / leftStep) * leftStep;

  // Compute a nice integer axis range for the right (cumulative) axis.
  const rawCumMin = yDomain.cumulativeMin;
  const rawCumMax = yDomain.cumulativeMax;
  const rawCumRange = rawCumMax - rawCumMin || 1;
  const maxRightTicks = width < 640 ? 5 : height < 250 ? 5 : 8;
  const rightStep =
    ([1, 2, 5, 10, 20, 50, 100] as const).find((s) => rawCumRange / s <= maxRightTicks) ?? 100;
  const cumulativeMin = Math.floor(rawCumMin / rightStep) * rightStep;
  const cumulativeMax = Math.ceil(rawCumMax / rightStep) * rightStep;
  const cumulativeRange = cumulativeMax - cumulativeMin || 1;

  // Left Y-axis integer labels — includes 0 and enough range for the reference line.
  for (let v = 0; v <= leftMax; v += leftStep) {
    const y = padding.top + chartHeight - (v / leftMax) * chartHeight;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(padding.left - 10));
    text.setAttribute("y", String(y + 5));
    text.setAttribute("text-anchor", "end");
    text.setAttribute("class", "chart-axis-label");
    text.textContent = String(v);
    svg.appendChild(text);
  }

  // Bars
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const minLabelSpacing = width < 640 ? 56 : 44;

  hideChartTooltip();
  const bars: SVGRectElement[] = [];
  const barGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  barGroup.setAttribute("class", "chart-bars");
  plot.appendChild(barGroup);
  // Week targets sit above the bars and fade in once the bars have grown in.
  const targetGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  targetGroup.setAttribute("class", "chart-targets");
  plot.appendChild(targetGroup);

  data.forEach((value, index) => {
    const barHeight = (value / leftMax) * chartHeight;
    const x = slotX(index) + slotWidth(index) * 0.1;
    const y = padding.top + chartHeight - barHeight;
    const actualBarWidth = slotWidth(index) * 0.8;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(actualBarWidth));
    rect.setAttribute("height", String(barHeight));
    rect.setAttribute("class", "chart-bar");
    rect.setAttribute("rx", String(Math.min(4, actualBarWidth / 3)));
    rect.setAttribute("data-date", chartBars[index].date);
    rect.setAttribute("data-hours", String(value));
    bars.push(rect);
    // Bars grow in staggered from left to right.
    const slot = document.createElementNS("http://www.w3.org/2000/svg", "g");
    slot.setAttribute("class", "chart-bar-slot");
    slot.style.animationDelay = `${60 + Math.round((index / data.length) * 550)}ms`;
    slot.appendChild(rect);
    barGroup.appendChild(slot);

    if (isWeeklyView) {
      const referenceHours = chartBars[index].detail.target;
      if (referenceHours > 0) {
        const yReference = padding.top + chartHeight - (referenceHours / leftMax) * chartHeight;
        const referenceLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
        referenceLine.setAttribute("x1", String(x));
        referenceLine.setAttribute("y1", String(yReference));
        referenceLine.setAttribute("x2", String(x + actualBarWidth));
        referenceLine.setAttribute("y2", String(yReference));
        referenceLine.setAttribute("class", "chart-target");
        // Fades in while its bar is halfway through growing in.
        referenceLine.style.animationDelay = `${460 + Math.round((index / data.length) * 550)}ms`;
        targetGroup.appendChild(referenceLine);
      }
    }

    // X-axis labels
    const labelX = x + actualBarWidth / 2;
    const label = chartBars[index].label;
    const labelInView = labelX >= padding.left && labelX <= padding.left + chartWidth;
    if (label && labelInView && labelX - lastLabelX >= minLabelSpacing) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(labelX));
      text.setAttribute("y", String(padding.top + chartHeight + 16));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("class", "chart-axis-label");
      text.textContent = label;
      svg.appendChild(text);
      lastLabelX = labelX;
    }
  });

  // Daily view keeps a fixed 8h full-width reference line.
  if (!isWeeklyView) {
    const yReference = padding.top + chartHeight - (8 / leftMax) * chartHeight;
    const referenceLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    referenceLine.setAttribute("x1", String(padding.left));
    referenceLine.setAttribute("y1", String(yReference));
    referenceLine.setAttribute("x2", String(padding.left + chartWidth));
    referenceLine.setAttribute("y2", String(yReference));
    referenceLine.setAttribute("class", "chart-target");
    plot.appendChild(referenceLine);
  }

  // Draw cumulative overtime line (right Y axis scale)
  if (cumulativeData.length > 0) {
    const points: Array<{ x: number; y: number }> = [];

    cumulativeData.forEach((value, index) => {
      const x = slotCenter(index);
      const normalized = (value - cumulativeMin) / cumulativeRange;
      const y = padding.top + chartHeight - normalized * chartHeight;
      points.push({ x, y });
    });
    // Run the line across the full width of the outer bars, e.g. to the end of the last week.
    points.unshift({ x: slotX(0), y: points[0].y });
    const lastIndex = chartBars.length - 1;
    points.push({ x: slotX(lastIndex) + slotWidth(lastIndex), y: points[points.length - 1].y });

    const zeroNormalized = (0 - cumulativeMin) / cumulativeRange;
    const yZero = padding.top + chartHeight - zeroNormalized * chartHeight;
    const zeroLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    zeroLine.setAttribute("x1", String(padding.left));
    zeroLine.setAttribute("y1", String(yZero));
    zeroLine.setAttribute("x2", String(padding.left + chartWidth));
    zeroLine.setAttribute("y2", String(yZero));
    zeroLine.setAttribute("class", "chart-zero");
    plot.appendChild(zeroLine);

    // Shade the area between the balance and zero: green above, red below.
    const linePath = buildSmoothPath(points);
    const areaPath = `${linePath} L ${points[points.length - 1].x} ${yZero} L ${points[0].x} ${yZero} Z`;
    const clipTop = padding.top - 10;
    const clipBottom = padding.top + chartHeight + 10;
    for (const [sign, y, h] of [
      ["positive", clipTop, yZero - clipTop],
      ["negative", yZero, clipBottom - yZero],
    ] as const) {
      const clipId = `balance-clip-${sign}`;
      const clipPath = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
      clipPath.setAttribute("id", clipId);
      const clipRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      clipRect.setAttribute("x", "0");
      clipRect.setAttribute("y", String(y));
      clipRect.setAttribute("width", String(width));
      clipRect.setAttribute("height", String(Math.max(0, h)));
      clipPath.appendChild(clipRect);
      plot.appendChild(clipPath);

      const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
      area.setAttribute("d", areaPath);
      area.setAttribute("class", `chart-area--${sign}`);
      area.setAttribute("clip-path", `url(#${clipId})`);
      plot.appendChild(area);
    }

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", linePath);
    line.setAttribute("class", "chart-balance");
    plot.appendChild(line);

    // Right Y-axis integer labels — always includes 0.
    for (let v = cumulativeMin; v <= cumulativeMax; v += rightStep) {
      const y = padding.top + chartHeight - ((v - cumulativeMin) / cumulativeRange) * chartHeight;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String(padding.left + chartWidth + 10));
      text.setAttribute("y", String(y + 5));
      text.setAttribute("text-anchor", "start");
      text.setAttribute("class", "chart-axis-label chart-axis-label--balance");
      text.textContent = String(Math.round(v));
      svg.appendChild(text);
    }
  }

  // Axes
  const yAxis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  yAxis.setAttribute("x1", String(padding.left));
  yAxis.setAttribute("y1", String(padding.top));
  yAxis.setAttribute("x2", String(padding.left));
  yAxis.setAttribute("y2", String(padding.top + chartHeight));
  yAxis.setAttribute("class", "chart-axis");
  svg.appendChild(yAxis);

  const rightAxis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  rightAxis.setAttribute("x1", String(padding.left + chartWidth));
  rightAxis.setAttribute("y1", String(padding.top));
  rightAxis.setAttribute("x2", String(padding.left + chartWidth));
  rightAxis.setAttribute("y2", String(padding.top + chartHeight));
  rightAxis.setAttribute("class", "chart-axis");
  svg.appendChild(rightAxis);

  // One tooltip that follows the cursor; hovering anywhere in a bar's column selects it.

  // Thin scroll indicator along the x-axis while zoomed in.
  if (focusRange && lastFilledData.length > 0) {
    const total = lastFilledData.length;
    const trackY = padding.top + chartHeight + 1;
    const track = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    track.setAttribute("class", "chart-scrollbar-track");
    track.setAttribute("x", String(padding.left));
    track.setAttribute("y", String(trackY));
    track.setAttribute("width", String(chartWidth));
    track.setAttribute("height", "3");
    track.setAttribute("rx", "1.5");
    svg.appendChild(track);
    const thumb = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    thumb.setAttribute("class", "chart-scrollbar-thumb");
    thumb.setAttribute("x", String(padding.left + (focusRange.start / total) * chartWidth));
    thumb.setAttribute("y", String(trackY));
    thumb.setAttribute(
      "width",
      String(Math.max(12, ((focusRange.end - focusRange.start + 1) / total) * chartWidth)),
    );
    thumb.setAttribute("height", "3");
    thumb.setAttribute("rx", "1.5");
    svg.appendChild(thumb);
  }

  let hoveredIndex: number | null = null;
  const clearHover = () => {
    if (hoveredIndex !== null) bars[hoveredIndex]?.classList.remove("is-hovered");
    hoveredIndex = null;
    hideChartTooltip();
  };

  svg.addEventListener("pointermove", (event) => {
    if (event.buttons !== 0) {
      clearHover(); // dragging pans the chart
      return;
    }
    const box = svg.getBoundingClientRect();
    const day = firstDay + (event.clientX - box.left - padding.left) / dayWidth;
    const inPlot = day >= firstDay && day < firstDay + dayCount;
    const index = chartBars.findIndex((bar) => day >= bar.start && day < bar.start + bar.span);
    if (!inPlot || index < 0) {
      clearHover();
      return;
    }
    if (index !== hoveredIndex) {
      if (hoveredIndex !== null) bars[hoveredIndex]?.classList.remove("is-hovered");
      bars[index].classList.add("is-hovered");
      hoveredIndex = index;

      const balance = cumulativeData[index];
      showChartTooltip({
        date: chartBars[index].date,
        endDate: chartBars[index].endDate,
        hours: data[index],
        balance,
        detail: chartBars[index].detail,
      });
    }
    moveChartTooltip(event.clientX, event.clientY);
  });
  svg.addEventListener("pointerleave", clearHover);
  svg.addEventListener("pointerdown", clearHover);

  return svg;
}

/** Monotone cubic curve through every point; it never overshoots the data. */
function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  const n = points.length;
  const slope = (i: number) => {
    const h = points[i + 1].x - points[i].x;
    return h === 0 ? 0 : (points[i + 1].y - points[i].y) / h;
  };
  const tangents = points.map((_, i) => {
    if (n === 1) return 0;
    if (i === 0) return slope(0);
    if (i === n - 1) return slope(n - 2);
    const h0 = points[i].x - points[i - 1].x;
    const h1 = points[i + 1].x - points[i].x;
    const s0 = slope(i - 1);
    const s1 = slope(i);
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    return (
      (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p))
    );
  });

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const third = (to.x - from.x) / 3;
    path += ` C ${from.x + third} ${from.y + tangents[i] * third} ${to.x - third} ${to.y - tangents[i + 1] * third} ${to.x} ${to.y}`;
  }
  return path;
}

function padToWeekEnd(days: OvertimeData["dailyData"]): OvertimeData["dailyData"] {
  const last = days[days.length - 1];
  if (!last) return days;
  const result = [...days];
  const cursor = new Date(last.date + "T00:00:00");
  while (cursor.getDay() !== 0) {
    cursor.setDate(cursor.getDate() + 1);
    result.push({
      date: formatIsoDate(cursor),
      actualHours: 0,
      expectedHours: 0,
      cumulativeOvertimeHours: last.cumulativeOvertimeHours,
    });
  }
  return result;
}

function fillMissingDays(dailyData: OvertimeData["dailyData"]): OvertimeData["dailyData"] {
  if (dailyData.length === 0) {
    return [];
  }

  const sorted = [...dailyData].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(sorted.map((entry) => [entry.date, entry]));

  const firstEntry = sorted[0];
  const lastEntry = sorted[sorted.length - 1];

  // Start from the first actual data entry, not from Jan 1
  // This respects custom start dates
  const start = new Date(firstEntry.date + "T00:00:00");
  const end = new Date(lastEntry.date + "T00:00:00");

  const result: OvertimeData["dailyData"] = [];
  let lastCumulativeOvertime = 0;

  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const isoDate = formatIsoDate(cursor);
    const existing = byDate.get(isoDate);

    if (existing) {
      lastCumulativeOvertime = existing.cumulativeOvertimeHours;
      result.push(existing);
      continue;
    }

    result.push({
      date: isoDate,
      actualHours: 0,
      expectedHours: cursor.getDay() === 0 || cursor.getDay() === 6 ? 0 : 8,
      cumulativeOvertimeHours: lastCumulativeOvertime,
    });
  }

  return result;
}

type BarDetail = { target: number; isWeekend?: boolean; daysWorked?: number };

let tooltipElement: HTMLDivElement | null = null;

function showChartTooltip({
  date: dateStr,
  endDate,
  hours,
  balance,
  detail,
}: {
  date: string;
  endDate?: string;
  hours: number;
  balance?: number;
  detail?: BarDetail;
}) {
  if (!tooltipElement) {
    tooltipElement = document.createElement("div");
    tooltipElement.className = "chart-tooltip";
    document.body.appendChild(tooltipElement);
  }
  const tooltip = tooltipElement;
  tooltip.replaceChildren();

  let displayDate = "";
  if (endDate) {
    const fmt = (iso: string) =>
      new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    displayDate = `${fmt(dateStr)} – ${fmt(endDate)}`;
  } else if (dateStr) {
    displayDate = new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }

  const dateLine = document.createElement("div");
  dateLine.className = "chart-tooltip-date";
  dateLine.textContent = displayDate;
  const valueLine = document.createElement("div");
  valueLine.className = "chart-tooltip-value";
  valueLine.textContent =
    hours > 0 ? `${formatHoursToHoursAndMinutes(hours)} worked` : "No time tracked";
  tooltip.append(dateLine, valueLine);

  if (detail && hours > 0) {
    const meta: string[] = [];
    if (detail.target > 0) {
      meta.push(`Target ${formatHoursToHoursAndMinutes(detail.target)}`);
    } else if (detail.isWeekend) {
      meta.push("Weekend, no target");
    }
    if (detail.daysWorked !== undefined) {
      meta.push(`${detail.daysWorked} ${detail.daysWorked === 1 ? "day" : "days"} worked`);
    }

    const metaLine = document.createElement("div");
    metaLine.className = "chart-tooltip-meta";
    metaLine.textContent = meta.join(" · ");

    const diff = hours - detail.target;
    const diffMinutes = Math.round(diff * 60);
    const diffBadge = document.createElement("span");
    diffBadge.className = `chart-tooltip-diff ${diffMinutes > 0 ? "is-positive" : diffMinutes < 0 ? "is-negative" : ""}`;
    diffBadge.textContent =
      diffMinutes === 0
        ? "±0"
        : `${diffMinutes > 0 ? "+" : "−"}${formatHoursToHoursAndMinutes(diff)}`;
    valueLine.append(diffBadge);
    if (meta.length > 0) tooltip.append(metaLine);
  } else if (hours === 0) {
    const metaLine = document.createElement("div");
    metaLine.className = "chart-tooltip-meta";
    metaLine.textContent = "Doesn't count towards the target";
    tooltip.append(metaLine);
  }

  if (balance !== undefined) {
    const balanceMinutes = Math.round(balance * 60);
    const balanceLine = document.createElement("div");
    balanceLine.className = "chart-tooltip-balance";
    const label = document.createElement("span");
    label.textContent = endDate ? "Balance at week end" : "Balance";
    const value = document.createElement("span");
    value.className = balanceMinutes > 0 ? "is-positive" : balanceMinutes < 0 ? "is-negative" : "";
    value.textContent = `${balanceMinutes < 0 ? "−" : "+"}${formatHoursToHoursAndMinutes(balance)}`;
    balanceLine.append(label, value);
    tooltip.append(balanceLine);
  }

  tooltip.classList.add("is-visible");
}

function moveChartTooltip(clientX: number, clientY: number) {
  if (!tooltipElement) return;
  const offset = 14;
  const { width, height } = tooltipElement.getBoundingClientRect();
  let left = clientX + offset;
  if (left + width > window.innerWidth - 8) left = clientX - offset - width;
  const top = Math.min(Math.max(8, clientY - height - offset), window.innerHeight - height - 8);
  tooltipElement.style.left = `${Math.max(8, left)}px`;
  tooltipElement.style.top = `${top}px`;
}

function hideChartTooltip() {
  tooltipElement?.classList.remove("is-visible");
}
