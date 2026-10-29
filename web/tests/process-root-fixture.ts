import type { Runtime } from "waffle";
import { createFilesystemIdentity, revokeFilesystem } from "waffle/fs";
import { DescriptorTable } from "waffle/core/descriptors";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessMessage, type WorkerProcessTransport } from "waffle/proc/worker-client";
import { SubprocessBroker, type SubprocessBrokerOptions } from "../src/subprocess-broker";
import type { SharedFilesystem } from "../src/shared-fs";
import { socketRuntimeFixture as processRuntimeFixture } from "./socket-runtime-fixture";

/** A page-side broker, its fake runtime, and a worker-side client for the root process it adopts.
 * The client posts into `messages` instead of a worker, so a test delivers each one explicitly. */
export function rootFixture(options?: SubprocessBrokerOptions & { activate?: () => Promise<typeof import("waffle/proc")> }) {
  const ports: MessagePort[] = [];
  const filesystem = {
    connect(identity: object) {
      const channel = new MessageChannel();
      channel.port2.close();
      ports.push(channel.port1);
      return { ...identity, port: channel.port1 };
    },
    revoke: revokeFilesystem, client: { sweep() {} },
    async quiesce(identity: Parameters<typeof revokeFilesystem>[0]) { revokeFilesystem(identity); },
  } as unknown as SharedFilesystem;
  const runtime: Runtime = processRuntimeFixture(filesystem, { activate: options?.activate });
  const root: WorkerProcessTransport = createWorkerProcessTransport({ pid: runtime.identities.pid(), job: runtime.identities.job(), identity: runtime.identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const broker = new SubprocessBroker("http://localhost/worker.js", runtime, options);
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export(descriptor) {
      if (descriptor.resource.kind === "terminal") return { kind: "web-terminal", target: 2 };
      throw new Error("unexpected export");
    }, import() { throw new Error("unexpected import"); }, discard() {} },
    postMessage: message => messages.push(message),
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity(), pipeRegistry: (root.data as { pipeRegistry: unknown }).pipeRegistry } }),
  });
  return { root, runtime, broker, client, messages, descriptors,
    async dispose() { broker.dispose(); descriptors.dispose(); try { await runtime.dispose(); } finally { for (const port of ports) port.close(); } } };
}

/** A module whose only content is one runtime_proc import, which is enough to be a valid program. */
export function importingModule(name: string, namespace = "runtime_proc"): WebAssembly.Module {
  const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const imports = [1].concat(text(namespace), text(name), [0, 0]);
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 2, imports.length].concat(imports)));
}
