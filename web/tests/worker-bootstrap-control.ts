import { Wasi } from "waffle/core";
import { MemFS } from "waffle/fs/memory";
import { DescriptorTable, OpenDescription } from "waffle/core/descriptors";
import { FilesystemClient, FilesystemService, MemoryBackend, connectFilesystemIdentity, createFilesystemConnection, createProcessFilesystemIdentity } from "waffle/fs";
import { createFilesystemDescriptorCodec } from "waffle/proc/filesystem-codec";
import { WorkerProcessClient, createWorkerProcessTransport, installWorkerBindings, workerProcessState, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { bootstrap, type RuntimeWorkerMessage } from "waffle/browser/worker";
import { readOutcome, startStatus } from "waffle/proc/outcome";

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
// Original preview1 fixture: a real empty command plus an exported imported fd_read.
const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, data: number[]) => [id, data.length].concat(data);
const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
const module = new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0].concat(
  section(1, [3,96,4,127,127,127,127,1,127,96,0,0,96,5,127,127,127,127,127,1,127]),
  section(2, [3].concat(text("wasi_snapshot_preview1"), text("fd_read"), [0,0],
    text("wasi_snapshot_preview1"), text("fd_write"), [0,0],
    text("wasi_snapshot_preview1"), text("path_filestat_get"), [0,2])),
  section(3, [1,1]), section(5, [1,0,1]),
  section(7, [5].concat(exported("memory",2,0), exported("_start",0,3), exported("read",0,0), exported("write",0,1), exported("stat",0,2))),
  section(10, [1,2,0,11]),
)));

/** Runs unchanged under Bun and a real isolated browser. No mock filesystem or WASI bindings. */
export async function inheritedFilesystemControl() {
  const backend = new MemoryBackend(), service = new FilesystemService(backend);
  const root = createFilesystemConnection(); service.connect(root.server);
  const fs = new FilesystemClient(root.client), parent = new DescriptorTable();
  let childConnection: ReturnType<typeof connectFilesystemIdentity> | undefined;
  let workerTable: DescriptorTable | undefined;
  let launched = false, reads = "", finalOffset = 0;
  try {
    await fs.asyncCall("writeFile", ["/inherited"], new TextEncoder().encode("abcdef"));
    const directory = await fs.asyncCall("preopen", ["/"]);
    const path = await fs.asyncCall("resolve", [directory, "inherited"]);
    fs.retain(path.node); fs.retain(directory);
    const file = { kind: "file" as const, handle: path.node, offset: 1, append: false };
    const fd = parent.open(file, 0x123n, 0n, () => fs.release(path.node));
    const dir = parent.open({ kind: "directory", handle: directory }, 0x456n, 0x789n, () => fs.release(directory));
    const notices: WorkerProcessMessage[] = [];
    const process = new WorkerProcessClient({
      transport: createWorkerProcessTransport(), descriptors: parent, codec: createFilesystemDescriptorCodec(fs),
      postMessage(message) { notices.push(message); },
      prepareSpawn() {
        const end = fs.beginTransfer(), filesystem = createProcessFilesystemIdentity(fs.connection);
        return { data: { filesystem }, codec: createFilesystemDescriptorCodec(fs, filesystem), commit: end, cancel: end };
      },
    });
    process.spawn(process.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 1, fds: [
      { child: 17, parent: fd }, { child: 31, parent: fd }, { child: 42, parent: dir },
    ] });
    const child = notices[0]!.transport;
    check(child.resources.length === 2, "duplicate fd must transfer only one file lifetime");
    parent.dispose();
    const identity = (child.data as { filesystem: Parameters<typeof connectFilesystemIdentity>[0] }).filesystem;
    childConnection = connectFilesystemIdentity(identity); service.connect(childConnection.server);
    const messages: RuntimeWorkerMessage[] = [];
    await bootstrap({ module, args: [], env: {}, filesystem: childConnection.client, runtimeProcess: child }, {
      setup({ fs: workerFs }) { workerFs.preopen = () => directory; },
      async run({ wasi, instance }) {
        launched = true; workerTable = wasi.descriptors;
        const first = wasi.descriptors.get(17)!, duplicate = wasi.descriptors.get(31)!, dir = wasi.descriptors.get(42)!;
        check(first.description === duplicate.description, "dup must share an open description");
        check(first.rightsBase === 0x123n && duplicate.rightsBase === 0x123n, "file rights changed");
        check(dir.rightsBase === 0x456n && dir.rightsInheriting === 0x789n && dir.resource.kind === "directory", "directory rights changed");
        check(first.resource.kind === "file" && first.resource.offset === 1, "initial file offset changed");
        check(startStatus(workerProcessState(child).signals.outcome) === 0, "actual _start must publish successful startup");
        const memory = (instance.exports.memory as WebAssembly.Memory).buffer, view = new DataView(memory);
        const read = (fd: number) => {
          view.setUint32(64, 128, true); view.setUint32(68, 2, true);
          const errno = (instance.exports.read as (fd: number, iovs: number, count: number, nread: number) => number)(fd, 64, 1, 32);
          check(errno === 0, `fd_read failed: ${errno}`);
          // WebKit's decoder rejects views backed by Wasm's resizable buffer. Snapshot the
          // completed read into ordinary owned bytes before handing it to a browser API.
          return new TextDecoder().decode(new Uint8Array(memory, 128, view.getUint32(32, true)).slice());
        };
        reads += read(17); check(reads === "bc" && file.offset === 3, "first read did not advance shared offset");
        await fs.asyncCall("removePath", [path, false]); service.sweep();
        check(backend.shared.hasFile(path.node), "unlink released an open file");
        reads += read(31); check(reads === "bcde" && file.offset === 5, "duplicate did not share file offset after unlink");
        wasi.descriptors.close(17); reads += read(31); finalOffset = file.offset;
        check(reads === "bcdef" && finalOffset === 6, "closing one duplicate invalidated the other");
        return 0;
      },
    }, { crossOriginIsolated: true, postMessage(message) {
      if (message.type === "stdout") check(new TextDecoder().decode(message.data) === "stdio snapshot", "WASI stdio decoding failed");
      messages.push(message);
    } });
    const terminal = messages.find(message => message.type === "exit" || message.type === "error" || message.type === "cleanup-error");
    check(terminal?.type === "exit" && terminal.code === 0, `bootstrap failed: ${JSON.stringify(terminal)}`);
    check(launched && workerTable?.get(17) === undefined && workerTable?.get(31) === undefined, "child descriptors were not released");
    await fs.asyncCall("listFiles", ["/"]); service.sweep();
    check(!backend.shared.hasFile(path.node), "last descriptor close did not release the unlinked file");
    const outcome = readOutcome(workerProcessState(child).signals.outcome);
    check(outcome?.kind === "exited" && outcome.code === 0, "child outcome was not published");
    return { reads, finalOffset, sharedDescription: true, preservedRights: true, unlinkedOpenRead: true, released: true, startupStatus: 0 };
  } finally {
    try { workerTable?.dispose(); parent.dispose(); fs.dispose(); }
    finally {
      childConnection?.client.port.close(); childConnection?.server.port.close();
      root.client.port.close(); root.server.port.close(); service.dispose();
    }
  }
}

