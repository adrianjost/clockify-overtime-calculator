import type { Electroview } from "electrobun/view";
import type { OvertimeData } from "../bun/report.ts";

type CumulativeMode = "daily" | "weekly";

export function initializeDashboard(
  electrobun: Electroview<any>,
  onNavigateToSettings: () => void,
) {
  const yearSelect = document.querySelector<HTMLInputElement>("#year-select");
  const lastFetchedEl = document.querySelector<HTMLDivElement>("#last-fetched");
  const fetchSpinner = document.querySelector<HTMLElement>("#fetch-spinner");
  const content = document.querySelector<HTMLDivElement>("#content");
  const overtimeValue =
    document.querySelector<HTMLDivElement>("#overtime-value");
  let lastData: OvertimeData | null = null;
  let resizeRafId: number | null = null;

  if (!yearSelect) {
    throw new Error("Dashboard elements are missing");
  }

  // Load saved year from localStorage, default to current year
  const savedYear = localStorage.getItem("clockify_viewed_year");
  const defaultYear = new Date().getFullYear().toString();
  yearSelect.value = savedYear || defaultYear;

  // Polling state — declared before runAnalysis so the closure can reference them
  const POLL_INTERVAL_MS = 5 * 60 * 1000;
  const MIN_REFETCH_ON_VISIBILITY_MS = 60 * 1000;
  let lastFetchTime = 0;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function runAnalysis() {
    const apiKey = localStorage.getItem("clockify_api_key");
    if (!apiKey?.trim()) {
      onNavigateToSettings();
      return;
    }

    const year = Number.parseInt(yearSelect!.value, 10);
    if (Number.isNaN(year) || year < 1970 || year > 3000) {
      return;
    }

    setLoading(true);
    lastFetchTime = Date.now();

    try {
      const data = await (electrobun as any).rpc.request.analyzeOvertime({
        apiKey,
        year,
      });
      lastData = data;
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

  yearSelect.addEventListener("change", () => {
    localStorage.setItem("clockify_viewed_year", yearSelect.value);
    runAnalysis();
  });

  // Auto-fetch on initial load
  runAnalysis();

  async function fetchIfApiKeyPresent() {
    const apiKey = localStorage.getItem("clockify_api_key");
    if (!apiKey?.trim()) return;
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

}

function renderDashboard(
  data: OvertimeData,
  overtimeValue: HTMLDivElement | null,
  content: HTMLDivElement | null,
) {
  if (!overtimeValue || !content) return;

  // Update overtime value
  const sign = data.totalOvertimeHours >= 0 ? "+" : "";
  overtimeValue.textContent = `${sign}${data.totalOvertimeHours}h ${data.totalOvertimeMinutes}min`;
  if (data.totalOvertimeHours < 0) {
    overtimeValue.style.color = "#b42318";
  } else {
    overtimeValue.style.color = "#0e7c66";
  }

  // Show content
  content.style.display = "block";

  // Render charts
  renderCharts(data);
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

    // Prepare data
    const dailyDates = filledDailyData.map((d) => d.date);
    const actualHours = filledDailyData.map((d) => d.actualHours);

    // Create display labels (only on month changes)
    const displayLabels = dailyDates.map((date, index) => {
      const current = new Date(date);
      let previousMonth = -1;

      if (index > 0) {
        const previous = new Date(dailyDates[index - 1]);
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

    // Determine if we should use weekly density instead of daily
    // Use weekly if bars would be less than 8px wide (more fine-grained control)
    const shouldUseWeekly = chartWidth / filledDailyData.length < 8;
    
    // Build cumulative series based on the view mode (daily or weekly)
    const cumulativeMode: CumulativeMode = shouldUseWeekly ? "weekly" : "daily";
    const cumulativeHours = buildCumulativeSeries(
      filledDailyData,
      cumulativeMode,
    );
    
    let dataToUse = actualHours;
    let cumulativeToUse = cumulativeHours;
    let labelsToUse = displayLabels;
    let datesToUse = dailyDates;

    if (shouldUseWeekly) {
      const weeklyData = aggregateToWeekly(filledDailyData, cumulativeHours);
      dataToUse = weeklyData.hours;
      cumulativeToUse = weeklyData.cumulative;
      labelsToUse = weeklyData.labels;
      datesToUse = weeklyData.dates;
    }

    // Update chart title based on view mode
    const h2Title = dailyContainer.parentElement?.querySelector("h2");
    if (h2Title) {
      h2Title.textContent = shouldUseWeekly ? "Weekly Working Hours" : "Daily Working Hours";
    }

    const barSvg = createBarChart(
      dataToUse,
      cumulativeToUse,
      labelsToUse,
      datesToUse,
      "rgba(132, 150, 163, 0.45)",
      chartWidth,
      chartHeight,
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
  const cumulative: number[] = [];

  for (const weekKey of weekOrder) {
    const weekData = weekKeyToData.get(weekKey)!;
    const indices = weekData.indices;

    // Sum actual hours for the week
    const weekHours = indices.reduce((sum, i) => sum + filledDailyData[i].actualHours, 0);
    hours.push(weekHours);

    // Use Monday (first day of week) as the representative date
    dates.push(weekData.startDate);

    // Cumulative is taken from the provided cumulative array (respects mode: daily/weekly)
    // Use the last index of the week to get the cumulative at week's end
    cumulative.push(cumulativeData[indices[indices.length - 1]]);
  }

  // Create labels (show first week only, or month changes)
  const labels = dates.map((date, index) => {
    const current = new Date(date);
    let previousMonth = -1;

    if (index > 0) {
      const previous = new Date(dates[index - 1]);
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

  return { hours, cumulative, labels, dates };
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

function getWeekKey(isoDate: string): string {
  const date = new Date(isoDate);
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
): SVGSVGElement {
  const padding = { top: 20, right: 50, bottom: 60, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const rawMax = Math.max(...data, 1);
  // Coarser ticks on narrow widths or short heights
  const maxLeftTicks = width < 640 ? 5 : height < 250 ? 5 : 8;
  // Step must be a divisor of 8 so both 0 and 8 always appear as ticks.
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

  // Left Y-axis integer labels — always includes 0 and 8.
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
      showChartTooltip(e, dates[index] || "", value),
    );
    rect.addEventListener("mouseleave", hideChartTooltip);
    svg.appendChild(rect);

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

  // 8h reference line on left axis (label shown on Y axis tick).
  const y8h = padding.top + chartHeight - (8 / leftMax) * chartHeight;
  const line8h = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line8h.setAttribute("x1", String(padding.left));
  line8h.setAttribute("y1", String(y8h));
  line8h.setAttribute("x2", String(padding.left + chartWidth));
  line8h.setAttribute("y2", String(y8h));
  line8h.setAttribute("stroke", "#666");
  line8h.setAttribute("stroke-width", "1.5");
  line8h.setAttribute("stroke-dasharray", "4 4");
  line8h.setAttribute("opacity", "0.75");
  svg.appendChild(line8h);

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
  const firstYear = Number.parseInt(firstEntry.date.slice(0, 4), 10);

  // Start at Jan 1 for the selected year so non-worked days are visible.
  const start = new Date(firstYear, 0, 1);
  const end = new Date(lastEntry.date);

  const today = new Date();
  if (today.getFullYear() === firstYear && today > end) {
    end.setTime(today.getTime());
  }

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

function showChartTooltip(event: MouseEvent, dateStr: string, hours: number) {
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
    `;

  const displayDate = dateStr
    ? new Date(dateStr).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      })
    : "";

  tooltip.textContent = `${displayDate}: ${hours.toFixed(2)}h`;
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
