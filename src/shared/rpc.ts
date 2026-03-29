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
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};
