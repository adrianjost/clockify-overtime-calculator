import type { Electroview } from "electrobun/view";

export function initializeSettings(
  electrobun: Electroview<any>,
  onSettingsSaved: () => void,
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

  // Hide reset button during initial onboarding (no API key yet)
  const dangerZone = document.querySelector<HTMLElement>(
    ".settings-danger-zone",
  );
  if (dangerZone) {
    dangerZone.style.display = savedApiKey ? "" : "none";
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
