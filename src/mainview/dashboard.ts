import type { Electroview } from "electrobun/view";
import type { OvertimeData } from "../bun/report.ts";
import type { AppRPC } from "../shared/rpc.ts";

type CumulativeMode = "daily" | "weekly";
type ElectrobunClient = Electroview<AppRPC>;

// Zoom/pan state — indices into lastFilledData. null = full range.
let focusRange: { start: number; end: number } | null = null;
// Cached full dataset so interaction handlers can compute zoomed slices.
let lastFilledData: OvertimeData["dailyData"] = [];

export function initializeDashboard(
  electrobun: ElectrobunClient,
  onNavigateToSettings: () => void,
) {
  const startDateInput = document.querySelector<HTMLInputElement>(
    "#dashboard-start-date",
  );
  const endDateInput = document.querySelector<HTMLInputElement>(
    "#dashboard-end-date",
  );
  const lastFetchedEl = document.querySelector<HTMLDivElement>("#last-fetched");
  const fetchSpinner = document.querySelector<HTMLElement>("#fetch-spinner");
  const content = document.querySelector<HTMLDivElement>("#content");
  const overtimeValue =
    document.querySelector<HTMLDivElement>("#overtime-value");
  let lastData: OvertimeData | null = null;
  let resizeRafId: number | null = null;

  if (!startDateInput || !endDateInput) {
    throw new Error("Dashboard date elements are missing");
  }

  // Initialize dates: start date from localStorage, end date defaults to end of start year
  const today = new Date();

  const savedStartDate = localStorage.getItem("clockify_viewed_start_date");
  const startDateToUse = savedStartDate || `${today.getFullYear()}-01-01`;
  startDateInput.value = startDateToUse;
  endDateInput.value = computeDefaultEndDate();

  function computeDefaultEndDate(): string {
    return today.toISOString().split("T")[0];
  }

  // Polling state — declared before runAnalysis so the closure can reference them
  const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
  const MIN_REFETCH_ON_VISIBILITY_MS = 60 * 1000;
  let lastFetchTime = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function getStoredApiKey(): Promise<string> {
    const state = await electrobun.rpc.request.getStoredApiKey({});
    return (state?.apiKey ?? "").trim();
  }

  async function runAnalysis() {
    const apiKey = await getStoredApiKey();
    if (!apiKey) {
      onNavigateToSettings();
      return;
    }

    const startDate = startDateInput!.value;
    const endDate = endDateInput!.value;

    if (!startDate || !endDate) {
      return;
    }

    setLoading(true);
    lastFetchTime = Date.now();

    try {
      console.log("🔍 Analyzing overtime from:", startDate, "to:", endDate);
      const data = await electrobun.rpc.request.analyzeOvertime({
        apiKey,
        startDate,
        endDate,
      });
      lastData = data;
      console.log("📊 Analysis complete:", {
        totalHours: data.totalOvertimeHours,
        totalMinutes: data.totalOvertimeMinutes,
        dayCount: data.dailyData.length,
      });
      renderDashboard(data, overtimeValue, content);
      setLoading(false);
      if (lastFetchedEl) {
        lastFetchedEl.textContent = `Last fetched: ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
        lastFetchedEl.appendChild(fetchSpinner!);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setLoading(false);
      if (lastFetchedEl) lastFetchedEl.textContent = `Error: ${message}`;
    }
  }

  // Handle start date changes
  startDateInput.addEventListener("change", () => {
    localStorage.setItem("clockify_viewed_start_date", startDateInput.value);
    // Only reset end date if it's before the new start date
    if (!endDateInput.value || endDateInput.value < startDateInput.value) {
      endDateInput.value = computeDefaultEndDate();
    }
    focusRange = null; // Reset zoom when changing date range
    runAnalysis();
  });

  // Handle end date changes
  endDateInput.addEventListener("change", () => {
    focusRange = null; // Reset zoom when changing date range
    runAnalysis();
  });

  // Auto-fetch on initial load
  runAnalysis();

  async function fetchIfApiKeyPresent() {
    const apiKey = await getStoredApiKey();
    if (!apiKey) return;
    await runAnalysis();
  }

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
    focusRange = null;
    if (lastData) renderDashboard(lastData, overtimeValue, content);
  });

  return { runAnalysis };
}

function renderDashboard(
  data: OvertimeData,
  overtimeValue: HTMLDivElement | null,
  content: HTMLDivElement | null,
) {
  if (!overtimeValue || !content) return;

  updateOvertimeDisplay(data, overtimeValue);

  // Show content
  content.style.display = "block";

  // Render charts
  renderCharts(data);
}

function updateOvertimeDisplay(
  data: OvertimeData,
  overtimeValue: HTMLDivElement | null,
) {
  if (!overtimeValue) return;

  const totalMinutes = data.totalOvertimeHours * 60 + data.totalOvertimeMinutes;
  const sign = totalMinutes >= 0 ? "+" : "-";
  const absHours = Math.floor(Math.abs(totalMinutes) / 60);
  const absMinutes = Math.abs(totalMinutes) % 60;
  const displayText = `${sign}${absHours}h ${absMinutes}min`;
  overtimeValue.textContent = displayText;
  if (totalMinutes < 0) {
    overtimeValue.style.color = "#b42318";
  } else {
    overtimeValue.style.color = "#0e7c66";
  }
}

function renderCharts(data: OvertimeData) {
  try {
    console.log("Rendering charts with data:", {
      totalOvertimeHours: data.totalOvertimeHours,
      dailyDataLength: data.dailyData.length,
    });

    const dailyContainer =
      document.querySelector<HTMLDivElement>("#daily-chart");

    if (!dailyContainer) {
      console.error("Daily chart container not found");
      return;
    }

    // Clear container
    dailyContainer.innerHTML = "";

    // Fill missing calendar days with zero-hour entries.
    const filledDailyData = fillMissingDays(data.dailyData);
    lastFilledData = filledDailyData;

    // Apply focus range (zoom/pan). Full year when null.
    const totalLen = filledDailyData.length;
    const effective = focusRange
      ? {
          start: Math.max(0, focusRange.start),
          end: Math.min(totalLen - 1, focusRange.end),
        }
      : { start: 0, end: totalLen - 1 };
    const visibleData = filledDailyData.slice(
      effective.start,
      effective.end + 1,
    );

    // Prepare data from visible slice
    const dailyDates = visibleData.map((d) => d.date);
    const actualHours = visibleData.map((d) => d.actualHours);

    // Create display labels — density adapts to how many days are visible.
    // ≤60 days visible: show "Mar 5"-style labels on every week start + month changes.
    // >60 days visible: only show month names on month changes (original behaviour).
    const visibleCount = visibleData.length;
    const showDayLabels = visibleCount <= 60;

    const displayLabels = dailyDates.map((date, index) => {
      const current = new Date(date + "T00:00:00");
      const isFirstEntry = index === 0;
      let previousMonth = -1;
      if (index > 0) {
        previousMonth = new Date(
          dailyDates[index - 1] + "T00:00:00",
        ).getMonth();
      }
      const isNewMonth = current.getMonth() !== previousMonth;

      if (showDayLabels) {
        // Show a label on Mondays (start of week) and on month changes.
        const isMonday = current.getDay() === 1;
        if (isFirstEntry || isNewMonth || isMonday) {
          if (isNewMonth || isFirstEntry) {
            return current.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            });
          }
          return current.toLocaleDateString("en-US", { day: "numeric" });
        }
        return "";
      }

      // Default: month name only on month changes
      if (isFirstEntry || isNewMonth) {
        return current.toLocaleDateString("en-US", { month: "short" });
      }
      return "";
    });

    // Render bar chart
    const chartWidth = Math.max(
      360,
      Math.floor(dailyContainer.clientWidth || 800),
    );

    // Get available height from the charts-container flex space
    const chartsContainer =
      document.querySelector<HTMLDivElement>(".charts-container");
    let chartHeight = 300; // default
    if (chartsContainer) {
      // Account for chart title (h2) and margins
      const h2 = dailyContainer.parentElement?.querySelector("h2");
      const h2Height = h2 ? h2.offsetHeight + 8 : 0;
      const availableHeight = Math.max(
        200,
        chartsContainer.clientHeight - h2Height - 16,
      );
      chartHeight = Math.min(400, availableHeight);
    }

    // Determine density mode based on visible bar count
    const shouldUseWeekly = chartWidth / visibleData.length < 8;

    // Build cumulative on full data for correct running totals, then slice
    const cumulativeMode: CumulativeMode = shouldUseWeekly ? "weekly" : "daily";
    const cumulativeHours = buildCumulativeSeries(
      filledDailyData,
      cumulativeMode,
    ).slice(effective.start, effective.end + 1);

    let dataToUse = actualHours;
    let cumulativeToUse = cumulativeHours;
    let labelsToUse = displayLabels;
    let datesToUse = dailyDates;
    let weeklyReferenceHoursToUse: number[] | undefined;
    let weeklyEndDatesToUse: string[] | undefined;

    if (shouldUseWeekly) {
      const weeklyData = aggregateToWeekly(visibleData, cumulativeHours);
      dataToUse = weeklyData.hours;
      cumulativeToUse = weeklyData.cumulative;
      labelsToUse = weeklyData.labels;
      datesToUse = weeklyData.dates;
      weeklyReferenceHoursToUse = weeklyData.referenceHours;
      weeklyEndDatesToUse = weeklyData.endDates;
    }

    // Update chart title; show date range + reset button when zoomed
    const h2Title = dailyContainer.parentElement?.querySelector("h2");
    if (h2Title) {
      const titleText = shouldUseWeekly
        ? "Weekly Working Hours"
        : "Daily Working Hours";
      h2Title.innerHTML = "";
      const textSpan = document.createElement("span");
      textSpan.textContent = titleText;
      h2Title.appendChild(textSpan);

      if (focusRange !== null) {
        const startDate = new Date(visibleData[0].date);
        const endDate = new Date(visibleData[visibleData.length - 1].date);
        const fmt = (d: Date) =>
          d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const rangeSpan = document.createElement("span");
        rangeSpan.className = "chart-range-label";
        rangeSpan.textContent = ` · ${fmt(startDate)}–${fmt(endDate)}`;
        h2Title.appendChild(rangeSpan);

        const resetBtn = document.createElement("button");
        resetBtn.className = "zoom-reset-btn";
        resetBtn.textContent = "×";
        resetBtn.title = "Reset zoom";
        resetBtn.addEventListener("click", () => {
          dailyContainer!.dispatchEvent(
            new CustomEvent("zoom-reset", { bubbles: true }),
          );
        });
        h2Title.appendChild(resetBtn);
      }
    }

    // Show grab cursor when zoomed (draggable)
    dailyContainer.style.cursor = focusRange !== null ? "grab" : "";

    const barSvg = createBarChart(
      dataToUse,
      cumulativeToUse,
      labelsToUse,
      datesToUse,
      "rgba(132, 150, 163, 0.45)",
      chartWidth,
      chartHeight,
      shouldUseWeekly,
      weeklyReferenceHoursToUse,
      weeklyEndDatesToUse,
    );
    dailyContainer.appendChild(barSvg);

    console.log("Charts created successfully");
  } catch (error) {
    console.error("Error rendering charts:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
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

  for (const weekKey of weekOrder) {
    const weekData = weekKeyToData.get(weekKey)!;
    const indices = weekData.indices;

    // Sum actual hours for the week
    const weekHours = indices.reduce(
      (sum, i) => sum + filledDailyData[i].actualHours,
      0,
    );
    hours.push(weekHours);

    // Use Monday (first day of week) as the representative date
    dates.push(weekData.startDate);
    endDates.push(weekData.endDate);

    // Weekly reference: 8h for each day with recorded work in this week.
    const workedDays = indices.filter(
      (i) => filledDailyData[i].actualHours > 0,
    ).length;
    referenceHours.push(workedDays * 8);

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

  return { hours, cumulative, labels, dates, endDates, referenceHours };
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
    const workedIndices = indices.filter(
      (i) => filledDailyData[i].actualHours > 0,
    );

    if (workedIndices.length === 0) {
      // No work this week – hold flat at the previous cumulative.
      for (const i of indices) {
        result[i] = prevCumulative;
      }
      continue;
    }

    const firstWorked = workedIndices[0];
    const lastWorked = workedIndices[workedIndices.length - 1];
    const weekEndCumulative =
      filledDailyData[lastWorked].cumulativeOvertimeHours;

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
  // Accumulated fractional zoom, normalised against macOS high-resolution trackpad
  let zoomAccumulator = 0;

  function dispatchRerender() {
    container.dispatchEvent(
      new CustomEvent("chart-interaction", { bubbles: true }),
    );
  }

  // Scroll to zoom in/out, centered on the mouse position
  container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const len = lastFilledData.length;
      if (!len) return;

      const current = focusRange ?? { start: 0, end: len - 1 };
      const visibleCount = current.end - current.start + 1;

      const rect = container.getBoundingClientRect();
      const relX = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width),
      );

      // macOS trackpad sends many small deltaY events; normalise to avoid
      // over-sensitivity. Clamp per-event contribution to ±30 units.
      const rawDelta =
        e.deltaMode === 0 // DOM_DELTA_PIXEL (trackpad)
          ? Math.max(-30, Math.min(30, e.deltaY))
          : e.deltaY * 20; // DOM_DELTA_LINE (mouse wheel)

      zoomAccumulator += rawDelta;

      // Only commit a zoom step every 60 accumulated units
      const STEP_THRESHOLD = 60;
      if (Math.abs(zoomAccumulator) < STEP_THRESHOLD) return;

      const steps = Math.trunc(zoomAccumulator / STEP_THRESHOLD);
      zoomAccumulator -= steps * STEP_THRESHOLD;

      // Each step shrinks/grows the visible range by ~20%
      const factor = steps > 0 ? Math.pow(0.8, steps) : Math.pow(1.25, -steps);
      const newCount = Math.round(
        Math.max(14, Math.min(len, visibleCount * factor)),
      );

      if (newCount >= len) {
        focusRange = null;
      } else {
        const pivot = current.start + relX * visibleCount;
        let newStart = Math.round(pivot - relX * newCount);
        let newEnd = newStart + newCount - 1;
        if (newStart < 0) {
          newEnd -= newStart;
          newStart = 0;
        }
        if (newEnd >= len) {
          newStart -= newEnd - len + 1;
          newEnd = len - 1;
        }
        newStart = Math.max(0, newStart);
        focusRange = { start: newStart, end: newEnd };
      }
      dispatchRerender();
    },
    { passive: false },
  );

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
    const rect = container.getBoundingClientRect();
    const visibleCount = dragStartRange.end - dragStartRange.start + 1;
    const pixelsPerBar = rect.width / visibleCount;
    const deltaBars = Math.round(-(e.clientX - dragStartX) / pixelsPerBar);

    let newStart = dragStartRange.start + deltaBars;
    let newEnd = dragStartRange.end + deltaBars;
    if (newStart < 0) {
      newEnd -= newStart;
      newStart = 0;
    }
    if (newEnd >= len) {
      newStart -= newEnd - len + 1;
      newEnd = len - 1;
    }
    newStart = Math.max(0, newStart);
    focusRange = { start: newStart, end: newStart + visibleCount - 1 };

    if (interactionRafId !== null) cancelAnimationFrame(interactionRafId);
    interactionRafId = requestAnimationFrame(() => {
      interactionRafId = null;
      dispatchRerender();
    });
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

function createBarChart(
  data: number[],
  cumulativeData: number[],
  labels: string[],
  dates: string[],
  color: string,
  width: number,
  height: number,
  isWeeklyView: boolean,
  weeklyReferenceHours?: number[],
  weeklyEndDates?: string[],
): SVGSVGElement {
  const padding = { top: 20, right: 25, bottom: 15, left: 25 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const maxReferenceHours = isWeeklyView
    ? Math.max(...(weeklyReferenceHours ?? [0]), 0)
    : 8;
  const rawMax = Math.max(...data, maxReferenceHours, 1);
  // Coarser ticks on narrow widths or short heights
  const maxLeftTicks = width < 640 ? 5 : height < 250 ? 5 : 8;
  // Step must be a divisor of 8 so both 0 and the reference line value fit cleanly.
  const leftStep =
    ([2, 4, 8] as const).find((s) => Math.ceil(rawMax / s) <= maxLeftTicks) ??
    8;
  const leftMax = Math.ceil(rawMax / leftStep) * leftStep;
  const barWidth = chartWidth / data.length;

  // Compute a nice integer axis range for the right (cumulative) axis.
  const rawCumMin = Math.min(...cumulativeData, 0);
  const rawCumMax = Math.max(...cumulativeData, 0);
  const rawCumRange = rawCumMax - rawCumMin || 1;
  const maxRightTicks = width < 640 ? 5 : height < 250 ? 5 : 8;
  const rightStep =
    ([1, 2, 5, 10, 20, 50, 100] as const).find(
      (s) => rawCumRange / s <= maxRightTicks,
    ) ?? 100;
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
    text.setAttribute("font-size", "12");
    text.setAttribute("fill", "#666");
    text.textContent = String(v);
    svg.appendChild(text);
  }

  // Bars
  let lastLabelX = Number.NEGATIVE_INFINITY;
  const minLabelSpacing = width < 640 ? 56 : 44;

  data.forEach((value, index) => {
    const barHeight = (value / leftMax) * chartHeight;
    const x = padding.left + index * barWidth + barWidth * 0.1;
    const y = padding.top + chartHeight - barHeight;
    const actualBarWidth = barWidth * 0.8;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(actualBarWidth));
    rect.setAttribute("height", String(barHeight));
    rect.setAttribute("fill", color);
    rect.setAttribute("rx", "4");
    rect.style.cursor = "pointer";
    rect.setAttribute("data-date", dates[index] || "");
    rect.setAttribute("data-hours", String(value));
    rect.addEventListener("mouseenter", (e) =>
      showChartTooltip(
        e,
        dates[index] || "",
        value,
        isWeeklyView ? weeklyEndDates?.[index] : undefined,
      ),
    );
    rect.addEventListener("mouseleave", hideChartTooltip);
    svg.appendChild(rect);

    if (isWeeklyView) {
      const referenceHours = weeklyReferenceHours?.[index] ?? 0;
      if (referenceHours > 0) {
        const yReference =
          padding.top + chartHeight - (referenceHours / leftMax) * chartHeight;
        const referenceLine = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "line",
        );
        referenceLine.setAttribute("x1", String(x));
        referenceLine.setAttribute("y1", String(yReference));
        referenceLine.setAttribute("x2", String(x + actualBarWidth));
        referenceLine.setAttribute("y2", String(yReference));
        referenceLine.setAttribute("stroke", "#666");
        referenceLine.setAttribute("stroke-width", "1.5");
        referenceLine.setAttribute("stroke-dasharray", "4 4");
        referenceLine.setAttribute("opacity", "0.75");
        svg.appendChild(referenceLine);
      }
    }

    // X-axis labels
    const labelX = x + actualBarWidth / 2;
    if (labels[index] && labelX - lastLabelX >= minLabelSpacing) {
      const text = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      text.setAttribute("x", String(labelX));
      text.setAttribute("y", String(padding.top + chartHeight + 15));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "12");
      text.setAttribute("fill", "#666");
      text.textContent = labels[index];
      svg.appendChild(text);
      lastLabelX = labelX;
    }
  });

  // Daily view keeps a fixed 8h full-width reference line.
  if (!isWeeklyView) {
    const yReference = padding.top + chartHeight - (8 / leftMax) * chartHeight;
    const referenceLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    referenceLine.setAttribute("x1", String(padding.left));
    referenceLine.setAttribute("y1", String(yReference));
    referenceLine.setAttribute("x2", String(padding.left + chartWidth));
    referenceLine.setAttribute("y2", String(yReference));
    referenceLine.setAttribute("stroke", "#666");
    referenceLine.setAttribute("stroke-width", "1.5");
    referenceLine.setAttribute("stroke-dasharray", "4 4");
    referenceLine.setAttribute("opacity", "0.75");
    svg.appendChild(referenceLine);
  }

  // Draw cumulative overtime line (right Y axis scale)
  if (cumulativeData.length > 0) {
    const points: Array<{ x: number; y: number }> = [];

    cumulativeData.forEach((value, index) => {
      const x = padding.left + index * barWidth + barWidth / 2;
      const normalized = (value - cumulativeMin) / cumulativeRange;
      const y = padding.top + chartHeight - normalized * chartHeight;
      points.push({ x, y });
    });

    const zeroNormalized = (0 - cumulativeMin) / cumulativeRange;
    const yZero = padding.top + chartHeight - zeroNormalized * chartHeight;
    const zeroLine = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "line",
    );
    zeroLine.setAttribute("x1", String(padding.left));
    zeroLine.setAttribute("y1", String(yZero));
    zeroLine.setAttribute("x2", String(padding.left + chartWidth));
    zeroLine.setAttribute("y2", String(yZero));
    zeroLine.setAttribute("stroke", "#1f6fd1");
    zeroLine.setAttribute("stroke-width", "1.5");
    zeroLine.setAttribute("stroke-dasharray", "4 4");
    zeroLine.setAttribute("opacity", "0.75");
    svg.appendChild(zeroLine);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", buildSmoothPath(points));
    line.setAttribute("stroke", "#0057d8");
    line.setAttribute("stroke-width", "3.5");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    svg.appendChild(line);

    // Right Y-axis integer labels — always includes 0.
    for (let v = cumulativeMin; v <= cumulativeMax; v += rightStep) {
      const y =
        padding.top +
        chartHeight -
        ((v - cumulativeMin) / cumulativeRange) * chartHeight;
      const text = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      text.setAttribute("x", String(padding.left + chartWidth + 10));
      text.setAttribute("y", String(y + 5));
      text.setAttribute("text-anchor", "start");
      text.setAttribute("font-size", "12");
      text.setAttribute("fill", "#0057d8");
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
  yAxis.setAttribute("stroke", "#333");
  yAxis.setAttribute("stroke-width", "1");
  svg.appendChild(yAxis);

  const rightAxis = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "line",
  );
  rightAxis.setAttribute("x1", String(padding.left + chartWidth));
  rightAxis.setAttribute("y1", String(padding.top));
  rightAxis.setAttribute("x2", String(padding.left + chartWidth));
  rightAxis.setAttribute("y2", String(padding.top + chartHeight));
  rightAxis.setAttribute("stroke", "#1f6fd1");
  rightAxis.setAttribute("stroke-width", "1");
  svg.appendChild(rightAxis);

  return svg;
}

function buildSmoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }

  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`;
  }

  let path = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const next = points[i + 1];
    const xc = (points[i].x + next.x) / 2;
    const yc = (points[i].y + next.y) / 2;
    path += ` Q ${points[i].x} ${points[i].y} ${xc} ${yc}`;
  }

  const last = points[points.length - 1];
  path += ` T ${last.x} ${last.y}`;
  return path;
}

function fillMissingDays(
  dailyData: OvertimeData["dailyData"],
): OvertimeData["dailyData"] {
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

  for (
    let cursor = new Date(start);
    cursor <= end;
    cursor.setDate(cursor.getDate() + 1)
  ) {
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

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let activeTooltip: HTMLElement | null = null;

function formatHoursToHoursAndMinutes(hours: number): string {
  const wholeHours = Math.floor(hours);
  const minutes = Math.round((hours - wholeHours) * 60);
  return `${wholeHours}h ${minutes}min`;
}

function showChartTooltip(
  event: MouseEvent,
  dateStr: string,
  hours: number,
  endDate?: string,
) {
  // Remove existing tooltip
  if (activeTooltip) {
    activeTooltip.remove();
  }

  const tooltip = document.createElement("div");
  tooltip.style.cssText = `
      position: fixed;
      background: #333;
      color: #fff;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      user-select: none;
    `;

  let displayDate = "";
  if (endDate) {
    // For weekly view: show date range
    const startDateObj = dateStr ? new Date(dateStr) : null;
    const endDateObj = endDate ? new Date(endDate) : null;
    if (startDateObj && endDateObj) {
      const startFormatted = startDateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const endFormatted = endDateObj.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      displayDate = `${startFormatted} - ${endFormatted}`;
    }
  } else {
    // For daily view: show single date
    displayDate = dateStr
      ? new Date(dateStr).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : "";
  }

  tooltip.textContent = `${displayDate}: ${formatHoursToHoursAndMinutes(hours)}`;
  document.body.appendChild(tooltip);

  // Position tooltip above the bars
  const rect = (event.target as Element).getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  tooltip.style.left =
    rect.left + rect.width / 2 - tooltipRect.width / 2 + "px";
  tooltip.style.top = rect.top - 30 + "px";

  activeTooltip = tooltip;
}

function hideChartTooltip() {
  if (activeTooltip) {
    activeTooltip.remove();
    activeTooltip = null;
  }
}
