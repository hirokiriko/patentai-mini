import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { Agent, getGlobalDispatcher, type Dispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { AiSourceDispatcher } from "./ai-source-dispatcher";

async function fixture(bodyDelay = false) {
  const sockets = new Set<Socket>(); let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    const payload = JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 }, text: "原文".repeat(65536) });
    if (bodyDelay) { res.writeHead(200, { "content-type": "application/json" }); res.write(payload.slice(0, 20)); }
    const timer = setTimeout(() => { if (!bodyDelay) res.writeHead(200, { "content-type": "application/json" }); res.end(bodyDelay ? payload.slice(20) : payload); }, 1200);
    res.on("close", () => clearTimeout(timer));
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("loopback_address");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests, sockets,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => (server as Server).close(error => error ? reject(error) : resolve())); } };
}
function init(dispatcher: Pick<Dispatcher, "dispatch">, signal?: AbortSignal): RequestInit {
  return { dispatcher, signal, redirect: "error" } as RequestInit;
}
async function waitClosed(sockets: Set<Socket>) {
  for (let n = 0; sockets.size && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(sockets.size).toBe(0);
}

describe("source request owned native HTTP transport (loopback only)", () => {
  it.each([false, true])("overrides shorter dispatch options for delayed %s and releases its sockets", async bodyDelay => {
    const f = await fixture(bodyDelay), shared = getGlobalDispatcher();
    class ShortBaseline extends Agent {
      override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        return super.dispatch({ ...options, headersTimeout: 20, bodyTimeout: 20 }, handler);
      }
    }
    const baseline = new ShortBaseline();
    const owned = new AiSourceDispatcher(2500); let dispatches = 0;
    try {
      await expect((async () => { const response = await fetch(f.url, init(baseline)); await response.text(); })()).rejects.toThrow();
      await baseline.destroy();
      const shorterOptions = { dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) {
        dispatches++;
        return owned.dispatch({ ...options, headersTimeout: 20, bodyTimeout: 20 }, handler);
      } };
      const response = await fetch(f.url, init(shorterOptions));
      const validated = await response.clone().json();
      await owned.destroy();
      expect(await response.json()).toEqual(validated);
      expect(validated.text).toBe("原文".repeat(65536));
      expect(dispatches).toBe(1); expect(f.requests()).toBe(2);
      expect(getGlobalDispatcher()).toBe(shared);
      await waitClosed(f.sockets);
    } finally { await baseline.destroy(); await owned.destroy(); await f.close(); }
  });
  it.each([false, true])("absolute abort ends delayed %s without retry or leaked sockets", async bodyDelay => {
    const f = await fixture(bodyDelay), shared = getGlobalDispatcher(), owned = new AiSourceDispatcher(2500);
    let dispatches = 0;
    const dispatcher = { dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) { dispatches++; return owned.dispatch(options, handler); } };
    try {
      await expect((async () => { const response = await fetch(f.url, init(dispatcher, AbortSignal.timeout(35))); await response.clone().json(); })()).rejects.toThrow();
      await owned.destroy(); await waitClosed(f.sockets);
      expect(dispatches).toBe(1); expect(f.requests()).toBe(1);
      expect(getGlobalDispatcher()).toBe(shared);
    } finally { await owned.destroy(); await f.close(); }
  });
});
