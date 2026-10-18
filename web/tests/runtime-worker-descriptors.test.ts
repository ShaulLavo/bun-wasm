import { expect, test } from "bun:test";
import { DescriptorTable, OpenDescription } from "waffle/core/descriptors";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity } from "waffle/fs";
import * as codec from "waffle/proc/filesystem-codec";
import * as client from "waffle/proc/worker-client";
import { bootstrap, type RuntimeWorkerHost, type RuntimeWorkerRequest } from "waffle/browser/worker";
import { readOutcome } from "waffle/proc/outcome";

// Original tiny preview1 guest: export fd_read so the bootstrap's actual WASI binding performs
// all reads and shared-offset updates, instead of reproducing that behavior in the test.
const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, data: number[]) => [id, data.length].concat(data);
const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
const module = new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0].concat(
  section(1, [2,96,4,127,127,127,127,1,127,96,0,0]),
  section(2, [1].concat(text("wasi_snapshot_preview1"), text("fd_read"), [0,0])),
  section(3, [1,1]), section(5, [1,0,1]),
  section(7, [3].concat(exported("memory",2,0), exported("_start",0,1), exported("read",0,0))),
  section(10, [1,2,0,11]),
)));

function host(messages: unknown[]): RuntimeWorkerHost {
  return { crossOriginIsolated: true, postMessage(message) { messages.push(message); } };
}

test("worker installs inherited file, dup and directory bindings through bootstrap", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const root = createFilesystemConnection();
  service.connect(root.server);
  const fs = new FilesystemClient(root.client);
  const parent = new DescriptorTable();
  let workerTable: DescriptorTable | undefined;
  const transport = client.createWorkerProcessTransport();
  const messages: client.WorkerProcessMessage[] = [];
  try {
    await fs.asyncCall("writeFile", ["/inherited"], new TextEncoder().encode("abcdef"));
    const directory = await fs.asyncCall("preopen", ["/"]);
    const path = await fs.asyncCall("resolve", [directory, "inherited"]);
    fs.retain(path.node); fs.retain(directory);
    const file = { kind: "file" as const, handle: path.node, offset: 1, append: false };
    const fd = parent.open(file, 0x123n, 0n, () => fs.release(path.node));
    const dir = parent.open({ kind: "directory", handle: directory }, 0x456n, 0x789n, () => fs.release(directory));
    const process = new client.WorkerProcessClient({
      transport, descriptors: parent, codec: codec.createFilesystemDescriptorCodec(fs),
      postMessage(message) { messages.push(message); },
      prepareSpawn() {
        const end = fs.beginTransfer();
        const filesystem = createProcessFilesystemIdentity(fs.connection);
        return { data: { filesystem }, codec: codec.createFilesystemDescriptorCodec(fs, filesystem), commit: end, cancel: end };
      },
    });
    process.spawn(1, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [
      { child: 17, parent: fd }, { child: 31, parent: fd }, { child: 42, parent: dir },
    ] });
    const child = messages[0]!.transport;
    expect(child.resources).toHaveLength(2);
    parent.dispose();

    const identity = (child.data as { filesystem: Parameters<typeof connectFilesystemIdentity>[0] }).filesystem;
    const connection = connectFilesystemIdentity(identity);
    service.connect(connection.server);
    const sent: unknown[] = [];
    let launched = false;
    const request: RuntimeWorkerRequest = {
      module, args: [], env: {}, filesystem: connection.client, runtimeProcess: child,
      trace: false,
    };
    await bootstrap(request, {
      setup({ fs: workerFs }) { workerFs.preopen = () => 1; },
      async run({ wasi, instance }) {
        launched = true;
        workerTable = wasi.descriptors;
        const first = wasi.descriptors.get(17)!;
        const duplicate = wasi.descriptors.get(31)!;
        const directory = wasi.descriptors.get(42)!;
        expect(first.description).toBe(duplicate.description);
        expect(first.rightsBase).toBe(0x123n);
        expect(directory.rightsInheriting).toBe(0x789n);
        expect(directory.resource.kind).toBe("directory");
        if (first.resource.kind !== "file") throw new Error("missing inherited file");
        expect(first.resource.offset).toBe(1);
        const memory = (instance.exports.memory as WebAssembly.Memory).buffer;
        const view = new DataView(memory);
        const read = (fd: number) => {
          view.setUint32(64, 128, true); view.setUint32(68, 2, true);
          expect((instance.exports.read as (fd: number, iovs: number, count: number, nread: number) => number)(fd, 64, 1, 32)).toBe(0);
          return new TextDecoder().decode(new Uint8Array(memory, 128, view.getUint32(32, true)));
        };
        expect(read(17)).toBe("bc");
        expect(file.offset).toBe(3);
        await fs.asyncCall("removePath", [path, false]);
        service.sweep();
        expect(backend.shared.hasFile(path.node)).toBe(true);
        expect(read(31)).toBe("de");
        expect(file.offset).toBe(5);
        wasi.descriptors.close(17);
        expect(read(31)).toBe("f");
        expect(file.offset).toBe(6);
        return 0;
      },
    }, host(sent));
    expect(launched).toBe(true);
    expect(sent.filter(message => (message as { type?: string }).type === "exit")).toEqual([
      { type: "exit", code: 0, signal: undefined, sleep: "atomics" },
    ]);
    expect(workerTable!.get(17)).toBeUndefined();
    await fs.asyncCall("listFiles", ["/"]);
    service.sweep();
    expect(backend.shared.hasFile(path.node)).toBe(false);
    expect(readOutcome(client.workerProcessState(child).signals.outcome)).toMatchObject({ kind: "exited", code: 0 });
    connection.client.port.close(); connection.server.port.close();
  } finally {
    workerTable?.dispose(); parent.dispose(); fs.dispose(); service.dispose();
  }
});

test.skip("partial inherited binding import is typed and rolls back all descriptors (pending Waffle #23)", () => {
  const transport = client.createWorkerProcessTransport();
  transport.bindings = [
    { fd: 17, reference: 0, rightsBase: 1n, rightsInheriting: 0n },
    { fd: 31, reference: 1, rightsBase: 1n, rightsInheriting: 0n },
  ];
  transport.resources = ["retained", "reject"];
  const descriptors = new DescriptorTable();
  const stream = { kind: "terminal" as const, read: () => 0, write: () => 0, readiness: () => ({ readable: false, writable: true, hangup: false }) };
  const events: string[] = [];
  const codecUnderTest = {
    import(token: unknown) {
      if (token === "reject") throw new TypeError("binding rejected");
      return new OpenDescription(stream, () => events.push("dispose inherited"));
    },
    export() { throw new Error("unexpected export"); }, discard() {},
  };
  expect(() => client.installWorkerBindings(transport, descriptors, codecUnderTest)).toThrow(TypeError);
  expect(descriptors.get(17)).toBeUndefined();
  expect(events).toEqual(["dispose inherited"]);
});

test.todo("generic child runtime diagnostics reach stderr completely before close: pending separate Waffle child-diagnostics fix; generic bootstrap currently drops the error text");
