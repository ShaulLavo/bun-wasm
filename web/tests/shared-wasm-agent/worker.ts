import "./spidermonkey-stack-proof";
import "./lock";
import { bootstrap, type WorkerExecutor } from "waffle/browser/worker";
import { captureProcessObserver } from "waffle/proc/observation";
import { createBunExecutor, hasTerminalMetadata, type NestedModule, type TerminalModule } from "../../src/bun-executor";
import { captureExecutor, CaptureWriter, type CapturedRequest } from "./capture";
import { qualifyCapture } from "./capture-controls";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const postMessage = scope.postMessage.bind(scope);
const host = Object.freeze({
  crossOriginIsolated: scope.crossOriginIsolated,
  location: { href: scope.location.href },
  fetch: scope.fetch.bind(scope),
  postMessage,
  addEventListener: scope.addEventListener.bind(scope),
  removeEventListener: scope.removeEventListener.bind(scope),
});
const terminalModule = (request: CapturedRequest): Promise<TerminalModule> => hasTerminalMetadata(request)
  ? import("../../src/bun-terminal").catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) : Promise.resolve(undefined);
const nestedModule = (request: CapturedRequest): Promise<NestedModule> => request.memoryGroup
  ? import("../../src/nested/host").catch((error: unknown) => error instanceof Error ? error : new Error(String(error))) : Promise.resolve(undefined);

scope.onmessage = async (event: MessageEvent<CapturedRequest>) => {
  const request = event.data;
  const capture = request.sharedWasmCapture ? new CaptureWriter(request.sharedWasmCapture) : undefined;
  if (capture) {
    scope.addEventListener("error", event => capture.error(event.error));
  }
  let executor: WorkerExecutor<CapturedRequest>;
  try {
    const observation = request.observation ?? request.runtimeProcess;
    const observer = observation ? captureProcessObserver(observation) : undefined;
    const [terminal, nested] = await Promise.all([terminalModule(request), nestedModule(request)]);
    const observed = observer?.read();
    executor = observed && observed.kind !== "pending" ? { run: () => 0 } : createBunExecutor(request, host, terminal, nested);
  } catch (error) {
    capture?.error(error);
    executor = { setup() { throw error; }, run: () => 0 };
  }
  if (capture && request.args.some(arg => arg.endsWith("/member-capture-child.ts")) && request.args.includes("exit")) executor = qualifyCapture(executor, capture);
  capture?.phase("bootstrap");
  await bootstrap(request, capture ? captureExecutor(executor, capture) : executor, host);
  capture?.phase("bootstrap-returned");
};
