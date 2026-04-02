import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  ContextMenu,
  Screen,
  Tray,
  Utils,
} from "electrobun/bun";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchActiveUser, fetchYear } from "./clockify.ts";
import { buildOvertimeData } from "./report.ts";
import type { AppRPC } from "../shared/rpc.ts";
import type { OvertimeData } from "./report.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const HOME = Bun.env["HOME"] ?? process.cwd();

const WINDOW_MARGIN = 24;
const MIN_WINDOW_WIDTH = 400;
const MIN_WINDOW_HEIGHT = 450;

const WINDOW_STATE_DIR = join(HOME, ".clockify-overtime");
const WINDOW_STATE_FILE = join(WINDOW_STATE_DIR, "window-state.json");
const PREFERENCES_FILE = join(WINDOW_STATE_DIR, "preferences.json");
const AT_LOGIN_SENTINEL = join(WINDOW_STATE_DIR, "at-login");
const KEYCHAIN_SERVICE = "dev.adrianjost.clockify-overtime";
const KEYCHAIN_ACCOUNT = "clockify-api-key";

const LAUNCH_AGENT_LABEL = "dev.adrianjost.clockify-overtime";
const LAUNCH_AGENT_PLIST = join(HOME, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);

// Timeouts and intervals
const SENTINEL_FILE_FRESHNESS_MS = 30_000; // 30 seconds
const FETCH_INTERVAL_MS = 60 * 1000; // 1 minute
const WINDOW_CLAMP_DEBOUNCE_MS = 120; // 120ms
const WINDOW_PERSIST_DEBOUNCE_MS = 200; // 200ms

// ─── Startup detection ────────────────────────────────────────────────────────
// The LaunchAgent creates the sentinel file right before opening the app.
// If it exists and is < 30 s old we know this is a background auto-launch.
function isAutoLaunch(): boolean {
  try {
    if (!existsSync(AT_LOGIN_SENTINEL)) return false;
    const { mtimeMs } = statSync(AT_LOGIN_SENTINEL);
    const fresh = Date.now() - mtimeMs < SENTINEL_FILE_FRESHNESS_MS;
    unlinkSync(AT_LOGIN_SENTINEL);
    return fresh;
  } catch {
    return false;
  }
}

const startInBackground = isAutoLaunch();

// ─── Window state helpers ─────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadStoredWindowSize(workArea: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const fallback = { width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT };
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
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ width, height }, null, 2), "utf8");
  } catch {
    // Best effort persistence.
  }
}

