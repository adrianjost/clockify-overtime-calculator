import type { RPCSchema } from "electrobun/bun";
import type { OvertimeData } from "../bun/report.ts";

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      analyzeOvertime: {
        params: {
          apiKey: string;
          startDate: string;
          endDate: string;
        };
        response: OvertimeData;
      };
      closeApp: {
        params: {};
        response: void;
      };
      setLaunchAtLogin: {
        params: { enabled: boolean };
        response: void;
      };
      setTrayEnabled: {
        params: { enabled: boolean };
        response: void;
      };
      getTrayEnabled: {
        params: {};
        response: { enabled: boolean };
      };
      setOvertimeStartDate: {
        params: { startDate?: string };
        response: void;
      };
      getOvertimeStartDate: {
        params: {};
        response: { startDate?: string };
      };
      setStoredApiKey: {
        params: { apiKey: string };
        response: void;
      };
      getStoredApiKey: {
        params: {};
        response: { apiKey: string | null };
      };
      clearStoredApiKey: {
        params: {};
        response: void;
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
