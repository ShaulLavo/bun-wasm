import { bootstrap } from "waffle/browser/worker";
import { Wasi } from "waffle/core/wasi";
import { guest } from "../../../scripts/fixtures/shared-objects/executor-guest.ts";
import { createBunExecutor, type RunRequest } from "../../../web/src/bun-executor.ts";
import * as nested from "../../../web/src/nested/host.ts";
import { plan } from "./package-continuation.ts";

export interface SharedHandoffRequest extends RunRequest { hold: boolean }
const gate = Promise.withResolvers<void>();
let entered = false;

self.onmessage = ({ data }: MessageEvent<SharedHandoffRequest | { kind: "release" }>) => {
  if ("kind" in data) return gate.resolve();
  if (entered) throw new Error("Duplicate shared caller");
  entered = true;
  const executor = createBunExecutor(data, undefined, undefined, nested);
  let imports: WebAssembly.Imports;
  const invoke = (namespace: string, name: string, ...args: number[]): number => {
    const fn = imports[namespace]?.[name];
    if (typeof fn !== "function") throw new Error(`Missing ${namespace}.${name}`);
    return fn(...args);
  };
  void bootstrap(data, { ...executor,
    namespaces(context) { return { ...executor.namespaces!(context), test: { check() {} } }; },
    imports(value, context) { imports = executor.imports!(value, context) ?? value; return imports; },
    async instantiated(context) {
      const cancelled = new Error("cancelled before memory");
      const cancellation = await Promise.resolve().then(() => executor.instantiated!({ ...context,
        checkActive() { throw cancelled; }, instance: new WebAssembly.Instance(guest(0)) })).then(() => undefined, error => error);
      if (cancellation !== cancelled) throw new Error("Cancellation lost to memory validation");
      const foreign = new Wasi({ fs: context.fs, args: [], env: {}, preopens: {}, stdout() {}, stderr() {}, sleep() {} });
      for (const invalid of [{ ...context, wasi: foreign }, { ...context, instance: new WebAssembly.Instance(guest(0)) }]) {
        const error = await Promise.resolve().then(() => executor.instantiated!(invalid)).then(() => undefined, error => error);
        if (!(error instanceof Error) || !error.message.includes("identity mismatch")) throw new Error("Conflicting binding identity was accepted");
      }
      await executor.instantiated!(context);
    },
    beforeFinish() {
      executor.beforeFinish?.();
      let cleared = false;
      try { invoke("bun_package_scripts", "handoff", -1, -1, -1, -1); }
      catch (error) { cleared = error instanceof Error && error.message === "Package binding has no executor context"; }
      if (!cleared) throw new Error("Package binding retained its executor after cleanup");
    },
    async run(context) {
      const memory = data.memoryGroup?.memory;
      if (!memory || context.instance.exports.memory !== undefined) throw new Error("Expected imported memory without an export");
      if (invoke("wasi_snapshot_preview1", "args_sizes_get", 128, 132) !== 0 || new DataView(memory.buffer).getUint32(128, true) !== data.args.length) throw new Error("WASI memory identity mismatch");
      if (invoke("bun_package_scripts", "handoff", -1, -1, -1, -1) !== -21) throw new Error("Invalid spans were accepted");
      self.postMessage({ type: "shared-ready", hold: data.hold });
      await gate.promise;
      context.checkActive();
      if (data.hold) return 0;
      const previous = memory.buffer.byteLength;
      if (invoke("runtime_shm", "group_grow", 1) < 0 || memory.buffer.byteLength <= previous) throw new Error("Owner growth failed");
      const bytes = new TextEncoder().encode(JSON.stringify(plan({ silent: true })));
      new Uint8Array(memory.buffer).set(bytes, previous);
      const result = invoke("bun_package_scripts", "handoff", previous, bytes.length, previous + 4096, 8192);
      if (result !== -58) throw new Error(`Unexpected handoff return ${result}`);
      context.checkActive();
      const root = context.wasi.descriptors.rootPreopen();
      if (!root || root.resource.kind !== "directory") throw new Error("Rejected caller lost its filesystem");
      const resolved = context.fs.resolve(root.resource.handle, "still-usable");
      if (typeof resolved === "number" || resolved.node === undefined) throw new Error("Rejected caller filesystem was revoked");
      self.postMessage({ type: "shared-rejected", result, pid: context.identity?.pid, generation: context.request.runtimeProcess?.generation });
      return 42;
    },
  });
};
