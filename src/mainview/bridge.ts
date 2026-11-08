import type { AppRequests } from "../shared/rpc.ts";

declare global {
  interface Window {
    webkit: {
      messageHandlers: {
        rpc: { postMessage(message: unknown): Promise<string | null> };
      };
    };
  }
}

export type Bridge = {
  [Method in keyof AppRequests]: (
    params: AppRequests[Method]["params"],
  ) => Promise<AppRequests[Method]["response"]>;
};

export const bridge = new Proxy({} as Bridge, {
  get: (_, method) => async (params: unknown) => {
    const result = await window.webkit.messageHandlers.rpc.postMessage({ method, params });
    return result == null ? undefined : JSON.parse(result);
  },
});
