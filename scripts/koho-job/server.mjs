import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import next from "next";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_TIMEOUT_MS = 120 * 60 * 1_000;
const SHUTDOWN_TIMEOUT_MS = 4_000;

function parseInteger(raw, minimum, maximum) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new Error("invalid_loopback_config");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("invalid_loopback_config");
  }
  return value;
}

export function readLoopbackServerConfig(environment = process.env) {
  if (environment.NODE_ENV !== "production") {
    throw new Error("invalid_loopback_config");
  }
  return Object.freeze({
    host: LOOPBACK_HOST,
    port: parseInteger(environment.PORT, 1_024, 65_535),
    requestTimeoutMilliseconds: parseInteger(
      environment.KOHO_LOOPBACK_REQUEST_TIMEOUT_MS,
      1,
      MAX_REQUEST_TIMEOUT_MS,
    ),
  });
}

export function createLoopbackHttpServer(
  requestHandler,
  requestTimeoutMilliseconds,
) {
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(() => requestHandler(request, response))
      .catch(() => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end();
        } else {
          response.destroy();
        }
      });
  });
  server.requestTimeout = requestTimeoutMilliseconds;
  return server;
}

function listen(server, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = () => rejectPromise(new Error("loopback_start_failed"));
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(new Error("loopback_close_failed"));
      } else {
        resolvePromise();
      }
    });
  });
}

function withinShutdownDeadline(operation) {
  let deadline;
  const timedOut = new Promise((_, rejectPromise) => {
    deadline = setTimeout(
      () => rejectPromise(new Error("loopback_close_failed")),
      SHUTDOWN_TIMEOUT_MS,
    );
  });
  return Promise.race([
    Promise.resolve().then(operation),
    timedOut,
  ]).finally(() => clearTimeout(deadline));
}

function cleanupResources(application, server, closeServer) {
  return withinShutdownDeadline(async () => {
    const cleanups = [];
    if (server !== null) {
      cleanups.push(Promise.resolve().then(() => closeServer(server)));
    }
    if (application !== null && typeof application.close === "function") {
      cleanups.push(Promise.resolve().then(() => application.close()));
    }
    const outcomes = await Promise.allSettled(cleanups);
    if (outcomes.some((outcome) => outcome.status === "rejected")) {
      throw new Error("loopback_close_failed");
    }
  });
}

export async function startLoopbackServer(
  environment = process.env,
  createNextApplication = next,
  dependencies = {},
) {
  const config = readLoopbackServerConfig(environment);
  const createHttpServer =
    dependencies.createHttpServer ?? createLoopbackHttpServer;
  const listenServer = dependencies.listen ?? listen;
  const closeServer = dependencies.close ?? close;
  let application = null;
  let server = null;

  try {
    application = createNextApplication({
      dev: false,
      hostname: LOOPBACK_HOST,
      port: config.port,
    });
    await application.prepare();
    const requestHandler = application.getRequestHandler();
    server = createHttpServer(
      requestHandler,
      config.requestTimeoutMilliseconds,
    );
    await listenServer(server, config.port);
  } catch (error) {
    await cleanupResources(application, server, closeServer).catch(
      () => undefined,
    );
    throw error;
  }

  let closing = null;
  return Object.freeze({
    config,
    server,
    close() {
      if (closing === null) {
        closing = cleanupResources(application, server, closeServer);
      }
      return closing;
    },
  });
}

async function main() {
  let runtime;
  try {
    runtime = await startLoopbackServer();
  } catch {
    process.exitCode = 1;
    return;
  }

  let shutdownStarted = false;
  const shutdown = (exitCode = 0) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const hardExit = setTimeout(
      () => process.exit(1),
      SHUTDOWN_TIMEOUT_MS,
    );
    hardExit.unref?.();
    void runtime.close().then(
      () => {
        clearTimeout(hardExit);
        process.exit(exitCode);
      },
      () => {
        clearTimeout(hardExit);
        process.exit(1);
      },
    );
  };
  const onServerError = () => {
    shutdown(1);
  };
  const onSignal = () => shutdown(0);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  runtime.server.on("error", onServerError);
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  await main();
}
