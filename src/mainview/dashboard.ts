import type { Electroview } from "electrobun/view";
import type { OvertimeData } from "../bun/report.ts";

type CumulativeMode = "daily" | "weekly";

export function initializeDashboard(
  electrobun: Electroview<any>,
  onNavigateToSettings: () => void,
) {
  const yearSelect = document.querySelector<HTMLInputElement>("#year-select");
  const analyzeButton =
    document.querySelector<HTMLButtonElement>("#analyze-button");
  const statusMessage =
    document.querySelector<HTMLDivElement>("#status-message");
  const cumulativeModeSelect = document.querySelector<HTMLSelectElement>(
    "#cumulative-mode",
  );
  const content = document.querySelector<HTMLDivElement>("#content");
  const overtimeValue =
    document.querySelector<HTMLDivElement>("#overtime-value");
  let lastData: OvertimeData | null = null;

  if (cumulativeModeSelect) {
    cumulativeModeSelect.value = "daily";
    cumulativeModeSelect.addEventListener("change", () => {
      if (!lastData) {
        return;
      }
      renderDashboard(lastData, overtimeValue, content, getCumulativeMode());
    });
  }

  if (!yearSelect || !analyzeButton) {
    throw new Error("Dashboard elements are missing");
  }

  yearSelect.value = new Date().getFullYear().toString();

  analyzeButton.addEventListener("click", async () => {
    const apiKey = localStorage.getItem("clockify_api_key");
    if (!apiKey?.trim()) {
      onNavigateToSettings();
      return;
    }

    const year = Number.parseInt(yearSelect.value, 10);
    if (Number.isNaN(year)) {
      setStatus("Please enter a valid year", "error");
      return;
    }

    setStatus("Analyzing...", "loading");
    analyzeButton.disabled = true;

    try {
      const data = await (electrobun as any).rpc.request.analyzeOvertime({
        apiKey,
        year,
      });
      lastData = data;
      renderDashboard(data, overtimeValue, content, getCumulativeMode());
      setStatus("", "");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus(`Error: ${message}`, "error");
    } finally {
      analyzeButton.disabled = false;
    }
  });

  // Note: Auto-trigger disabled to prevent stack overflow
  // User can manually click Analyze or it will auto-load on next session

  function setStatus(
    message: string,
    type: "loading" | "error" | "success" | "",
  ) {
    if (statusMessage) {
      statusMessage.textContent = message;
      statusMessage.className = type ? `status-${type}` : "";
    }
  }

  function getCumulativeMode(): CumulativeMode {
    return cumulativeModeSelect?.value === "weekly" ? "weekly" : "daily";
  }
}

function renderDashboard(
  data: OvertimeData,
  overtimeValue: HTMLDivElement | null,
  content: HTMLDivElement | null,
  cumulativeMode: CumulativeMode,
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
  renderCharts(data, cumulativeMode);
}

function renderCharts(data: OvertimeData, cumulativeMode: CumulativeMode) {
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
    const cumulativeHours = buildCumulativeSeries(filledDailyData, cumulativeMode);

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
          day: "numeric",
        });
      }
      return "";
    });

    // Render bar chart
    const barSvg = createBarChart(
      actualHours,
      cumulativeHours,
      displayLabels,
      dailyDates,
      "rgba(132, 150, 163, 0.45)",
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
): SVGSVGElement {
  const width = 800;
  const height = 300;
  const padding = { top: 20, right: 20, bottom: 60, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.style.border = "1px solid #f0f0f0";
  svg.style.borderRadius = "8px";

  const maxValue = Math.max(...data, 1);
  const barWidth = chartWidth / data.length;

  const cumulativeMin = Math.min(...cumulativeData, 0);
  const cumulativeMax = Math.max(...cumulativeData, 0);
  const cumulativeRange = cumulativeMax - cumulativeMin || 1;

  // Left Y-axis labels for daily hours
  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartHeight / 5) * i;

    const value = Math.round((maxValue / 5) * (5 - i));
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(padding.left - 10));
    text.setAttribute("y", String(y + 5));
    text.setAttribute("text-anchor", "end");
    text.setAttribute("font-size", "12");
    text.setAttribute("fill", "#666");
    text.textContent = String(value);
    svg.appendChild(text);
  }

  // Bars
  data.forEach((value, index) => {
    const barHeight = (value / maxValue) * chartHeight;
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
    if (labels[index]) {
      const text = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      text.setAttribute("x", String(x + actualBarWidth / 2));
      text.setAttribute("y", String(padding.top + chartHeight + 15));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-size", "12");
      text.setAttribute("fill", "#666");
      text.textContent = labels[index];
      svg.appendChild(text);
    }
  });

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

    const zeroLabel = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "text",
    );
    zeroLabel.setAttribute("x", String(padding.left + chartWidth + 10));
    zeroLabel.setAttribute("y", String(yZero + 4));
    zeroLabel.setAttribute("text-anchor", "start");
    zeroLabel.setAttribute("font-size", "12");
    zeroLabel.setAttribute("fill", "#1f6fd1");
    zeroLabel.textContent = "0h";
    svg.appendChild(zeroLabel);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", buildSmoothPath(points));
    line.setAttribute("stroke", "#0057d8");
    line.setAttribute("stroke-width", "3.5");
    line.setAttribute("fill", "none");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    svg.appendChild(line);

    // Subtle points for visibility
    cumulativeData.forEach((value, index) => {
      const x = padding.left + index * barWidth + barWidth / 2;
      const normalized = (value - cumulativeMin) / cumulativeRange;
      const y = padding.top + chartHeight - normalized * chartHeight;
      const point = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "circle",
      );
      point.setAttribute("cx", String(x));
      point.setAttribute("cy", String(y));
      point.setAttribute("r", "2");
      point.setAttribute("fill", "#0057d8");
      svg.appendChild(point);
    });

    // Right Y-axis labels for cumulative overtime
    for (let i = 0; i <= 5; i += 1) {
      const y = padding.top + (chartHeight / 5) * i;
      const value = cumulativeMax - (cumulativeRange / 5) * i;
      const text = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "text",
      );
      text.setAttribute("x", String(padding.left + chartWidth + 10));
      text.setAttribute("y", String(y + 5));
      text.setAttribute("text-anchor", "start");
      text.setAttribute("font-size", "12");
      text.setAttribute("fill", "#0057d8");
      text.textContent = value.toFixed(1);
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
