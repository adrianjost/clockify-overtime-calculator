import { bridge } from "./bridge.ts";

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
    closeBtn.addEventListener("click", () => {
      onCancel?.();
    });
  }

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

  let hasStoredApiKey = false;
  const applyAuthVisibility = () => {
    if (dangerZone) {
      dangerZone.style.display = hasStoredApiKey ? "" : "none";
    }
    if (closeBtn) {
      closeBtn.hidden = !hasStoredApiKey;
    }
    if (trayEnabledGroup) {
      trayEnabledGroup.hidden = !hasStoredApiKey;
    }
    if (launchAtLoginGroup) {
      launchAtLoginGroup.hidden = !hasStoredApiKey;
    }
  };

  applyAuthVisibility();

  void (async () => {
    try {
      const state = await bridge.getStoredApiKey({});
      const secureApiKey = (state?.apiKey ?? "").trim();
      if (secureApiKey) {
        apiKeyInput.value = secureApiKey;
        hasStoredApiKey = true;
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

  // Auto-save API key on input change
  apiKeyInput.addEventListener("change", async () => {
    const value = apiKeyInput.value.trim();
    if (value) {
      try {
        await bridge.setStoredApiKey({ apiKey: value });
        hasStoredApiKey = true;
        applyAuthVisibility();
        saveStatus.textContent = "✓ Saved";
        saveStatus.style.color = "#0e7c66";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 1000);
      } catch (err) {
        console.error("setStoredApiKey failed:", err);
        saveStatus.textContent = "Failed to save API key";
        saveStatus.style.color = "#b42318";
        setTimeout(() => {
          saveStatus.textContent = "";
        }, 2000);
      }
    }
  });

  const resetBtn = document.querySelector<HTMLButtonElement>("#reset-all-btn");
  if (resetBtn) {
    let confirmPending = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;

    resetBtn.addEventListener("click", async () => {
      if (!confirmPending) {
        confirmPending = true;
        resetBtn.textContent = "Click again to confirm";
        resetBtn.classList.add("btn-danger-confirm");
        confirmTimer = setTimeout(() => {
          confirmPending = false;
          resetBtn.textContent = "Reset all stored data";
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

      hasStoredApiKey = false;
      applyAuthVisibility();
      bridge.closeApp({});
    });
  }
}
