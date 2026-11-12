import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isMainThread, threadId } from "node:worker_threads";

const output = process.env.LIFECYCLE_SELECTION_OUTPUT;
let phase: "control" | "workload" = "control";
function emit(value: Record<string, unknown>): void {
  if (!output) return;
  appendFileSync(output, JSON.stringify({ pid: process.pid, threadId, isMainThread, phase, observedMs: performance.now(), ...value }) + "\n");
}
function digest(bytes: ArrayBufferLike | ArrayBufferView<ArrayBufferLike>): string {
  const view = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return createHash("sha256").update(view).digest("hex");
}
function install(): void {
  const hashes = new WeakMap<WebAssembly.Module, string>();
  const NativeModule = WebAssembly.Module;
  WebAssembly.Module = class extends NativeModule {
    constructor(...args: ConstructorParameters<typeof NativeModule>) {
      super(...args);
      const sha256 = digest(args[0]);
      hashes.set(this, sha256);
      emit({ kind: "wasm-compile", method: "Module constructor returned", sha256 });
    }
  };
  const NativeInstance = WebAssembly.Instance;
  WebAssembly.Instance = class extends NativeInstance {
    constructor(...args: ConstructorParameters<typeof NativeInstance>) {
      super(...args);
      emit({ kind: "wasm-instantiate", method: "Instance constructor returned", sha256: hashes.get(args[0]) ?? null });
    }
  };
  const compile = WebAssembly.compile;
  WebAssembly.compile = async (...args) => {
    const module: unknown = await Reflect.apply(compile, WebAssembly, args);
    if (!(module instanceof NativeModule)) throw new Error("WebAssembly.compile returned no module");
    const sha256 = digest(args[0]);
    hashes.set(module, sha256);
    emit({ kind: "wasm-compile", method: "compile resolved", sha256 });
    return module;
  };
  const instantiate = WebAssembly.instantiate;
  Object.defineProperty(WebAssembly, "instantiate", { configurable: true, writable: true, value: async (...args: Parameters<typeof instantiate>) => {
    const bytes = args[0];
    const result: unknown = await Reflect.apply(instantiate, WebAssembly, args);
    emit({ kind: "wasm-instantiate", method: "instantiate resolved", sha256: bytes instanceof NativeModule ? hashes.get(bytes) ?? null : digest(bytes) });
    return result;
  } });
  const dlopen = process.dlopen;
  process.dlopen = (...args) => {
    Reflect.apply(dlopen, process, args);
    const filename = args[1];
    emit({ kind: "addon-load", method: "process.dlopen returned", filename, sha256: createHash("sha256").update(readFileSync(filename)).digest("hex") });
  };
  emit({ kind: "context", executable: process.execPath, argv: process.argv, execArgv: process.execArgv,
    coverage: "JavaScript hooks in this preloaded context; internal loaders and contexts without preload are not covered" });
  const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  new WebAssembly.Instance(module);
  phase = "workload";
}
if (output) install();