/** Synchronous MemFS keeps path lookup local while exercising production WASI decoding. */
export function webIdlBoundaryControl() {
  const fs = new MemFS(), output: string[] = [];
  fs.writeFile("/inherited", new TextEncoder().encode("file"));
  const wasi = new Wasi({ args: [], env: {}, fs, preopens: { "/": "/" },
    stdout(data) { output.push(new TextDecoder().decode(data)); }, stderr() {},
  });
  try {
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    const memory = (instance.exports.memory as WebAssembly.Memory).buffer, view = new DataView(memory);
    const bytes = new Uint8Array(memory), path = new TextEncoder().encode("inherited");
    bytes.set(path, 256);
    check((instance.exports.stat as (...args: number[]) => number)(3, 0, 256, path.length, 512) === 0, "WASI path decoding failed");
    const text = new TextEncoder().encode("stdio snapshot"); bytes.set(text, 768);
    view.setUint32(64, 768, true); view.setUint32(68, text.length, true);
    check((instance.exports.write as (...args: number[]) => number)(1, 64, 1, 32) === 0, "WASI fd_write failed");
    check(output.join("") === "stdio snapshot", "stdio reached WebIDL decoder without a snapshot");
    return { pathDecoded: true, stdioDecoded: true, wasmResizable: Reflect.get(memory, "resizable") === true };
  } finally { wasi.descriptors.dispose(); }
}

/** Transactional import control shared with the real-browser gate. */
export function partialBindingRollbackControl() {
  const transport = createWorkerProcessTransport();
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
  let failure: unknown;
  try { installWorkerBindings(transport, descriptors, codecUnderTest); } catch (error) { failure = error; }
  check(failure instanceof TypeError, "binding import error must retain its startup classification");
  check(descriptors.get(17) === undefined && descriptors.get(31) === undefined, "partial bindings survived rollback");
  check(events.length === 1 && events[0] === "dispose inherited", "inherited ownership not released exactly once");
  descriptors.dispose();
  return { typed: true, rolledBack: true, released: true };
}
