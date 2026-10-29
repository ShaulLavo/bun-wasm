import { createRuntime } from "waffle";
import { startRun } from "../src/runner.ts";
import { installRuntimeSharedObjects } from "../src/shared-objects/runtime.ts";

const NativeWorker = globalThis.Worker;
const workers = new Set<Worker>();
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); workers.add(this); }
  override terminate() { workers.delete(this); super.terminate(); }
};
const runtime = createRuntime({ filesystem: { workerURL: new URL("./fs-worker.js", location.href) } });
const shared = installRuntimeSharedObjects(runtime);
let stdout = "", stderr = "";
let run: ReturnType<typeof startRun> | undefined;
let result: Record<string, unknown> = {};
try {
  const files: unknown = await (await fetch("./fixture.json")).json();
  if (!Array.isArray(files)) throw new Error("Missing fixture");
  await runtime.filesystem.mkdirp("/home/user");
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.source !== "string") throw new Error("Invalid fixture file");
    await runtime.filesystem.writeFile(`/home/user/${file.path}`, file.source);
  }
  await runtime.filesystem.flush();
  const module = await WebAssembly.compileStreaming(fetch("./bun-guest.wasm"));
  run = startRun({ engine: "browser", module, args: ["run", "/home/user/index.ts"], env: { PWD: "/home/user" }, runtime, moduleScope: false }, {
    stdout(bytes) { stdout += new TextDecoder().decode(bytes); },
    stderr(bytes) { stderr += new TextDecoder().decode(bytes); },
  });
  const outcome = await run.done;
  result = { ...outcome, stdout, stderr, sharedBeforeDispose: shared.inspect() };
} catch (error) { result = { error: String(error), stdout, stderr }; }
finally {
  run?.kill(9);
  await runtime.dispose(); shared.close();
  const forcedWorkers = workers.size;
  for (const worker of workers) worker.terminate();
  globalThis.Worker = NativeWorker;
  Reflect.set(globalThis, "wasmTransferResult", { ...result, cleanup: shared.inspect(), forcedWorkers, activeWorkers: workers.size });
}
