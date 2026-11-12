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

/** Sends a request and returns its response; the web UI replaces the native app with HTTP. */
export type Transport = (method: string, params: unknown) => Promise<unknown>;

let transport: Transport = async (method, params) => {
  const result = await window.webkit.messageHandlers.rpc.postMessage({ method, params });
  return result == null ? undefined : JSON.parse(result);
};

export function setTransport(replacement: Transport) {
  transport = replacement;
}

export const bridge = new Proxy({} as Bridge, {
  get: (_, method) => (params: unknown) => transport(String(method), params),
});
