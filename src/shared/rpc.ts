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

// Requests handled by the native app, see macos/ClockifyOvertime/App/AppController.swift.
export type AppRequests = {
  analyzeOvertime: {
    params: { apiKey: string; startDate: string; endDate: string };
    response: OvertimeData;
  };
  closeApp: { params: {}; response: void };
  getLaunchAtLogin: { params: {}; response: { enabled: boolean } };
  setLaunchAtLogin: { params: { enabled: boolean }; response: void };
  getTrayEnabled: { params: {}; response: { enabled: boolean } };
  setTrayEnabled: { params: { enabled: boolean }; response: void };
  getStoredApiKey: { params: {}; response: { apiKey: string | null } };
  setStoredApiKey: { params: { apiKey: string }; response: void };
  clearStoredApiKey: { params: {}; response: void };
};
