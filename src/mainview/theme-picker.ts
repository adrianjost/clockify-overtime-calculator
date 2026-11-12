import type { Theme } from "../shared/rpc.ts";

/** Checks the current theme in the settings and reports when another one is picked. */
export function initializeThemePicker(current: Theme, onChange: (theme: Theme) => void) {
  for (const input of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[name="theme"]'),
  )) {
    input.checked = input.value === current;
    input.addEventListener("change", () => {
      if (input.checked) onChange(input.value as Theme);
    });
  }
}