function loadPreferences(): { trayEnabled: boolean; startDate?: string } {
  try {
    const raw = readFileSync(PREFERENCES_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<{
      trayEnabled: boolean;
      startDate?: string;
    }>;
    return {
      trayEnabled: parsed.trayEnabled !== false,
      startDate: parsed.startDate,
    };
  } catch {
    return { trayEnabled: true };
  }
}

function persistPreferences(preferences: { trayEnabled: boolean; startDate?: string }): void {
  try {
    mkdirSync(WINDOW_STATE_DIR, { recursive: true });
    writeFileSync(PREFERENCES_FILE, JSON.stringify(preferences, null, 2), "utf8");
  } catch {
    // Best effort persistence.
  }
}

function runSecurityCommand(args: string[]): {
  ok: boolean;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ["security", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    ok: proc.exitCode === 0,
    stdout: decoder.decode(proc.stdout).trim(),
    stderr: decoder.decode(proc.stderr).trim(),
  };
}

function loadStoredApiKeyFromKeychain(): string | null {
  const result = runSecurityCommand([
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (!result.ok) {
    return null;
  }
  return result.stdout || null;
}

function persistStoredApiKeyToKeychain(apiKey: string): void {
  const trimmed = apiKey.trim();
  const result = runSecurityCommand([
    "add-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    trimmed,
    "-U",
  ]);
  if (!result.ok) {
    throw new Error(result.stderr || "Failed to store API key in Keychain.");
  }
}

function clearStoredApiKeyFromKeychain(): void {
  runSecurityCommand(["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE]);
}

function loadStoredApiKey(): string | null {
  try {
    return loadStoredApiKeyFromKeychain();
  } catch {
    console.error("Failed to load API key from Keychain");
    return null;
  }
}

function persistStoredApiKey(apiKey: string): void {
  try {
    persistStoredApiKeyToKeychain(apiKey);
  } catch (err) {
    console.error("Failed to persist API key:", err);
    throw new Error("Could not securely store API key.");
  }
}

function clearStoredApiKey(): void {
  try {
    clearStoredApiKeyFromKeychain();
  } catch (err) {
    console.error("Failed to clear API key from Keychain:", err);
  }
}

// ─── LaunchAgent helpers ──────────────────────────────────────────────────────

function buildPlistXML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>mkdir -p "${WINDOW_STATE_DIR}" &amp;&amp; touch "${AT_LOGIN_SENTINEL}" &amp;&amp; open -b "${LAUNCH_AGENT_LABEL}"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

async function enableLaunchAtLogin(): Promise<void> {
  try {
    mkdirSync(join(HOME, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(LAUNCH_AGENT_PLIST, buildPlistXML(), "utf8");
    await Bun.$`launchctl load ${LAUNCH_AGENT_PLIST}`.quiet();
  } catch (err) {
    console.error("Failed to enable launch at login:", err);
    throw new Error("Could not enable launch at login.");
  }
}

async function disableLaunchAtLogin(): Promise<void> {
  try {
    await Bun.$`launchctl unload ${LAUNCH_AGENT_PLIST}`.quiet().nothrow();
    if (existsSync(LAUNCH_AGENT_PLIST)) {
      unlinkSync(LAUNCH_AGENT_PLIST);
    }
  } catch (err) {
    console.error("Failed to disable launch at login:", err);
  }
}

// ─── Tray helpers ─────────────────────────────────────────────────────────────

const TRAY_MENU_ITEMS = [
  { type: "normal", label: "Open Clockify Overtime", action: "open" },
  { type: "separator" },
  { type: "normal", label: "Quit", action: "quit" },
] as const;

function formatTrayTitle(data: OvertimeData): string {
  const totalMinutes = data.totalOvertimeHours * 60 + data.totalOvertimeMinutes;
  const sign = totalMinutes >= 0 ? "+" : "-";
  const absMinutes = Math.abs(totalMinutes);
  const h = Math.floor(absMinutes / 60);
  const m = absMinutes % 60;
  return m > 0 ? `${sign}${h}h ${m}m` : `${sign}${h}h`;
}

// ─── State ────────────────────────────────────────────────────────────────────

let mainWindowId: number | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let clampTimer: ReturnType<typeof setTimeout> | null = null;
const preferences = loadPreferences();
let trayEnabled = preferences.trayEnabled;
let overtimeStartDate = preferences.startDate;
let trayTitle = "--";
let tray: Tray | null = null;

let currentOvertimeData: OvertimeData | null = null;
let trayUpdateInterval: ReturnType<typeof setInterval> | null = null;

// Calculate current API key and year for background updates
let currentApiKey: string | null = null;

function setDockVisible(visible: boolean) {
  try {
    Utils.setDockIconVisible(visible);
  } catch {
    // Best effort. If unsupported on this platform/runtime, ignore.
  }
}

function isRightClickAction(action: string): boolean {
  const normalized = action.toLowerCase();
  return (
    normalized === "right" ||
    normalized === "right-click" ||
    normalized === "secondary" ||
    normalized === "secondary-click" ||
    normalized === "menu"
  );
}

function isRightMouseButtonDown(): boolean {
  // macOS pressedMouseButtons bitmask: left=1<<0, right=1<<1.
  try {
    const buttons = Screen.getMouseButtons();
    return (buttons & 0b10n) !== 0n;
  } catch {
    return false;
  }
}

function showTrayContextMenu() {
  ContextMenu.showContextMenu([...TRAY_MENU_ITEMS]);
}

ContextMenu.on("context-menu-clicked", (event: unknown) => {
  const action = (event as { data?: { action?: string } })?.data?.action ?? "";
  if (action === "quit") {
    process.exit(0);
    return;
  }
  if (action === "open") {
    openMainWindow();
  }
});

function createTray() {
  if (tray) return;

  tray = new Tray({ title: trayTitle });
  tray.setMenu([...TRAY_MENU_ITEMS]);

  tray.on("tray-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: string } })?.data?.action ?? "";

    if (action === "quit") {
      process.exit(0);
      return;
    }

    if (action === "open") {
      openMainWindow();
      return;
    }

    // Some Electrobun/macOS builds emit empty action for both icon click types,
    // so we also inspect mouse button state as a fallback.
    if (isRightClickAction(action) || isRightMouseButtonDown()) {
      showTrayContextMenu();
      return;
    }

    // Default tray icon click path: open immediately
    openMainWindow();
  });
}

function setTrayEnabled(enabled: boolean) {
  trayEnabled = enabled;
  persistPreferences({ trayEnabled, startDate: overtimeStartDate });

  if (trayEnabled) {
    createTray();
    if (currentApiKey) {
      startTrayUpdateIntervals();
    }
  } else {
    stopTrayUpdateIntervals();
    if (tray) {
      tray.remove();
      tray = null;
    }
  }
}

async function analyzeAndUpdateTray(
  apiKey: string,
  startDate: string,
  endDate: string,
): Promise<OvertimeData> {
  const trimmedApiKey = apiKey.trim();
  if (trimmedApiKey.length === 0) {
    throw new Error("Please provide your Clockify API key.");
  }

  const startYear = Number.parseInt(startDate.slice(0, 4), 10);
  const endYear = Number.parseInt(endDate.slice(0, 4), 10);
  if (Number.isNaN(startYear) || startYear < 1970 || Number.isNaN(endYear) || endYear > 3000) {
    throw new Error("Please provide valid start and end dates.");
  }

  persistStoredApiKey(trimmedApiKey);

  const user = await fetchActiveUser(trimmedApiKey);

  // Fetch all years covered by the date range and merge into one map
  const mergedData = new Map<string, Temporal.Duration>();
  for (let year = startYear; year <= endYear; year++) {
    const dataOfYear = await fetchYear(trimmedApiKey, user.defaultWorkspace, user.id, year);
    for (const [date, duration] of dataOfYear) {
      mergedData.set(date, duration);
    }
  }

  const overtimeData = buildOvertimeData(mergedData, startDate, endDate);

  currentOvertimeData = overtimeData;

  trayTitle = formatTrayTitle(overtimeData);
  if (tray) {
    tray.setTitle(trayTitle);
  }

  return overtimeData;
}

async function refreshTrayDataOnLaunch(): Promise<void> {
  const apiKey = loadStoredApiKey();
  if (!apiKey) return;

  const today = new Date();
  const startDate = overtimeStartDate || `${today.getFullYear()}-01-01`;
  const endDate = today.toISOString().split("T")[0];

  try {
    await analyzeAndUpdateTray(apiKey, startDate, endDate);
    currentApiKey = apiKey;
    startTrayUpdateIntervals();
  } catch (err) {
    console.error("Launch-time tray refresh failed:", err);
  }
}

function startTrayUpdateIntervals(): void {
  if (!trayEnabled || !currentApiKey) return;

  if (trayUpdateInterval) clearInterval(trayUpdateInterval);

  // Fetch fresh data every minute
  trayUpdateInterval = setInterval(async () => {
    if (!currentApiKey || !trayEnabled) return;
    try {
      const now = new Date();
      const startDate = overtimeStartDate || `${now.getFullYear()}-01-01`;
      const endDate = now.toISOString().split("T")[0];
      await analyzeAndUpdateTray(currentApiKey, startDate, endDate);
    } catch (err) {
      console.error("Background tray update failed:", err);
    }
  }, FETCH_INTERVAL_MS);
}

function stopTrayUpdateIntervals(): void {
  if (trayUpdateInterval) {
    clearInterval(trayUpdateInterval);
    trayUpdateInterval = null;
  }
}

// ─── RPC ──────────────────────────────────────────────────────────────────────

const rpc = BrowserView.defineRPC<AppRPC>({
  handlers: {
    requests: {
      closeApp: async () => {
        if (mainWindowId !== null) {
          BrowserWindow.getById(mainWindowId)?.close();
        }
      },
      analyzeOvertime: async ({
        apiKey,
        startDate,
        endDate,
      }: {
        apiKey: string;
        startDate: string;
        endDate: string;
      }) => {
        const data = await analyzeAndUpdateTray(apiKey, startDate, endDate);
        currentApiKey = apiKey;
        // Sync UI's start date back to tray preferences so background interval uses same range
        overtimeStartDate = startDate;
        persistPreferences({ trayEnabled, startDate: overtimeStartDate });
        // Start background update intervals when user successfully analyzes
        if (trayEnabled) {
          startTrayUpdateIntervals();
        }
        return data;
      },

      setLaunchAtLogin: async ({ enabled }: { enabled: boolean }) => {
        if (enabled) {
          await enableLaunchAtLogin();
        } else {
          await disableLaunchAtLogin();
        }
      },
      setTrayEnabled: async ({ enabled }: { enabled: boolean }) => {
        setTrayEnabled(enabled);
      },
      getTrayEnabled: async () => {
        return { enabled: trayEnabled };
      },
      setOvertimeStartDate: async ({ startDate }: { startDate?: string }) => {
        console.log("[BUN] setOvertimeStartDate called with:", startDate);
        overtimeStartDate = startDate || undefined;
        persistPreferences({ trayEnabled, startDate: overtimeStartDate });
        console.log("[BUN] overtimeStartDate updated to:", overtimeStartDate);
      },
      getOvertimeStartDate: async () => {
        console.log("[BUN] getOvertimeStartDate called, returning:", overtimeStartDate);
        return { startDate: overtimeStartDate };
      },
      setStoredApiKey: async ({ apiKey }: { apiKey: string }) => {
        persistStoredApiKey(apiKey);
      },
      getStoredApiKey: async () => {
        return { apiKey: loadStoredApiKey() };
      },
      clearStoredApiKey: async () => {
        clearStoredApiKey();
      },
    },
    messages: {},
  },
});

ApplicationMenu.setApplicationMenu([
  { submenu: [{ label: "Quit", role: "quit" }] },
  {
    label: "Edit",
    submenu: [
      { label: "Cut", role: "cut" },
      { label: "Copy", role: "copy" },
      { label: "Paste", role: "paste" },
      { label: "Select All", role: "selectAll" },
    ],
  },
]);

// ─── Window management ────────────────────────────────────────────────────────

function createMainWindow(hidden: boolean): BrowserWindow {
  const primaryDisplay = Screen.getPrimaryDisplay();
  const windowSize = loadStoredWindowSize(primaryDisplay.workArea);

  const win = new BrowserWindow({
    title: "Clockify Overtime",
    url: "views://mainview/index.html",
    rpc,
    renderer: "cef",
    hidden,
    frame: {
      width: windowSize.width,
      height: windowSize.height,
      x:
        primaryDisplay.workArea.x +
        Math.max(0, primaryDisplay.workArea.width - windowSize.width - WINDOW_MARGIN),
      y: primaryDisplay.workArea.y + WINDOW_MARGIN,
    },
  });

  mainWindowId = win.id;
  setDockVisible(!hidden);

  win.on("resize", (event: unknown) => {
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

    if (clampTimer) clearTimeout(clampTimer);

    // Electrobun currently has no native min-size API. Apply a delayed clamp so
    // the user doesn't see continuous snap-back flicker while dragging smaller.
    clampTimer = setTimeout(() => {
      const current = win.getSize();
      const width = Math.max(MIN_WINDOW_WIDTH, Math.floor(current.width));
      const height = Math.max(MIN_WINDOW_HEIGHT, Math.floor(current.height));
      if (width !== current.width || height !== current.height) {
        win.setSize(width, height);
      }
      clampTimer = null;
    }, WINDOW_CLAMP_DEBOUNCE_MS);

    if (persistTimer) clearTimeout(persistTimer);

    persistTimer = setTimeout(() => {
      persistWindowSize(clampedWidth, clampedHeight);
      persistTimer = null;
    }, WINDOW_PERSIST_DEBOUNCE_MS);
  });

  win.on("close", () => {
    const { width, height } = win.getSize();
    persistWindowSize(width, height);
    mainWindowId = null;
    setDockVisible(false);
    if (!trayEnabled) {
      process.exit(0);
    }
  });

  return win;
}

function openMainWindow(): void {
  if (mainWindowId !== null) {
    const win = BrowserWindow.getById(mainWindowId);
    if (win) {
      setDockVisible(true);
      win.unminimize();
      win.show();
      return;
    }
  }
  createMainWindow(false);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

if (trayEnabled) {
  createTray();
}

if (startInBackground && trayEnabled) {
  void refreshTrayDataOnLaunch();
}

setDockVisible(!(startInBackground && trayEnabled));
createMainWindow(startInBackground && trayEnabled);
