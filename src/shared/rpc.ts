export interface OvertimeData {
  totalOvertimeHours: number;
  totalOvertimeMinutes: number;
  dailyData: Array<{
    date: string;
    actualHours: number;
    expectedHours: number;
    cumulativeOvertimeHours: number;
  }>;
}

export type DataSource = "clockify" | "server";

/** An entry on the self-hosted time tracking server; ISO 8601 times, `end` null while running. */
export interface TrackedEntry {
  id: string;
  start: string;
  end: string | null;
}

// Requests handled by the native app, see macos/ClockifyOvertime/App/AppController.swift.
export type AppRequests = {
  analyzeOvertime: {
    params: { apiKey: string; startDate: string; endDate: string };
    response: OvertimeData;
  };
  closeApp: { params: {}; response: void };
  getSetupState: {
    params: {};
    response: { dataSource: DataSource | null; configured: boolean; tracking: boolean };
  };
  setDataSource: { params: { dataSource: DataSource }; response: void };
  getServerSettings: {
    params: {};
    response: { url: string | null; username: string | null; signedIn: boolean };
  };
  signInToServer: { params: { url: string; username: string; password: string }; response: void };
  signOutOfServer: { params: {}; response: void };
  getTimer: { params: {}; response: { running: TrackedEntry | null } };
  startTimer: { params: {}; response: { running: TrackedEntry | null } };
  stopTimer: { params: {}; response: { running: TrackedEntry | null } };
  discardTimer: { params: {}; response: { running: TrackedEntry | null } };
  listEntries: { params: { startDate: string; endDate: string }; response: TrackedEntry[] };
  saveEntry: {
    params: { id?: string; start: string; end: string | null };
    response: TrackedEntry;
  };
  deleteEntry: { params: { id: string }; response: void };
  setContentMaxHeight: { params: { height: number }; response: void };
  getLaunchAtLogin: { params: {}; response: { enabled: boolean } };
  setLaunchAtLogin: { params: { enabled: boolean }; response: void };
  getTrayEnabled: { params: {}; response: { enabled: boolean } };
  setTrayEnabled: { params: { enabled: boolean }; response: void };
  getStoredApiKey: { params: {}; response: { apiKey: string | null } };
  setStoredApiKey: { params: { apiKey: string }; response: void };
  clearStoredApiKey: { params: {}; response: void };
};
