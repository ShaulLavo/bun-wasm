import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { browserBuildConfig } from "../../scripts/browser-build";
import type { BunNetworkOptions } from "../src/net/helper";

const entry = new URL("./browser-network-consumer-main.ts", import.meta.url).pathname;
const bindings = new Map([
  ["waffle", "export const createRuntime = () => globalThis.control.runtime"],
  ["../src/runner", "export const startRun = () => { throw Error('unexpected guest run'); }"],
  ["../../src/bun-adapter", "export const installBunAdapters = globalThis.control.install"],
  ["waffle/proc/worker-client", "export const createWorkerProcessTransport = options => options; export const workerProcessState = transport => transport;"],
]);
const config = browserBuildConfig([entry], import.meta.dir, { splitting: false });
const controls: Bun.BunPlugin = { name: "isolated-runtime", setup(build) {
  build.onResolve({ filter: /^(waffle$|\.\.\/src\/runner$|\.\.\/\.\.\/src\/bun-adapter$|waffle\/proc\/worker-client$)/ }, ({ path }) => ({ path, namespace: "control" }));
  build.onLoad({ filter: /.*/, namespace: "control" }, ({ path }) => {
    const contents = bindings.get(path);
    if (!contents) throw new Error(`unexpected control import: ${path}`);
    return { contents, loader: "ts" };
  });
}};
config.plugins = [controls].concat(config.plugins ?? []);
const build = await Bun.build({ ...config, outdir: undefined, format: "iife", minify: false });
if (!build.success || !build.outputs[0]) throw new Error(build.logs.map(String).join("\n"));
const source = await build.outputs[0].text();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const registration = deferred<object>();
  const worker = new EventTarget();
  const state = { installing: Object.assign(worker, { state: "installing" }), active: null, waiting: null };
  let network: BunNetworkOptions | undefined;
  let disposals = 0;
  let parentExits = 0;
  const actions: string[] = [];
  const runtime = {
    filesystem: { async mkdirp() {}, async flush() {}, fork: () => ({ port: {} }) },
    identities: { pid: () => 1, job: () => 1, buffer: new SharedArrayBuffer(4) },
    processes: async () => ({ async adoptRuntimeRoot() {}, async rootExit() { parentExits++; } }),
  };
  class Worker extends EventTarget {
    terminate() {}
    postMessage() { network?.listening?.(31972, { request: () => true, connect: () => null, handle() {}, dispose() {}, listenerFor: () => undefined, async notifyFileChanged() {}, async changeFile() {} }); }
  }
  const context = {
    control: { runtime, async install(_runtime: unknown, options: { network: BunNetworkOptions }) {
      network = options.network;
      return { dispose() { disposals++; } };
    } },
    Worker, URL, TextEncoder, TextDecoder, SharedArrayBuffer, Int32Array, Uint8Array, Atomics,
    WebAssembly: { Module: WebAssembly.Module, compileStreaming: async () => new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])) },
    fetch: () => Promise.resolve(new Response()), console, performance,
    setTimeout() { throw new Error("control unexpectedly needs polling"); },
    location: { href: "http://fixture.test/" },
    navigator: { serviceWorker: { addEventListener() {}, startMessages() {}, register() { actions.push("register"); return registration.promise; } } },
  };
  runInNewContext(source, context);
  const consumer = Reflect.get(context, "networkConsumer");
  return {
    consumer, actions,
    registered() { registration.resolve(state); },
    activate() { state.installing.state = "activated"; state.installing.dispatchEvent(new Event("statechange")); },
    lifetime: () => ({ disposals, parentExits }),
  };
}

for (const boundary of ["registration", "activation"]) {
  test(`public adapter waits for service-worker ${boundary} before exposing its preview`, async () => {
    const control = fixture();
    if (boundary === "activation") control.registered();
    let returned = false;
    const run = control.consumer.publicAdapter().then((result: unknown) => { returned = true; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(control.actions).toEqual(["register"]);
      expect(returned).toBe(false);
    } finally {
      control.registered();
      control.activate();
      const result = await run;
      expect(result).toMatchObject({ listeners: [31972] });
      expect(await control.consumer.previews.ready).toBe("ready");
      expect(control.lifetime()).toEqual({ disposals: 2, parentExits: 1 });
    }
  });
}
