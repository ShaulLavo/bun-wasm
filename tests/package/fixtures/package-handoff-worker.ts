import { bootstrap, type WorkerExecutionContext } from "waffle/browser/worker";
import { createBunExecutor, type RunRequest } from "../../../web/src/bun-executor.js";
import { plan } from "./package-continuation.js";
import { packageBinding } from "../../../src/package-continuation-binding.js";
import { claimOutcome } from "waffle/proc/outcome";

export interface Request extends RunRequest { mode: string }
const source = new TextEncoder();

function call(imports: WebAssembly.Imports, namespace: string, name: string, ...args: Array<number | bigint>): number {
  const fn = imports[namespace]?.[name];
  if (typeof fn !== "function") throw new Error(`Missing ${namespace}.${name}`);
  return fn(...args);
}

function prepare(context: WorkerExecutionContext, imports: WebAssembly.Imports, mode: string) {
  const table = context.wasi.descriptors;
  const root = table.rootPreopen();
  if (!root) throw new Error("No caller root");
  let rootFd = 3;
  while (table.get(rootFd) !== root) rootFd++;
  const memory = context.instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("No caller memory");
  new Uint8Array(memory.buffer).set(source.encode("later"), 128);
  const rights = 2n | 4n | 32n | 64n | (1n << 27n);
  const opened = call(imports, "wasi_snapshot_preview1", "path_open", rootFd, 0, 128, 5, 0, rights, 0n, 0, 256);
  if (opened !== 0) throw new Error(`path_open: ${opened}`);
  const file = new DataView(memory.buffer).getUint32(256, true);
  const alias = call(imports, "runtime_proc", "dup", file);
  const entry = table.get(alias);
  if (!entry) throw new Error("No file alias");
  table.inherit(1_000_003, entry);
  call(imports, "wasi_snapshot_preview1", "fd_close", alias);
  const view = new DataView(memory.buffer);
  view.setUint32(300, 512, true); view.setUint32(304, 2, true);
  if (call(imports, "wasi_snapshot_preview1", "fd_read", file, 300, 1, 320) !== 0) throw new Error("fd_read failed");
  if (mode === "moved-reduced") {
    table.inherit(7, entry);
    if (call(imports, "wasi_snapshot_preview1", "fd_renumber", rootFd, 7) !== 0) throw new Error("move failed");
    call(imports, "wasi_snapshot_preview1", "fd_fdstat_set_rights", 7, 0n, 0n);
  }
  if (mode === "failed-move" && call(imports, "wasi_snapshot_preview1", "fd_renumber", rootFd, 9999) !== 8) throw new Error("failed move changed");
  if (mode === "closed-root-alias") {
    const alias = call(imports, "runtime_proc", "dup", rootFd);
    const directory = table.get(alias);
    if (!directory) throw new Error("No root alias");
    table.inherit(1_000_004, directory);
    call(imports, "wasi_snapshot_preview1", "fd_close", alias);
  }
  if (["closed-reused", "closed", "closed-root-alias"].includes(mode)) call(imports, "wasi_snapshot_preview1", "fd_close", rootFd);
  if (mode === "closed-reused" && call(imports, "runtime_proc", "dup", file) !== rootFd) throw new Error("root number not reused");
  if (mode === "overwritten") call(imports, "wasi_snapshot_preview1", "fd_renumber", file, rootFd);
  if (mode === "file-stderr") table.inherit(2, entry);
  if (mode === "caught") call(imports, "runtime_proc", "signal", 15, 2);
  return { memory, file, rootFd };
}

self.onmessage = ({ data }: MessageEvent<Request>) => {
  const executor = createBunExecutor(data);
  let imports: WebAssembly.Imports;
  void bootstrap(data, { ...executor,
    imports(value, context) { executor.imports?.(value, context); imports = value; return value; },
    run(context) {
      if (["root", "group", "thread", "filesystem", "cancelled"].includes(data.mode)) return unsupported(context, data.mode);
      const { memory, file, rootFd } = prepare(context, imports, data.mode);
      const value = plan({ main: { name: "build", original: "original $UNCHANGED", command: "prepared 'already quoted'" }, env: { PATH: "/bin", ACTUAL: "after resolve", EMPTY: "", npm_execpath: "/actual/bun" } });
      const bytes = source.encode(JSON.stringify(value));
      new Uint8Array(memory.buffer).set(bytes, 1024);
      const handoff = (...args: number[]) => call(imports, "bun_package_scripts", "handoff", ...args);
      const required = handoff(1024, bytes.length, 0, 0);
      self.postMessage({ type: "handoff-observation", file, rootFd, required });
      if (required < 0) return required === -58 ? 42 : 43;
      // The only caller work between the size query and handoff is scratch provisioning.
      const result = handoff(1024, bytes.length, 8192, 32768);
      self.postMessage({ type: "handoff-returned", result });
      return 44;
    },
  });
};

function unsupported(context: WorkerExecutionContext, mode: string): number {
  const request = { ...context.request, filesystem: { ...context.request.filesystem } };
  const runtimeState = context.runtimeState;
  if (mode === "filesystem") Reflect.set(request.filesystem, "publication", {});
  const setup = { ...context, request, runtimeState: mode === "root" && runtimeState ? { ...runtimeState, parentPid: 0 } : runtimeState };
  const binding = packageBinding({ memoryGroup: mode === "group" || mode === "thread" ? {} : undefined }, 0x7fff_b0b0);
  const namespaces = binding.namespaces(setup);
  if (mode === "cancelled") {
    if (!context.outcome) throw new Error("No cancellation outcome");
    claimOutcome(context.outcome, { kind: "signaled", code: 9 });
  }
  const result = namespaces.bun_package_scripts.handoff(-1, -1, -1, -1);
  self.postMessage({ type: "precommit", result });
  return result === -58 ? 42 : 43;
}
