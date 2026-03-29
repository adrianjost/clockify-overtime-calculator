import type { Electroview } from "electrobun/view";

export function initializeSettings(
  electrobun: Electroview<any>,
  onSettingsSaved: () => void,
  onCancel?: () => void,
) {
  const form = document.querySelector<HTMLFormElement>("#settings-form");
  const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key");
  const saveStatus = document.querySelector<HTMLSpanElement>("#save-status");

  if (!form || !apiKeyInput || !saveStatus) {
    throw new Error("Settings form elements are missing");
  }

  // Load persisted API key
  const savedApiKey = localStorage.getItem("clockify_api_key");
  if (savedApiKey) {
    apiKeyInput.value = savedApiKey;
  }

  // Hide reset button, close button, and launch-at-login during initial onboarding
  const dangerZone = document.querySelector<HTMLElement>(
    ".settings-danger-zone",
  );
  if (dangerZone) {
    dangerZone.style.display = savedApiKey ? "" : "none";
  }

  const closeBtn = document.querySelector<HTMLButtonElement>(
    "#close-settings-btn",
  );
  if (closeBtn) {
    if (savedApiKey) {
      closeBtn.hidden = false;
    }
    closeBtn.addEventListener("click", () => {
      onCancel?.();
    });
  }

  // Tray visibility toggle — only shown when API key already exists
  const trayEnabledGroup = document.querySelector<HTMLElement>(
    "#tray-enabled-group",
  );
  const trayEnabledCheckbox =
    document.querySelector<HTMLInputElement>("#tray-enabled");
  if (trayEnabledGroup && trayEnabledCheckbox) {
    if (savedApiKey) {
      trayEnabledGroup.hidden = false;
      trayEnabledCheckbox.checked =
        localStorage.getItem("tray_enabled") !== "false";
      (async () => {
        try {
          const state = await (electrobun as any).rpc.request.getTrayEnabled(
            {},
          );
          const enabled = Boolean(state?.enabled);
          trayEnabledCheckbox.checked = enabled;
          localStorage.setItem("tray_enabled", String(enabled));
        } catch (err) {
          console.error("getTrayEnabled failed:", err);
        }
      })();
    }

    trayEnabledCheckbox.addEventListener("change", async () => {
      const enabled = trayEnabledCheckbox.checked;
      localStorage.setItem("tray_enabled", String(enabled));
      try {
        await (electrobun as any).rpc.request.setTrayEnabled({ enabled });
      } catch (err) {
        console.error("setTrayEnabled failed:", err);
        trayEnabledCheckbox.checked = !enabled;
        localStorage.setItem("tray_enabled", String(!enabled));
      }
    });
  }

  // Launch at login toggle — only shown when API key already exists
  const launchAtLoginGroup = document.querySelector<HTMLElement>(
    "#launch-at-login-group",
  );
  const launchAtLoginCheckbox =
    document.querySelector<HTMLInputElement>("#launch-at-login");
  if (launchAtLoginGroup && launchAtLoginCheckbox) {
    if (savedApiKey) {
      launchAtLoginGroup.hidden = false;
      launchAtLoginCheckbox.checked =
        localStorage.getItem("launch_at_login") === "true";
    }
    launchAtLoginCheckbox.addEventListener("change", async () => {
      const enabled = launchAtLoginCheckbox.checked;
      localStorage.setItem("launch_at_login", String(enabled));
      try {
        await (electrobun as any).rpc.request.setLaunchAtLogin({ enabled });
      } catch (err) {
        console.error("setLaunchAtLogin failed:", err);
        // Revert checkbox on failure
        launchAtLoginCheckbox.checked = !enabled;
        localStorage.setItem("launch_at_login", String(!enabled));
      }
    });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (apiKeyInput.value.trim()) {
      localStorage.setItem("clockify_api_key", apiKeyInput.value);
      saveStatus.textContent = "✓ Saved";
      saveStatus.style.color = "#0e7c66";

      setTimeout(() => {
        saveStatus.textContent = "";
        onSettingsSaved();
      }, 1000);
    }
  });

  const resetBtn = document.querySelector<HTMLButtonElement>("#reset-all-btn");
  if (resetBtn) {
    let confirmPending = false;
    let confirmTimer: ReturnType<typeof setTimeout> | null = null;

    resetBtn.addEventListener("click", () => {
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
      (electrobun as any).rpc.request.closeApp({});
    });
  }
}
