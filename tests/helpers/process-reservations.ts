import { createRuntime } from "waffle";
import { BrowserProcessBroker } from "waffle/browser/process-broker";

type Reservations = ConstructorParameters<typeof BrowserProcessBroker>[0]["reservations"];
const NativeWorker = globalThis.Worker;

async function createOwner() {
  // Match the invoking consumer in Bun's root/web test commands. Browser builds
  // already resolve every public Waffle import through their single entry owner.
  let construct = createRuntime, Broker = BrowserProcessBroker;
  if (typeof Bun !== "undefined") {
    const runtimeApi: typeof import("waffle") = await import(Bun.resolveSync("waffle", process.cwd()));
    const brokerApi: typeof import("waffle/browser/process-broker") = await import(Bun.resolveSync("waffle/browser/process-broker", process.cwd()));
    construct = runtimeApi.createRuntime;
    Broker = brokerApi.BrowserProcessBroker;
  }
  const ready = Promise.withResolvers<Reservations>();
  const previous = globalThis.Worker;
  globalThis.Worker = NativeWorker;
  let runtime: ReturnType<typeof createRuntime>;
  try {
    runtime = construct({
      filesystem: { mode: "memory", workerURL: typeof Bun === "undefined" ? new URL("./fs-worker.js", location.href) : new URL("../../web/src/fs-worker.ts", import.meta.url) },
      processHost(options) { ready.resolve(options.reservations); return new Broker(options); },
    });
  } finally { globalThis.Worker = previous; }
  try {
    await runtime.processes();
    return { runtime, reservations: await ready.promise };
  } catch (error) { await runtime.dispose(); throw error; }
}

type Owner = { users: number; pending: ReturnType<typeof createOwner> };
let owner: Owner | undefined;
let stopped = Promise.resolve();

/** Borrow genuine reservations through the public host injection, never a private module. */
export function fixtureReservations() {
  const selected = owner ??= { users: 0, pending: stopped.then(createOwner) };
  selected.users++;
  let released = false;
  return {
    ready: selected.pending.then(value => value.reservations),
    dispose(): Promise<void> {
      if (released) return stopped;
      released = true;
      if (--selected.users) return Promise.resolve();
      if (owner === selected) owner = undefined;
      stopped = selected.pending.then(value => value.runtime.dispose());
      return stopped;
    },
  };
}
