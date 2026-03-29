import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/rpc.ts";

const rpc = Electroview.defineRPC<AppRPC>({
  handlers: {
    requests: {},
    messages: {},
  },
});

const electrobun = new Electroview({ rpc });

const form = document.querySelector<HTMLFormElement>("#analyze-form");
const apiKeyInput = document.querySelector<HTMLInputElement>("#api-key");
const yearInput = document.querySelector<HTMLInputElement>("#year");
const output = document.querySelector<HTMLPreElement>("#output");
const status = document.querySelector<HTMLSpanElement>("#status");
const button = document.querySelector<HTMLButtonElement>("#analyze-button");

if (!form || !apiKeyInput || !yearInput || !output || !status || !button) {
  throw new Error("Required UI elements are missing.");
}

yearInput.value = new Date().getFullYear().toString();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const year = Number.parseInt(yearInput.value, 10);
  if (Number.isNaN(year)) {
    status.textContent = "Please enter a valid year.";
    return;
  }

  status.textContent = "Running analysis...";
  button.disabled = true;

  try {
    const result = await electrobun.rpc.request.analyzeOvertime({
      apiKey: apiKeyInput.value,
      year,
    });
    output.textContent = result.output;
    status.textContent = "Done.";
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    output.textContent = "";
    status.textContent = `Error: ${message}`;
  } finally {
    button.disabled = false;
  }
});
