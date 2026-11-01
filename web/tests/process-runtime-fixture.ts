const { createRuntimeNetwork }: typeof import("../../node_modules/waffle/browser/net/runtime.ts") = await import(
  new URL("./browser/net/runtime.ts", import.meta.resolve("waffle/package.json")).href
);
import { BrowserProcessBroker } from "waffle/browser/process-broker";
import { MemFS } from "waffle/fs/memory";
import { connectFilesystemIdentity, type FilesystemIdentity } from "waffle/fs";
import { ExecutableRegistry } from "waffle/proc/registry";
import { ProcessIdentityAllocator } from "waffle/proc/identity";
import { ProcessTable } from "waffle/proc/table";
import { compileInterruptible } from "waffle/interrupt/loader";
import { getVfsDescriptor } from "waffle";
import { createProcessIdentity } from "waffle/browser/process-context";
import type { GuestLauncher, ProcessService, RuntimeFilesystem, RuntimeConsumer } from "waffle";
import type { ProcessRuntime } from "../../src/process-runtime.js";

/** A process-only fixture: no page owner, filesystem worker, browser cache or service locator.
 * Production composition is covered by the runtime facade tests; these inject explicit owners
 * so legacy transport regressions can independently control filesystem and activation barriers.
 */
export function processRuntimeFixture(overrides: Partial<RuntimeFilesystem>, options: {
  activate?: () => Promise<typeof import("waffle/proc")>;
} = {}): ProcessRuntime {
  const unused = (): never => { throw new Error("Unexpected filesystem operation in process-only fixture"); };
  let filesystem: RuntimeFilesystem = {
    vfs: getVfsDescriptor("memory"), state: { status: "ready" }, workspace: undefined, resolvePath: unused, ownershipLost: false, createIdentity: unused, fork: unused, connect: unused,
    revoke: unused, reap: unused, quiesce: unused, drain: unused, flush: unused,
    lookup: unused, readFile: unused, listFiles: unused, directoryHandle: unused,
    mkdirp: unused, writeFile: unused, remove: unused, move: unused, ...overrides,
  };
  const identities = new ProcessIdentityAllocator();
  const files = new MemFS();
  filesystem = Object.assign(Object.create(filesystem), {
    async lookup(path: string) { const node = files.lookup(path); return node && { path, kind: node.kind }; },
    async writeFile(path: string, bytes: Uint8Array) { files.writeFile(path, bytes); },
    async mkdirp(path: string) { files.mkdirp(path); },
    async resolvePath(path: string) { const node = files.lookup(path); return node && { path, kind: node.kind }; },
  });
  const registry = new ExecutableRegistry(path => filesystem.resolvePath(path));
  const table = new ProcessTable(identities);
  const adapters = new Map<string, GuestLauncher>();
  let broker: BrowserProcessBroker | undefined;
  let activation: Promise<ProcessService> | undefined;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  let networkOwner: ReturnType<typeof createRuntimeNetwork> | undefined;
  const networkClosed = new Error("Runtime is disposed");
  const assertNetworkLive = () => { if (disposed) throw networkClosed; };
  const consumers = new Set<RuntimeConsumer>();
  let service!: ProcessService;
  return {
    hostIdentity: null, filesystem, identities,
    async network() {
      assertNetworkLive();
      const owner = await (networkOwner ??= createRuntimeNetwork(assertNetworkLive));
      assertNetworkLive();
      return owner.network;
    },
    get disposed() { return disposed; },
    retainConsumer(consumer) {
      if (disposed) throw new Error("Runtime is disposed");
      consumers.add(consumer);
      return () => { if (!disposed) consumers.delete(consumer); };
    },
    registerAdapter(name, launch) {
      if (adapters.has(name)) throw new Error(`Adapter already registered: ${name}`);
      adapters.set(name, launch);
      return () => { if (adapters.get(name) === launch) adapters.delete(name); };
    },
    registerProgram(name, program) {
      if (registry.has(name)) throw new Error(`Program already registered: ${name}`);
      if (program.adapter !== undefined && !adapters.has(program.adapter)) throw new Error(`Unknown adapter: ${program.adapter}`);
      if (program.command) registry.register(name, { command: program.command });
      else if (program.script) registry.register(name, { adapter: program.adapter, script: program.script, onLoad: program.onLoad });
      else registry.register(name, { adapter: program.adapter, interruptible: program.source !== undefined, module: program.source !== undefined ? async () => {
        const source = typeof program.source === "function" ? await program.source() : program.source!;
        return compileInterruptible(source);
      } : program.cooperative === true ? program.module : async () => { throw new TypeError("Third-party programs require source bytes"); } });
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        registry.unregister(name);
      };
    },
    processes() {
      if (disposed) return Promise.reject(new Error("Runtime is disposed"));
      return activation ??= Promise.resolve().then(() => {
        broker = new BrowserProcessBroker({ filesystem, identities, registry, table, hostIdentity: null, activate: options.activate,
          launch: context => {
            const launch = adapters.get(context.adapter);
            if (!launch) throw new Error(`Unknown adapter: ${context.adapter}`);
            return launch({ ...context, identity: createProcessIdentity(context, null) }, service);
          },
        });
        if (disposed) broker.suspend();
        service = broker;
        return service;
      });
    },
    dispose() {
      if (disposal) return disposal;
      const completion = Promise.withResolvers<void>();
      disposal = completion.promise;
      disposed = true;
      const retained = Array.from(consumers);
      const errors: unknown[] = [];
      for (const consumer of retained) {
        try { consumer.revoke(); } catch (error) { errors.push(error); }
        try { filesystem.revoke(consumer.filesystem); } catch (error) { errors.push(error); }
      }
      try { broker?.suspend(); } catch (error) { errors.push(error); }
      void Promise.resolve().then(async () => {
        try { if (activation) await activation; } catch (error) { errors.push(error); }
        try { if (networkOwner) await networkOwner; } catch (error) { if (error !== networkClosed) errors.push(error); }
        // This process-only fixture owns the same pre-admission fence, not a no-op lease.
        // A rejected fence prevents physical cleanup, as it does in the real page owner.
        const fences = await Promise.allSettled(retained.map(consumer => Promise.resolve().then(() => filesystem.quiesce(consumer.filesystem))));
        const failures = fences.filter(result => result.status === "rejected").map(result => result.reason);
        if (!failures.length) {
          const stops = await Promise.allSettled(retained.map(consumer => Promise.resolve().then(() => consumer.stop())));
          for (const result of stops) if (result.status === "rejected") errors.push(result.reason);
          consumers.clear();
          try { await networkOwner?.then(owner => owner.dispose(), () => {}); }
          catch (error) { errors.push(error); }
        }
        try {
          if (failures.length) await broker?.quiesce();
          else await broker?.dispose();
        } catch (error) { errors.push(error); }
        const failuresAndErrors = errors.concat(failures);
        if (failuresAndErrors.length === 1) throw failuresAndErrors[0];
        if (failuresAndErrors.length) throw new AggregateError(failuresAndErrors, "Process fixture disposal failed");
      }).then(completion.resolve, completion.reject);
      return disposal;
    },
  };
}

export function fixtureFilesystemConnection(identity: FilesystemIdentity, port: MessagePort) {
  const { client, server } = connectFilesystemIdentity(identity);
  client.port.close();
  server.port.close();
  return { ...client, port };
}
