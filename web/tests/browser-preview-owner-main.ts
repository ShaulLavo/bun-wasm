import { createRuntime } from "waffle";
import type { PreviewServer } from "waffle/browser/preview";
import { HostedPreviews } from "../src/hosted-previews";

const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: new URL("./fs-worker.js", location.href) } });
const previews = new HostedPreviews(() => runtime);
const suppliedBridge = new URL(location.href).searchParams.get("bridge");
if (!suppliedBridge) throw new Error("Missing native fixture bridge");
const bridgeURL: string = suppliedBridge;
function helper(): PreviewServer {
  return {
    request() { return false; },
    connect(port, sink) {
      if (port !== 3137 && port !== 3138) return null;
      const socket = new WebSocket(bridgeURL);
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
previews.register(3137, current);
previews.register(3138, current);
Reflect.set(globalThis, "previewOwnerFixture", {
  ready: () => previews.ready,
  url: (port = 3137) => previews.url(port),
  stop: () => previews.unregister(3137, current),
  restart() { previous = current; current = helper(); previews.register(3137, current); },
  lateStop: () => previews.unregister(3137, previous),
  dispose: () => runtime.dispose(),
});
