import type { ProcessRuntime } from "../../../src/process-runtime.js";
import type { NetConnect } from "waffle/browser/net/outbound";
import type { BunRelayOptions } from "./helper.js";

interface RelayClient {
  readonly carrier: "webtransport" | "websocket" | null;
  connect: NetConnect;
  close(): Promise<void>;
}

interface RuntimeRelay {
  readonly connect: NetConnect;
}

interface RuntimeRelayState extends RuntimeRelay {
  close(): Promise<void>;
}

const owners = new WeakMap<ProcessRuntime, Promise<RuntimeRelayState>>();

export function runtimeRelay(
  runtime: ProcessRuntime,
  options: BunRelayOptions | undefined,
): Promise<RuntimeRelayState | undefined> {
  if (!options) return Promise.resolve(undefined);
  const existing = owners.get(runtime);
  if (existing) return existing;
  const pending = createRuntimeRelay(runtime, options);
  owners.set(runtime, pending);
  void pending.catch(() => {
    if (owners.get(runtime) === pending) owners.delete(runtime);
  });
  return pending;
}

async function createRuntimeRelay(
  runtime: ProcessRuntime,
  options: BunRelayOptions,
): Promise<RuntimeRelayState> {
  const identity = runtime.filesystem.createIdentity();
  let release: (() => void) | undefined;
  let client: RelayClient | undefined;
  let closing: Promise<void> | undefined;
  try {
    release = runtime.retainConsumer({
      filesystem: identity,
      revoke: () => { void close(); },
      stop: () => close(),
    });
    const { onCarrier, ...clientOptions } = options;
    const { createRelayConnect } = await import("waffle-relay");
    const connected = createRelayConnect(clientOptions);
    client = {
      ...connected,
      async connect(target, signal) {
        const stream = await connected.connect(target, signal);
        const carrier = connected.carrier;
        if (carrier) onCarrier?.(carrier);
        return stream;
      },
    };
    return {
      connect: client.connect,
      close,
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Runtime relay setup cleanup failed"); }
    throw error;
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closing = Promise.resolve(client?.close()).finally(() => {
      if (!runtime.disposed) runtime.filesystem.reap(identity);
      release?.();
      release = undefined;
    });
    return closing;
  }
}
