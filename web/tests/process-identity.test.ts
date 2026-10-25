import { expect, test } from "bun:test";
import { bootstrap } from "waffle/browser/worker";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessMessage } from "waffle/proc/worker-client";
import { DescriptorTable } from "waffle/core/descriptors";
import { connectFilesystemIdentity, createFilesystemIdentity } from "waffle/fs/protocol";
import { readOutcome } from "waffle/proc/outcome";
import { createBunExecutor, type RunRequest } from "../src/bun-executor";
import { createNodeProcess, type NodeWasiImports } from "../scripts/node-process";

const text = (name: string) => [name.length].concat(Array.from(new TextEncoder().encode(name)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
// Real scalar import selector calls store pid/parentPid in exported memory before _start returns.
const body = [0, 65, 0, 65, 0, 16, 0, 54, 2, 0, 65, 4, 65, 1, 16, 0, 54, 2, 0, 11];
const module = new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
  section(1, [2, 96, 1, 127, 1, 127, 96, 0, 0]),
  section(2, [1].concat(text("bun_identity"), text("get"), [0, 0])),
  section(3, [1, 1]), section(5, [1, 0, 1]),
  section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 1])),
  section(10, [1, body.length].concat(body)),
)));

function fixture() {
  const root = createWorkerProcessTransport({ pid: 71, job: 29, capacity: 8 });
  const descriptors = new DescriptorTable();
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: root, descriptors,
    codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} },
    postMessage: message => notices.push(message),
  });
  const child = () => {
    const pid = client.spawn(root.pid, { executable: "proof", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    const notice = notices.find(message => message.operation === "spawn" && message.transport.pid === pid);
    if (!notice || notice.operation !== "spawn") throw new Error("spawn transport missing");
    return notice.transport;
  };
  return { root, descriptors, client, child };
}

async function observe(transport: ReturnType<typeof createWorkerProcessTransport>, expected: readonly [number, number]) {
  const connection = connectFilesystemIdentity(createFilesystemIdentity());
  const request: RunRequest = { module, args: [], env: {}, filesystem: connection.client, runtimeProcess: transport,
    engine: "browser", adapter: "preview1", trace: false, net: null, moduleCache: null };
  const host = { location: { href: "https://fixture.test/" }, fetch: globalThis.fetch, postMessage() {} };
  const executor = createBunExecutor(request, host);
  try {
    await bootstrap(request, { ...executor,
      setup({ fs }) { fs.preopen = () => 1; fs.retain = () => {}; fs.release = () => {}; },
      run(context, exited) {
        const memory = context.instance.exports.memory;
        if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing memory");
        const observed = new Uint32Array(memory.buffer, 0, 2);
        expect(observed[0]).toBe(expected[0]);
        expect(observed[1]).toBe(expected[1]);
        return executor.run(context, exited);
      },
    }, { crossOriginIsolated: true, postMessage() {} });
  } finally { connection.client.port.close(); connection.server.port.close(); }
}

test("real executor bootstrap reports root, child handles, siblings and ancestry after root exit", async () => {
  const f = fixture();
  const children = [f.child(), f.child()];
  try {
    await observe(f.root, [71, 0]);
    expect(readOutcome(f.client.signals.outcome)).not.toBeNull();
    for (const transport of children) await observe(transport, [transport.pid, 71]);
    expect(children[0]!.pid).not.toBe(children[1]!.pid);
  } finally { f.descriptors.dispose(); }
});

test("Node fixture provider uses Waffle transport identity, not environment or physical PID", () => {
  const f = fixture();
  const transport = f.child();
  const node = createNodeProcess({ transport, env: { PID: "999", PPID: "888" }, postMessage() {}, finish(): never { throw new Error("unexpected process exit"); } });
  const imports: NodeWasiImports = { wasi_snapshot_preview1: { sock_send: () => 0 } };
  try {
    node.install(imports, () => { throw new Error("identity does not need guest memory"); });
    const instance = new WebAssembly.Instance(module, imports);
    const start = instance.exports._start;
    const memory = instance.exports.memory;
    if (typeof start !== "function" || !(memory instanceof WebAssembly.Memory)) throw new Error("invalid proof module");
    start();
    expect(Array.from(new Uint32Array(memory.buffer, 0, 2))).toEqual([transport.pid, 71]);
    const get = imports.bun_identity?.get;
    if (typeof get !== "function") throw new Error("missing identity getter");
    expect(get(2)).toBe(-28);
  } finally { node.descriptors.dispose(); f.descriptors.dispose(); }
});
