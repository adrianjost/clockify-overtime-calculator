import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc.ts";
import { initializeSettings } from "./settings.ts";
import { initializeDashboard } from "./dashboard.ts";

// Define the Electroview RPC schema (renderer-side handlers, which are empty for now)
const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {},
    messages: {},
  },
});

// Create Electroview instance with the RPC definition
const electrobun = new Electroview({ rpc });

console.log("Electroview initialized with RPC:", electrobun);

const settingsContainer = document.querySelector(
  "#settings-container",
) as HTMLDivElement;
const dashboardContainer = document.querySelector(
  "#dashboard-container",
) as HTMLDivElement;

if (!settingsContainer || !dashboardContainer) {
  console.error("App containers are missing");
  document.body.innerHTML = "<h1>Error: App containers not found</h1>";
  throw new Error("App containers are missing");
}

// Navigation functions
const showSettings = () => {
  settingsContainer.style.display = "block";
  dashboardContainer.style.display = "none";
};

const showDashboard = () => {
  settingsContainer.style.display = "none";
  dashboardContainer.style.removeProperty("display");
};

// Handle URL hash navigation
const handleNavigation = () => {
  const hash = window.location.hash;
  if (hash === "#settings") {
    showSettings();
  } else {
    showDashboard();
  }
};

window.addEventListener("hashchange", handleNavigation);

try {
  // Initialize both views
  initializeSettings(electrobun, showDashboard);
  initializeDashboard(electrobun, showSettings);

  // Check if we have API key
  const apiKey = localStorage.getItem("clockify_api_key");
  if (!apiKey?.trim()) {
    showSettings();
  } else {
    showDashboard();
  }
} catch (error) {
  console.error("Failed to initialize app:", error);
  // Show dashboard as fallback
  showDashboard();
}
