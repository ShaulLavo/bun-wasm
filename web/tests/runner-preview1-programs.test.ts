import { fixtureModule } from "./process-module-fixture.ts";
import { expect, spyOn, test } from "bun:test";
import { createFilesystemIdentity } from "waffle/fs";
import { startRun, type RunOptions, type RunResult } from "../src/runner";
import type { RunRequest } from "../src/bun-executor";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
import { fixtureFilesystemConnection } from "./process-runtime-fixture";
import { isNotificationBridgeRequest } from "./notification-worker-fixture";
import { socketRuntimeFixture as processRuntimeFixture } from "./socket-runtime-fixture";

interface Posted { worker: RootWorker; request: RunRequest; transfer: Transferable[] }
class RootWorker {
  static posts: Posted[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = 0;
  postMessage(request: RunRequest, transfer: Transferable[] = []) {
    if (isNotificationBridgeRequest(request)) { request.port.close(); return; }
    RootWorker.posts.push({ worker: this, request, transfer });
  }
  terminate() { this.terminated++; }
}

function trackPortClosure(port: Transferable, closed: Set<unknown>): void {
  if (!(port instanceof MessagePort)) return;
  const close = port.close.bind(port);
  port.close = () => { closed.add(port); close(); };
}

/** Runs one root against the real runner, page network owner and process service, observing the
 * request exactly as the page hands it to Worker.postMessage. */
async function observeRoot(options: Omit<RunOptions, "runtime" | "moduleScope">, end: (posted: Posted, run: ReturnType<typeof startRun>) => void) {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const runtime = processRuntimeFixture({
    fork() { const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); return fixtureFilesystemConnection(createFilesystemIdentity(), channel.port1); },
    revoke() {}, reap() {}, async quiesce() {},
  });
  const network = await runtime.network();
  const helpers = { created: 0, disposed: 0 };
  const createHelper = network.createHelper.bind(network);
  const helperSpy = spyOn(network, "createHelper").mockImplementation(options => {
    // Waffle freezes its helpers; count disposal through a delegating view.
    const helper = createHelper(options);
    helpers.created++;
    return Object.create(helper, { dispose: { value: () => { helpers.disposed++; helper.dispose(); } } }) as typeof helper;
  });
  RootWorker.posts = [];
  globalThis.Worker = RootWorker as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  let run: ReturnType<typeof startRun> | undefined;
  try {
    run = startRun({ ...options, runtime, moduleScope: false }, { stdout() {}, stderr() {} });
    const deadline = performance.now() + 1000;
    let early: RunResult | undefined;
    void run.done.then(value => { early = value; });
    while (!RootWorker.posts.length && !early && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 0));
    expect(early).toBeUndefined();
    expect(RootWorker.posts).toHaveLength(1);
    const posted = RootWorker.posts[0]!;
    const closed = new Set<unknown>();
    for (const port of posted.transfer) trackPortClosure(port, closed);
    end(posted, run);
    const result: RunResult = await run.done;
    return { posted, result, closed, helpers };
  } finally {
    run?.kill(9);
    await run?.done;
    await runtime.dispose();
    helperSpy.mockRestore();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
}

const sockets = [{ fd: 3, socket: { connect: { host: "echo.example", port: 4321 } } }] as const;
const endings = {
  success: { end: (posted: Posted) => posted.worker.onmessage?.({ data: { type: "exit", code: 0 } } as MessageEvent), result: { code: 0 } },
  failure: { end: (posted: Posted) => posted.worker.onmessage?.({ data: { type: "error", code: 1, message: "fixture trap" } } as MessageEvent), result: { code: 1, error: "bun.wasm crashed: fixture trap" } },
  cancel: { end: (_posted: Posted, run: ReturnType<typeof startRun>) => run.kill(9), result: { code: 137 } },
} as const;
const contracts = {
  "empty retained fd3": { args: [] as string[], env: {} as Record<string, string> },
  "nonempty caller": { args: ["fd3-echo", "--once"], env: { A: "1", PATH: "/custom/bin", PWD: "/srv" } as Record<string, string> },
};

