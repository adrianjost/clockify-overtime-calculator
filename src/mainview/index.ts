import { bridge } from "./bridge.ts";
import { initializeSettings } from "./settings.ts";
import { initializeDashboard } from "./dashboard.ts";
import { initializeTracking } from "./tracking.ts";

const settingsContainer = document.querySelector("#settings-container") as HTMLDivElement;
const dashboardContainer = document.querySelector("#dashboard-container") as HTMLDivElement;
const entriesContainer = document.querySelector("#entries-container") as HTMLDivElement;

if (!settingsContainer || !dashboardContainer) {
  console.error("App containers are missing");
  document.body.innerHTML = "<h1>Error: App containers not found</h1>";
  throw new Error("App containers are missing");
}

const showView = (view: HTMLElement) => {
  for (const container of [settingsContainer, dashboardContainer, entriesContainer]) {
    if (container === view) container.style.removeProperty("display");
    else container.style.display = "none";
  }
};
const showSettings = () => showView(settingsContainer);
const showDashboard = () => showView(dashboardContainer);

const handleNavigation = () => {
  const hash = window.location.hash;
  if (hash === "#settings") {
    showSettings();
  } else if (hash === "#entries") {
    showView(entriesContainer);
  } else {
    showDashboard();
  }
};

window.addEventListener("hashchange", handleNavigation);

for (const view of [settingsContainer, entriesContainer]) {
  const scroll = view.querySelector<HTMLElement>(".settings-scroll");
  scroll?.addEventListener("scroll", () => {
    view.classList.toggle("is-scrolled", scroll.scrollTop > 0);
  });
}
handleNavigation();

try {
  // Initialize both views
  const { runAnalysis } = initializeDashboard(showSettings);
  initializeTracking();
  initializeSettings(
    () => {
      showDashboard();
      runAnalysis();
    },
    () => {
      history.back();
    },
  );

  // Without a Clockify API key or a time tracking server, start in the settings.
  void (async () => {
    try {
      const { configured } = await bridge.getSetupState({});
      if (!configured) showSettings();
    } catch {
      showSettings();
    }
  })();
} catch (error) {
  console.error("Failed to initialize app:", error);
  // Show dashboard as fallback
  showDashboard();
}
