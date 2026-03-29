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
}