for (const [contractName, contract] of Object.entries(contracts)) for (const [endingName, ending] of Object.entries(endings)) {
  test(`a manual Preview1 root posts the ${contractName} argv and environment unchanged with its fd 3 binding, then disposes everything on ${endingName}`, async () => {
    const module = fixtureModule(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const args = contract.args.slice(), env = { ...contract.env };
    const connect = async () => { throw new Error("setup must not open a connection"); };
    const { posted, result, closed, helpers } = await observeRoot(
      { engine: "browser", adapter: "preview1", module, args, env, network: { connect }, preview1: { sockets } }, ending.end);
    const request = posted.request;
    expect({ args: request.args, env: request.env }).toEqual(contract);
    expect(Object.keys(request.env)).toEqual(Object.keys(contract.env));
    expect(request).toMatchObject({ engine: "browser", adapter: "preview1", net: null });
    expect(request.module).toBe(module);
    expect(request.lookupPort).toBeUndefined();
    expect(request.notifications).toBeUndefined();
    expect(request.sharedObjects).toBeUndefined();
    expect(request.network?.sockets).toEqual(sockets);
    expect(request.network?.ring).toBeInstanceOf(SharedArrayBuffer);
    expect(request.network).not.toHaveProperty("connect");
    expect(request.network).not.toHaveProperty("relay");
    expect(posted.transfer).toEqual([request.filesystem.port, request.network!.port]);
    expect(posted.transfer[0]).toBe(request.filesystem.port);
    expect(posted.transfer[1]).toBe(request.network!.port);
    // The caller's own values are neither consumed nor rewritten.
    expect(args).toEqual(contract.args);
    expect(env).toEqual(contract.env);
    expect(result).toEqual(ending.result);
    expect(posted.worker.terminated).toBe(1);
    expect(closed).toEqual(new Set(posted.transfer));
    expect(helpers).toEqual({ created: 1, disposed: 1 });
  });
}

for (const [engine, path] of [["browser", "/bin:/usr/bin"], ["quickjs", "/opt/bun/quickjs/bin:/bin:/usr/bin"], ["jsc", "/opt/bun/jsc/bin:/bin:/usr/bin"]] as const) {
  test(`a ${engine} Bun root keeps its engine executable and Bun environment`, async () => {
    const module = fixtureModule(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const executable = `${path.split(":")[0]}/bun`;
    const { posted, result } = await observeRoot({ engine, module, args: ["-e", "0"], env: { A: "1" } }, endings.success.end);
    expect(posted.request.adapter).toBeUndefined();
    expect(posted.request.args).toEqual([executable, "-e", "0"]);
    expect(posted.request.env).toEqual({ NEXT_TELEMETRY_DISABLED: "1", A: "1", PATH: path, BUNWASM_EXEC_PATH: executable });
    expect(result).toEqual({ code: 0 });
  });
}

test("a Preview1-first runtime does not register its guest as the immutable Bun engine program", async () => {
  const previousWorker = globalThis.Worker;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const previousIsolation = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  const ports: MessagePort[] = [];
  const registrations = new Map<string, ExecutableRegistration>();
  const register = SubprocessBroker.prototype.register;
  const registration = spyOn(SubprocessBroker.prototype, "register").mockImplementation(function(this: SubprocessBroker, name, entry) {
    registrations.set(name, entry); return register.call(this, name, entry);
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof globalThis.fetch>[0]) =>
    String(input).endsWith(".gz") ? new Response(null, { status: 404 })
      : new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), { headers: { "content-type": "application/wasm" } }),
  { preconnect: globalThis.fetch.preconnect }));
  globalThis.Worker = class { postMessage() {} terminate() {} } as unknown as typeof Worker;
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("https://example.test/") });
  Object.defineProperty(globalThis, "crossOriginIsolated", { configurable: true, value: true });
  const runtime = processRuntimeFixture({
    fork() { const channel = new MessageChannel(); ports.push(channel.port1, channel.port2); return fixtureFilesystemConnection(createFilesystemIdentity(), channel.port1); },
    revoke() {}, reap() {}, async quiesce() {},
  });
  const runs: ReturnType<typeof startRun>[] = [];
  try {
    const module = fixtureModule(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    runs.push(startRun({ runtime, engine: "browser", adapter: "preview1", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} }));
    runs.push(startRun({ runtime, engine: "browser", module, args: [], env: {}, moduleScope: false }, { stdout() {}, stderr() {} }));
    const program = registrations.get("/bin/bun")!;
    expect(program.adapter).toBe("bun");
    if (!("module" in program)) throw new Error("Expected a compiled Bun engine program");
    expect(typeof program.module).toBe("function");
    const first = await (program.module as () => Promise<WebAssembly.Module>)();
    const second = await (program.module as () => Promise<WebAssembly.Module>)();
    expect(first).not.toBe(module);
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    for (const run of runs) run.kill(9);
    await Promise.all(runs.map(run => run.done));
    await runtime.dispose();
    registration.mockRestore(); fetch.mockRestore();
    for (const port of ports) port.close();
    globalThis.Worker = previousWorker;
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation); else Reflect.deleteProperty(globalThis, "location");
    if (previousIsolation) Object.defineProperty(globalThis, "crossOriginIsolated", previousIsolation); else Reflect.deleteProperty(globalThis, "crossOriginIsolated");
  }
});
