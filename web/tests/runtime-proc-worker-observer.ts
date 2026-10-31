export type RuntimeProcABIObservation = {
  operation: string;
  args: number[];
  terminalBefore: number[] | undefined;
  terminalAfter?: number[];
  result?: number;
};

// Serialized into the existing test bootstrap, so keep this function self-contained.
export function observeRuntimeProcWorker() {
  let terminal: Int32Array | undefined;
  let reports = 0;
  globalThis.addEventListener("message", event => {
    if (event.data?.terminalOutput instanceof SharedArrayBuffer) terminal = new Int32Array(event.data.terminalOutput, 0, 8);
  });
  const state = () => {
    const header = terminal;
    return header && Array.from({ length: 8 }, (_, index) => Atomics.load(header, index));
  };
  const report = (observation: RuntimeProcABIObservation) => {
    if (reports === 128) return;
    reports++;
    globalThis.postMessage({ type: "proc-abi-observation", ...observation });
  };
  const wrap = (namespace: WebAssembly.ModuleImports | undefined, name: string, entry = false) => {
    const original = namespace?.[name];
    if (!namespace || typeof original !== "function") return;
    namespace[name] = (...args: number[]) => {
      const terminalBefore = state();
      if (entry) report({ operation: name, args, terminalBefore });
      const result = Reflect.apply(original, namespace, args);
      if (!entry) report({ operation: name, args, result, terminalBefore, terminalAfter: state() });
      return result;
    };
  };
  const NativeInstance = WebAssembly.Instance;
  Reflect.set(WebAssembly, "Instance", class extends NativeInstance {
    constructor(module: WebAssembly.Module, imports: WebAssembly.Imports = {}) {
      for (const name of ["write", "poll", "wait"]) wrap(imports.runtime_proc, name);
      for (const name of ["fd_close", "proc_exit"]) wrap(imports.wasi_snapshot_preview1, name, true);
      super(module, imports);
    }
  });
}
