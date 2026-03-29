import { ApplicationMenu, BrowserView, BrowserWindow } from "electrobun/bun";
import { fetchActiveUser, fetchYear } from "./clockify.ts";
import { buildOvertimeData } from "./report.ts";
import type { AppRPC } from "../shared/rpc.ts";

const rpc = BrowserView.defineRPC<AppRPC>({
	handlers: {
		requests: {
			analyzeOvertime: async ({ apiKey, year }: { apiKey: string; year: number }) => {
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
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "pasteAndMatchStyle" },
      { role: "delete" },
      { role: "selectAll" },
    ],
  },
]);

new BrowserWindow({
  title: "Clockify Overtime",
  url: "views://mainview/index.html",
  rpc,
  frame: {
    width: 980,
    height: 760,
    x: 120,
    y: 80,
  },
});
