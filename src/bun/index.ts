import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Screen,
} from "electrobun/bun";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchActiveUser, fetchYear } from "./clockify.ts";
import { buildOvertimeData } from "./report.ts";
import type { AppRPC } from "../shared/rpc.ts";

const rpc = BrowserView.defineRPC<AppRPC>({
  handlers: {
    requests: {
      analyzeOvertime: async ({
        apiKey,
        year,
      }: {
        apiKey: string;
        year: number;
      }) => {
        const trimmedApiKey = apiKey.trim();
        if (trimmedApiKey.length === 0) {
          throw new Error("Please provide your Clockify API key.");
        }
        if (!Number.isInteger(year) || year < 1970 || year > 3000) {
          throw new Error("Please provide a valid year.");
        }

        const user = await fetchActiveUser(trimmedApiKey);
        const dataOfYear = await fetchYear(
          trimmedApiKey,
          user.defaultWorkspace,
          user.id,
          year,
        );
        const overtimeData = buildOvertimeData(year, dataOfYear);

        return overtimeData;
      },
    },
    messages: {},
  },
});

ApplicationMenu.setApplicationMenu([
  { submenu: [{ label: "Quit", role: "quit" }] },
]);

const WINDOW_MARGIN = 24;
const MIN_WINDOW_WIDTH = 400;
const MIN_WINDOW_HEIGHT = 450;
const WINDOW_WIDTH = MIN_WINDOW_WIDTH;
const WINDOW_HEIGHT = MIN_WINDOW_HEIGHT;

const WINDOW_STATE_DIR = join(
  Bun.env["HOME"] ?? process.cwd(),
  ".clockify-overtime",
);
const WINDOW_STATE_FILE = join(WINDOW_STATE_DIR, "window-state.json");

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadStoredWindowSize(workArea: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const fallback = {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  };

  try {
    const raw = readFileSync(WINDOW_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<{
      width: number;
      height: number;
    }>;

    if (
      typeof parsed.width !== "number" ||
      !Number.isFinite(parsed.width) ||
      typeof parsed.height !== "number" ||
      !Number.isFinite(parsed.height)
    ) {
      return fallback;
    }

    return {
      width: clamp(parsed.width, MIN_WINDOW_WIDTH, workArea.width),
      height: clamp(parsed.height, MIN_WINDOW_HEIGHT, workArea.height),
    };
  } catch {
    return fallback;
  }
}

function persistWindowSize(width: number, height: number): void {
  try {
    mkdirSync(WINDOW_STATE_DIR, { recursive: true });
    writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ width, height }, null, 2),
      "utf8",
    );
  } catch {
    // Best effort persistence.
  }
}

const primaryDisplay = Screen.getPrimaryDisplay();
const windowSize = loadStoredWindowSize(primaryDisplay.workArea);

const mainWindow = new BrowserWindow({
  title: "Clockify Overtime",
  url: "views://mainview/index.html",
  rpc,
  renderer: "cef",
  frame: {
    width: windowSize.width,
    height: windowSize.height,
    x:
      primaryDisplay.workArea.x +
      Math.max(
        0,
        primaryDisplay.workArea.width - windowSize.width - WINDOW_MARGIN,
      ),
    y: primaryDisplay.workArea.y + WINDOW_MARGIN,
  },
});

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let clampTimer: ReturnType<typeof setTimeout> | null = null;

mainWindow.on("resize", (event: unknown) => {
  const data = (event as { data?: { width?: number; height?: number } })?.data;

  if (
    typeof data?.width !== "number" ||
    !Number.isFinite(data.width) ||
    typeof data?.height !== "number" ||
    !Number.isFinite(data.height)
  ) {
    return;
  }

  const clampedWidth = Math.max(MIN_WINDOW_WIDTH, Math.floor(data.width));
  const clampedHeight = Math.max(MIN_WINDOW_HEIGHT, Math.floor(data.height));

  if (clampTimer) {
    clearTimeout(clampTimer);
  }

  // Electrobun currently has no native min-size API. Apply a delayed clamp so
  // the user doesn't see continuous snap-back flicker while dragging smaller.
  clampTimer = setTimeout(() => {
    const current = mainWindow.getSize();
    const width = Math.max(MIN_WINDOW_WIDTH, Math.floor(current.width));
    const height = Math.max(MIN_WINDOW_HEIGHT, Math.floor(current.height));
    if (width !== current.width || height !== current.height) {
      mainWindow.setSize(width, height);
    }
    clampTimer = null;
  }, 120);

  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistWindowSize(clampedWidth, clampedHeight);
    persistTimer = null;
  }, 200);
});

mainWindow.on("close", () => {
  const { width, height } = mainWindow.getSize();
  persistWindowSize(width, height);
});
