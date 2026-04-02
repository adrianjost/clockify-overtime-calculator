import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc.ts";
import { initializeSettings } from "./settings.ts";
import { initializeDashboard } from "./dashboard.ts";

type ElectrobunClient = Electroview<AppRPC>;

// Define the Electroview RPC schema (renderer-side handlers, which are empty for now)
const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {},
    messages: {},
  },
});

// Create Electroview instance with the RPC definition
const electrobun: ElectrobunClient = new Electroview({ rpc });

const settingsContainer = document.querySelector("#settings-container") as HTMLDivElement;
const dashboardContainer = document.querySelector("#dashboard-container") as HTMLDivElement;

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
handleNavigation();

try {
  // Initialize both views
  const { runAnalysis } = initializeDashboard(electrobun, showSettings);
  initializeSettings(
    electrobun,
    () => {
      showDashboard();
      runAnalysis();
    },
    () => {
      history.back();
    },
  );

  // Check if we have API key in secure storage
  void (async () => {
    try {
      const state = await electrobun.rpc.request.getStoredApiKey({});
      const apiKey = (state?.apiKey ?? "").trim();
      if (!apiKey) {
        showSettings();
      } else {
        showDashboard();
      }
    } catch {
      showSettings();
    }
  })();
} catch (error) {
  console.error("Failed to initialize app:", error);
  // Show dashboard as fallback
  showDashboard();
}
