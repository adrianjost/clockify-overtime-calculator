import type { RPCSchema } from "electrobun/bun";
import type { OvertimeData } from "../bun/report.ts";

export type AppRPC = {
  bun: RPCSchema<{
    requests: {
      analyzeOvertime: {
        params: {
          apiKey: string;
          year: number;
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
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
