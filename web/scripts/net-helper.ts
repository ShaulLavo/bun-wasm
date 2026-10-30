// Bun worker that plays the page's role for scripts/run.ts: it receives the guest's NetRequests,
// does real fetches with Bun's fetch, and serves each guest listener on an isolated real local port (the
// browser uses a service worker for that). The wasm runs on the main thread, blocked, so this has
// to be another thread.
import { NetHelper } from "../src/net/helper";
import { NetNamespace } from "waffle/browser/net/helper";
import { createCliPreview } from "./cli-preview";
import type { NetRequest } from "../src/net/protocol";

declare const self: Worker;

type Init = { type: "init"; ring: SharedArrayBuffer };

let helper: NetHelper | null = null;
let initialization: Promise<void> | undefined;
let namespace: NetNamespace | undefined;
let stopped = false;
const servers = new Map<number, ReturnType<typeof Bun.serve>>();
process.once("exit", dispose);

self.onmessage = async (event: MessageEvent<Init | NetRequest>) => {
  const msg = event.data;
  if (msg.type === "init") {
    if (initialization) throw new Error("Network helper is already initialized");
    initialization = initialize(msg.ring);
    return;
  }
  await initialization;
  helper?.handle(msg);
};

async function initialize(ring: SharedArrayBuffer): Promise<void> {
  namespace = await NetNamespace.create(() => {
    if (stopped) throw new Error("Network helper is stopped");
  });
  if (stopped) return namespace.dispose();
  helper = new NetHelper(ring, namespace, { listening: serve, stopped: unserve });
}

function dispose(): void {
  if (stopped) return;
  stopped = true;
  try { helper?.dispose(); }
  finally { namespace?.dispose(); }
}

function serve(port: number): void {
  if (!helper) return;
  try {
    const server = createCliPreview(port, helper);
    servers.set(port, server);
    if (process.stderr.isTTY) process.stderr.write(`[preview] ${server.url}\n`);
  } catch (err) {
    process.stderr.write(`[preview] port ${port}: ${String(err)}\n`);
  }
}

function unserve(port: number): void {
  servers.get(port)?.stop(true);
  servers.delete(port);
}
