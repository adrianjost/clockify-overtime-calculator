import Chart from "chart.js/auto";
import type { Electroview } from "electrobun/view";
import type { OvertimeData } from "../bun/report.ts";

interface ChartInstances {
  daily?: Chart;
  cumulative?: Chart;
}

const charts: ChartInstances = {};

export function initializeDashboard(
  electrobun: Electroview<any>,
  onNavigateToSettings: () => void,
) {
  const yearSelect = document.querySelector<HTMLInputElement>("#year-select");
  const analyzeButton = document.querySelector<HTMLButtonElement>(
    "#analyze-button",
  );
  const statusMessage = document.querySelector<HTMLDivElement>(
    "#status-message",
  );
  const content = document.querySelector<HTMLDivElement>("#content");
  const overtimeValue = document.querySelector<HTMLDivElement>(
    "#overtime-value",
  );

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
      renderDashboard(data, overtimeValue, content);
      setStatus("", "");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";
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

    // Destroy existing charts
    if (charts.daily) {
      charts.daily.destroy();
      charts.daily = undefined;
    }
    if (charts.cumulative) {
      charts.cumulative.destroy();
      charts.cumulative = undefined;
    }

    const dailyCanvas = document.querySelector<HTMLCanvasElement>(
      "#daily-chart",
    );
    const cumulativeCanvas = document.querySelector<HTMLCanvasElement>(
      "#cumulative-chart",
    );

    if (!dailyCanvas || !cumulativeCanvas) {
      console.error("Canvas elements not found");
      return;
    }

    // Set explicit canvas dimensions
    dailyCanvas.width = 400;
    dailyCanvas.height = 250;
    cumulativeCanvas.width = 400;
    cumulativeCanvas.height = 250;

    // Daily chart (bar chart)
    const dailyCtx = dailyCanvas.getContext("2d");
    if (dailyCtx) {
      const dailyLabels = data.dailyData.map((d) => d.date);
      const actualHours = data.dailyData.map((d) => d.actualHours);
      const expectedHours = data.dailyData.map((d) => d.expectedHours);

      console.log("Creating daily chart");

      charts.daily = new Chart(dailyCtx, {
        type: "bar",
        data: {
          labels: dailyLabels,
          datasets: [
            {
              label: "Actual Hours",
              data: actualHours,
              backgroundColor: "rgba(14, 124, 102, 0.7)",
            },
            {
              label: "Expected Hours",
              data: expectedHours,
              backgroundColor: "rgba(200, 200, 200, 0.5)",
            },
          ],
        },
        options: {
          responsive: false,
          plugins: {
            legend: {
              position: "bottom" as const,
            },
          },
          scales: {
            y: {
              beginAtZero: true,
            },
          },
        },
      });
    }

    // Cumulative chart (line chart)
    const cumulativeCtx = cumulativeCanvas.getContext("2d");
    if (cumulativeCtx) {
      const cumulativeLabels = data.dailyData.map((d) => d.date);
      const cumulativeHours = data.dailyData.map((d) => d.cumulativeOvertimeHours);

      console.log("Creating cumulative chart");

      charts.cumulative = new Chart(cumulativeCtx, {
        type: "line",
        data: {
          labels: cumulativeLabels,
          datasets: [
            {
              label: "Cumulative Overtime",
              data: cumulativeHours,
              borderColor: "#1f6fd1",
              backgroundColor: "rgba(31, 111, 209, 0.1)",
              tension: 0.3,
              fill: true,
              pointRadius: 0,
              borderWidth: 2,
            },
          ],
        },
        options: {
          responsive: false,
          plugins: {
            legend: {
              position: "bottom" as const,
            },
          },
          scales: {
            y: {
              ticks: {
                stepSize: 1,
              },
            },
          },
        },
      });

      console.log("Charts created successfully");
    }
  } catch (error) {
    console.error("Error rendering charts:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
  }
}
