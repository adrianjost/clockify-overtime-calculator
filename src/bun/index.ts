import {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  Screen,
} from "electrobun/bun";
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

const WINDOW_WIDTH = 980;
const WINDOW_HEIGHT = 525;
const WINDOW_MARGIN = 24;
const primaryDisplay = Screen.getPrimaryDisplay();

new BrowserWindow({
  title: "Clockify Overtime",
  url: "views://mainview/index.html",
  rpc,
  frame: {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x:
      primaryDisplay.workArea.x +
      Math.max(0, primaryDisplay.workArea.width - WINDOW_WIDTH - WINDOW_MARGIN),
    y: primaryDisplay.workArea.y + WINDOW_MARGIN,
  },
});
