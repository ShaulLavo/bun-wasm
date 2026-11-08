import { createRuntime } from "waffle";
import type { PreviewServer } from "waffle/browser/preview";
import { observePreviewPaths, readPreviewPaths } from "../../scripts/app-matrix/preview-paths";
import { HostedPreviews } from "../src/hosted-previews";

function fixturePort(parameters: URLSearchParams, key: string, minimum = 1024): number {
  const value = parameters.get(key);
  if (!value || !/^[0-9]+$/.test(value)) throw new Error(`Invalid fixture port: ${key}`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < minimum || port > 65535) throw new Error(`Invalid fixture port: ${key}`);
  return port;
}

const parameters = new URL(location.href).searchParams;
const ports = { root: fixturePort(parameters, "rootPort"), sibling: fixturePort(parameters, "siblingPort"), extra: fixturePort(parameters, "extraPort", 49152) };
const allowedPorts = Object.values(ports);
if (new Set(allowedPorts).size !== 3) throw new Error("Fixture ports must be distinct");
const extra = parameters.get("extra");
if (extra !== null && extra !== "0") throw new Error("Invalid extra fixture port selection");
const suppliedBridge = parameters.get("bridge");
if (!suppliedBridge) throw new Error("Missing native fixture bridge");
const bridgeURL = new URL(suppliedBridge);
if (bridgeURL.protocol !== "ws:" || bridgeURL.hostname !== "127.0.0.2" || bridgeURL.username || bridgeURL.password) throw new Error("Invalid native fixture bridge");

const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
const previews = new HostedPreviews(() => runtime);
Reflect.set(globalThis, "playground", { previews });
observePreviewPaths();
const connections: number[] = [];
function helper(): PreviewServer {
  return {
    request() { return false; },
    connect(port, sink) {
      if (!allowedPorts.includes(port)) return null;
      connections.push(port);
      const socket = new WebSocket(bridgeURL.href);
      socket.binaryType = "arraybuffer";
      const queued: Uint8Array<ArrayBuffer>[] = [];
      let closed = false;
      socket.onopen = () => { for (const chunk of queued) socket.send(chunk); queued.length = 0; };
      socket.onmessage = event => { if (!closed && event.data instanceof ArrayBuffer) void sink.data(new Uint8Array(event.data)); };
      socket.onclose = () => { if (!closed) sink.end(); };
      socket.onerror = () => { if (!closed) sink.error("Native fixture bridge failed"); };
      return {
        write(chunk) { if (socket.readyState === WebSocket.OPEN) socket.send(Uint8Array.from(chunk)); else queued.push(Uint8Array.from(chunk)); },
        close() { closed = true; socket.close(); },
      };
    },
  };
}
let current = helper();
let previous = current;
previews.register(ports.root, current);
previews.register(ports.sibling, current);
if (extra !== "0") previews.register(ports.extra, current);
Reflect.set(globalThis, "previewOwnerFixture", {
  ready: () => previews.ready,
  connects: () => connections.slice(),
  paths: () => readPreviewPaths(),
  addExtra: () => previews.register(ports.extra, current),
  url: (port = ports.root) => previews.url(port),
  stop: () => previews.unregister(ports.root, current),
  restart() { previous = current; current = helper(); previews.register(ports.root, current); },
  lateStop: () => previews.unregister(ports.root, previous),
  dispose: () => runtime.dispose(),
});
