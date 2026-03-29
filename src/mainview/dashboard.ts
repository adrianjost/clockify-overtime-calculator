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

  // Optional: Trigger analysis on load if API key exists
  const apiKey = localStorage.getItem("clockify_api_key");
  if (apiKey?.trim()) {
    setStatus("Loading data...", "loading");
    setTimeout(() => analyzeButton.click(), 100);
  }

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
  // Destroy existing charts
  charts.daily?.destroy();
  charts.cumulative?.destroy();

  const dailyCanvas = document.querySelector<HTMLCanvasElement>(
    "#daily-chart",
  );
  const cumulativeCanvas = document.querySelector<HTMLCanvasElement>(
    "#cumulative-chart",
  );

  if (!dailyCanvas || !cumulativeCanvas) return;

  // Daily chart (bar chart)
  const dailyCtx = dailyCanvas.getContext("2d");
  if (dailyCtx) {
    charts.daily = new Chart(dailyCtx, {
      type: "bar",
      data: {
        labels: data.dailyData.map((d: any) => d.date),
        datasets: [
          {
            label: "Actual Hours",
            data: data.dailyData.map((d: any) => d.actualHours),
            backgroundColor: "rgba(14, 124, 102, 0.7)",
            borderRadius: 4,
          },
          {
            label: "Expected Hours",
            data: data.dailyData.map((d: any) => d.expectedHours),
            backgroundColor: "rgba(200, 200, 200, 0.5)",
            borderRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            position: "top",
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: "Hours",
            },
          },
        },
      },
    });
  }

  // Cumulative chart (line chart)
  const cumulativeCtx = cumulativeCanvas.getContext("2d");
  if (cumulativeCtx) {
    charts.cumulative = new Chart(cumulativeCtx, {
      type: "line",
      data: {
        labels: data.dailyData.map((d: any) => d.date),
        datasets: [
          {
            label: "Cumulative Overtime",
            data: data.dailyData.map((d: any) => d.cumulativeOvertimeHours),
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
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: true,
            position: "top",
          },
        },
        scales: {
          y: {
            title: {
              display: true,
              text: "Hours",
            },
          },
        },
      },
    });
  }
}
