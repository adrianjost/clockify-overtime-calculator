import type { DataSource } from "../shared/rpc.ts";
import { bridge } from "./bridge.ts";
import { initializeThemePicker } from "./theme-picker.ts";

export function initializeSettings(onSettingsSaved: () => void, onCancel?: () => void) {
  const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key");
  const saveStatus = document.querySelector<HTMLSpanElement>("#save-status");

  if (!apiKeyInput || !saveStatus) {
    throw new Error("Settings form elements are missing");
  }

  // Hide reset button, close button, and launch-at-login during initial onboarding
  const dangerZone = document.querySelector<HTMLElement>(".settings-danger-zone");

  const closeBtn = document.querySelector<HTMLButtonElement>("#close-settings-btn");
  if (closeBtn) {
    // During onboarding the settings are shown without a #settings history entry to go back from.
    closeBtn.addEventListener("click", () => {
      if (location.hash === "#settings") onCancel?.();
      else onSettingsSaved();
    });
  }

  void bridge
    .getTheme({})
    .then(({ theme }) => initializeThemePicker(theme, (theme) => void bridge.setTheme({ theme })))
    .catch((error) => console.error("Loading the theme failed:", error));

  // Tray visibility toggle — only shown when API key already exists
  const trayEnabledGroup = document.querySelector<HTMLElement>("#tray-enabled-group");
  const trayEnabledCheckbox = document.querySelector<HTMLInputElement>("#tray-enabled");
  if (trayEnabledCheckbox) {
    trayEnabledCheckbox.checked = localStorage.getItem("tray_enabled") !== "false";

    trayEnabledCheckbox.addEventListener("change", async () => {
      const enabled = trayEnabledCheckbox.checked;
      localStorage.setItem("tray_enabled", String(enabled));
      try {
        await bridge.setTrayEnabled({ enabled });
      } catch (err) {
        console.error("setTrayEnabled failed:", err);
        trayEnabledCheckbox.checked = !enabled;
        localStorage.setItem("tray_enabled", String(!enabled));
      }
    });
  }

  const traySecondsGroup = document.querySelector<HTMLElement>("#tray-seconds-group");
  const traySecondsCheckbox = document.querySelector<HTMLInputElement>("#tray-seconds");
  if (traySecondsCheckbox) {
    void bridge.getTraySeconds({}).then(({ enabled }) => {
      traySecondsCheckbox.checked = enabled;
    });
    traySecondsCheckbox.addEventListener("change", async () => {
      const enabled = traySecondsCheckbox.checked;
      try {
        await bridge.setTraySeconds({ enabled });
      } catch (err) {
        console.error("setTraySeconds failed:", err);
        traySecondsCheckbox.checked = !enabled;
      }
    });
  }
  // The seconds only matter while the balance is shown in the menu bar.
  trayEnabledCheckbox?.addEventListener("change", () => applyAuthVisibility());

  // Launch at login toggle — only shown when API key already exists
  const launchAtLoginGroup = document.querySelector<HTMLElement>("#launch-at-login-group");
  const launchAtLoginCheckbox = document.querySelector<HTMLInputElement>("#launch-at-login");
  if (launchAtLoginCheckbox) {
    void bridge.getLaunchAtLogin({}).then(({ enabled }) => {
      launchAtLoginCheckbox.checked = enabled;
    });
    launchAtLoginCheckbox.addEventListener("change", async () => {
      const enabled = launchAtLoginCheckbox.checked;
      try {
        await bridge.setLaunchAtLogin({ enabled });
      } catch (err) {
        console.error("setLaunchAtLogin failed:", err);
        launchAtLoginCheckbox.checked = !enabled;
      }
    });
  }

  let isConfigured = false;
  let dataSource: DataSource | null = null;
  // Until anything is set up, the settings are the onboarding.
  let onboarding = true;
  const sourceInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="data-source"]'),
  );
  const clockifySettings = document.querySelector<HTMLElement>("#clockify-settings");
  const serverSettings = document.querySelector<HTMLElement>("#server-settings");
  const settingsTitle = document.querySelector<HTMLElement>("#settings-title");
  const sourceFooter = document.querySelector<HTMLElement>("#data-source-footer");

  const applyAuthVisibility = () => {
    for (const input of sourceInputs) input.checked = input.value === dataSource;
    if (clockifySettings) clockifySettings.hidden = dataSource !== "clockify";
    if (serverSettings) serverSettings.hidden = dataSource !== "server";
    const general = document.querySelector<HTMLElement>("#general-group");
    if (general) general.hidden = !isConfigured;
    if (isConfigured) onboarding = false;
    if (settingsTitle) settingsTitle.textContent = onboarding ? "Welcome" : "Settings";
    if (sourceFooter) {
      sourceFooter.textContent = !onboarding
        ? "Both stay set up, so you can switch at any time."
        : "Where are your time entries? You can switch later.";
    }
    if (dangerZone) {
      dangerZone.style.display = isConfigured ? "" : "none";
    }
    if (closeBtn) {
      closeBtn.hidden = !isConfigured;
    }
    if (traySecondsGroup) {
      traySecondsGroup.hidden = !isConfigured || !trayEnabledCheckbox?.checked;
    }
    if (trayEnabledGroup) {
      trayEnabledGroup.hidden = !isConfigured;
    }
    if (launchAtLoginGroup) {
      launchAtLoginGroup.hidden = !isConfigured;
    }
  };

  applyAuthVisibility();

  void (async () => {
    try {
      const [state, setup] = await Promise.all([
        bridge.getStoredApiKey({}),
        bridge.getSetupState({}),
      ]);
      const secureApiKey = (state?.apiKey ?? "").trim();
      if (secureApiKey) apiKeyInput.value = secureApiKey;
      onboarding = !setup.configured && setup.dataSource === null;
      // On first launch the self-hosted server is preselected.
      dataSource = setup.dataSource ?? "server";
      if (setup.dataSource === null) void bridge.setDataSource({ dataSource });
      if (setup.configured) {
        isConfigured = true;
        if (trayEnabledCheckbox) {
          const trayState = await bridge.getTrayEnabled({});
          const enabled = Boolean(trayState?.enabled);
          trayEnabledCheckbox.checked = enabled;
          localStorage.setItem("tray_enabled", String(enabled));
        }
      }
      applyAuthVisibility();
    } catch (err) {
      console.error("getStoredApiKey failed:", err);
    }
  })();

  for (const input of sourceInputs) {
    input.addEventListener("change", async () => {
      const previous = dataSource;
      dataSource = input.value as DataSource;
      applyAuthVisibility();
      try {
        await bridge.setDataSource({ dataSource });
        isConfigured = (await bridge.getSetupState({})).configured;
        applyAuthVisibility();
        window.dispatchEvent(new Event("tracking-changed"));
      } catch (err) {
        console.error("setDataSource failed:", err);
        dataSource = previous;
        applyAuthVisibility();
      }
    });
  }

  window.addEventListener("tracking-changed", async () => {
    try {
      const setup = await bridge.getSetupState({});
      isConfigured = setup.configured;
      dataSource = setup.dataSource;
      applyAuthVisibility();
    } catch (err) {
      console.error("getSetupState failed:", err);
    }
  });

  // Auto-save API key on input change
  apiKeyInput.addEventListener("change", async () => {
    const value = apiKeyInput.value.trim();
    if (value) {
      try {
        await bridge.setStoredApiKey({ apiKey: value });
        isConfigured = true;
        window.dispatchEvent(new Event("tracking-changed"));
        applyAuthVisibility();
        saveStatus.textContent = "✓ Saved";
        saveStatus.className = "save-status is-success";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 1000);
      } catch (err) {
        console.error("setStoredApiKey failed:", err);
        saveStatus.textContent = "Failed to save API key";
        saveStatus.className = "save-status is-error";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 2000);
      }
    }
  });

  const serverUrlInput = document.querySelector<HTMLInputElement>("#server-url");
  const serverUsernameInput = document.querySelector<HTMLInputElement>("#server-username");
  const serverPasswordInput = document.querySelector<HTMLInputElement>("#server-password");
  const serverPasswordRow = document.querySelector<HTMLElement>("#server-password-row");
  const serverSignedIn = document.querySelector<HTMLElement>("#server-signed-in");
  const serverButton = document.querySelector<HTMLButtonElement>("#server-sign-in");
  const serverStatus = document.querySelector<HTMLSpanElement>("#server-status");
  if (
    serverUrlInput &&
    serverUsernameInput &&
    serverPasswordInput &&
    serverPasswordRow &&
    serverSignedIn &&
    serverButton &&
    serverStatus
  ) {
    let signedIn = false;
    const renderServer = () => {
      serverUrlInput.disabled = serverUsernameInput.disabled = signedIn;
      serverPasswordRow.hidden = signedIn;
      serverSignedIn.textContent = signedIn ? `Signed in as ${serverUsernameInput.value}` : "";
      serverButton.textContent = signedIn ? "Sign out" : "Sign in";
    };
    const showServerStatus = (text: string, isError = false) => {
      serverStatus.textContent = text;
      serverStatus.className = `save-status ${isError ? "is-error" : "is-success"}`;
    };

    const loadServerSettings = async () => {
      const settings = await bridge.getServerSettings({});
      serverUrlInput.value = settings.url ?? "";
      serverUsernameInput.value = settings.username ?? "";
      signedIn = settings.signedIn;
      if (settings.notice) showServerStatus(settings.notice, true);
      renderServer();
    };
    void loadServerSettings();
    // The app reports a session the server rejected as a tracking change.
    window.addEventListener("tracking-changed", () => void loadServerSettings());

    const submit = async () => {
      serverButton.disabled = true;
      showServerStatus(signedIn ? "" : "Signing in…");
      try {
        if (signedIn) {
          await bridge.signOutOfServer({});
        } else {
          await bridge.signInToServer({
            url: serverUrlInput.value,
            username: serverUsernameInput.value,
            password: serverPasswordInput.value,
          });
        }
        signedIn = !signedIn;
        serverPasswordInput.value = "";
        showServerStatus(signedIn ? "✓ Signed in" : "");
        isConfigured = (await bridge.getSetupState({})).configured;
        applyAuthVisibility();
        renderServer();
        window.dispatchEvent(new Event("tracking-changed"));
      } catch (err) {
        showServerStatus(err instanceof Error ? err.message : String(err), true);
      } finally {
        serverButton.disabled = false;
      }
    };
    serverButton.addEventListener("click", submit);
    serverPasswordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void submit();
    });
  }

  const resetBtn = document.querySelector<HTMLButtonElement>("#reset-all-btn");
  if (resetBtn) {
    let confirmPending = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;

    resetBtn.addEventListener("click", async () => {
      if (!confirmPending) {
        confirmPending = true;
        resetBtn.textContent = "Click again to reset";
        resetBtn.classList.add("btn-danger-confirm");
        confirmTimer = setTimeout(() => {
          confirmPending = false;
          resetBtn.textContent = "Reset…";
          resetBtn.classList.remove("btn-danger-confirm");
        }, 3000);
        return;
      }

      if (confirmTimer) clearTimeout(confirmTimer);
      confirmPending = false;
      resetBtn.classList.remove("btn-danger-confirm");
      localStorage.clear();

      try {
        await bridge.clearStoredApiKey({});
      } catch (err) {
        console.error("clearStoredApiKey failed:", err);
      }

      isConfigured = false;
      applyAuthVisibility();
      bridge.closeApp({});
    });
  }
}
