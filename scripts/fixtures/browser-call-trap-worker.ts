import { startEngineHost } from "../../web/src/engine-host.js";
import { publishBrowserCallTrap, type MemoryTelemetryTransport } from "../../web/src/memory-telemetry.ts";

self.onmessage = async (event: MessageEvent<{ module: WebAssembly.Module; transport: MemoryTelemetryTransport; imported: boolean }>) => {
  const { module, transport, imported } = event.data;
  const instance = await WebAssembly.instantiate(module, imported ? { env: { memory: new WebAssembly.Memory({ initial: 1, maximum: 4 }) } } : {});
  let observed: unknown;
  let exits = 0;
  try {
    await startEngineHost({ instance, moduleUrls: "blob", onExit() { exits++; },
      onWasmCallTrap(error, index) {
        observed = error;
        publishBrowserCallTrap(instance, index, transport, message => self.postMessage(message));
        throw new Error("observer failure must not replace the Wasm trap");
      },
    });
    self.postMessage({ type: "control-done", unexpectedSuccess: true });
  } catch (error) {
    self.postMessage({ type: "control-done", sameError: error === observed, runtimeError: error instanceof WebAssembly.RuntimeError, exits,
      fixtureFactoryMaximumBytes: (imported ? 4 : 8) * 65536 });
  }
};
