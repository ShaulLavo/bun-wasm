import { createRuntime, type GuestLauncher, type Runtime, type RuntimeProcessContext } from "../../../node_modules/waffle/index.ts";
import { DescriptorTable, type Stream } from "../../../node_modules/waffle/core/descriptors.ts";
import { createProgramShell } from "../../../node_modules/waffle/tests/fixtures/program-shell.js";
import { createRuntimeTerminalCodec } from "../../../node_modules/waffle/browser/runtime-terminals.ts";
import { createWorkerPipeCodec } from "../../../node_modules/waffle/proc/worker-pipes.ts";
import { BrowserProcessBroker } from "../../../node_modules/waffle/browser/process-broker.ts";
import { FilesystemClient } from "../../../node_modules/waffle/fs/client.ts";
import { packageContinuation, admittedIdentity } from "../../../src/package-continuation.js";
import type { PackagePlan } from "../../../src/package-continuation-plan.js";

const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
export const main = { name: "build", original: "original", command: "prepared" };
export function plan(patch: Partial<PackagePlan> = {}): PackagePlan {
  return { version: 1, pre: null, main, post: null, env: { PATH: "/bin", EMPTY: "", npm_execpath: "/actual/bun" }, cwd: "/", silent: false, color: false, footer: "Bun v1.4.4 (WASI wasm32)\n", ...patch };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function fixture(launch?: GuestLauncher, setup?: (context: RuntimeProcessContext, filesystem: FilesystemClient) => void) {
  const hostErrors: unknown[] = [];
  const runtime = createRuntime({ processHost: options => new BrowserProcessBroker({ ...options, onError: error => { hostErrors.push(error); } }), filesystem: { mode: "memory", workerURL: new URL(import.meta.resolve("waffle/browser/fs-worker")) } });
  const tables: DescriptorTable[] = [];
  const unregister: Array<() => void> = [];
  const clients: FilesystemClient[] = [];
  let parent: RuntimeProcessContext | undefined;
  const errors: unknown[] = [];
  const continuation = packageContinuation(runtime);
  unregister.push(runtime.registerAdapter("continuation", (context, service) => { parent = context;
    const transport = service.transportFor(context.pid);
    const rootData = service.transportFor(context.parentPid)?.data;
    if (transport && rootData && typeof rootData === "object" && "pipeRegistry" in rootData) transport.data = { ...(transport.data && typeof transport.data === "object" ? transport.data : {}), pipeRegistry: rootData.pipeRegistry };
    const client = new FilesystemClient(runtime.filesystem.fork());
    clients.push(client);
    const handle = client.preopen("/");
    client.retain(handle);
    client.reserve(handle, admittedIdentity(context, service));
    context.descriptors.openAt(3, { kind: "directory", handle }, (1n << 29n) - 1n, (1n << 29n) - 1n, () => client.release(handle), "/");
    setup?.(context, client);
    return (launch ?? continuation)({ ...context, fail(error) { errors.push(error); context.fail(error); } }, service); }));
  unregister.push(runtime.registerProgram("/continuation", { module: empty, adapter: "continuation", cooperative: true }));
  await runtime.filesystem.writeFile("/continuation", "prototype");
  await runtime.filesystem.drain();
  const shell = await createProgramShell(runtime, tables);
  const input: Stream = { kind: "terminal", read: () => 0, tryRead: () => 0, write: () => 0, readiness: () => ({ readable: true, writable: true, hangup: false }) };
  tables[0]?.openAt(0, input, 2n | (1n << 27n), 0n);
  for (const fd of [1, 2]) {
    const descriptor = tables[0]?.get(fd);
    if (descriptor) descriptor.rightsBase |= 1n << 27n;
  }
  createRuntimeTerminalCodec({ descriptors: tables[0], fallback: createWorkerPipeCodec() });
  const service = await runtime.processes();
  const supervisor = await service.ready();
  return { runtime, shell, service, supervisor, errors, hostErrors, parent: () => {
    if (!parent) throw new Error("Continuation has not launched");
    return parent;
  }, async register(path: string, child: GuestLauncher, module: WebAssembly.Module | (() => Promise<WebAssembly.Module>) = empty) {
    unregister.push(runtime.registerAdapter(path, child));
    unregister.push(runtime.registerProgram(path, { module, adapter: path, cooperative: true }));
    await runtime.filesystem.writeFile(path, "registered");
    await runtime.filesystem.drain();
  }, async start(value = plan()) {
    return shell.spawn("/continuation", ["/continuation", JSON.stringify(value)], {}, [0, 1, 2].map(fd => ({ parent: fd, child: fd })));
  }, dispose: () => cleanup(runtime, unregister, tables, clients) };
}

async function cleanup(runtime: Runtime, unregister: Array<() => void>, tables: DescriptorTable[], clients: FilesystemClient[]): Promise<void> {
  try { await runtime.dispose(); }
  finally {
    for (const remove of unregister.reverse()) remove();
    for (const table of tables) table.dispose();
    for (const client of clients) client.dispose();
  }
}

export async function using(run: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await run(f); }
  finally { await f.dispose(); }
}

export function exit(code: number): GuestLauncher {
  return context => { if (context.started()) context.exit(code); return { terminate() {} }; };
}
