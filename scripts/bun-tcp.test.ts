import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dir, "..");
const runtime = join(root, "crates/bunwasm-runtime/src/js");
const scratch = mkdtempSync(join(process.env.BUN_WASM_TEST_TMP ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-bun-tcp-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function emitted(name: string): string {
  const output = join(scratch, `${name}.js`);
  const result = Bun.spawnSync(["node", "--no-warnings", join(root, "scripts/transpile-runtime.ts"), join(runtime, `${name}.ts`), output], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return readFileSync(output, "utf8");
}

function evaluate(name: string, context: object = {}) {
  // oxlint-disable-next-line no-eval -- runInNewContext evaluates the real classic-script factory with explicit guest globals.
  return runInNewContext(emitted(name), { Buffer, TextEncoder, URL, ...context });
}

class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = [];
  destroyed = false;
  connecting = false;
  writableNeedDrain = false;
  bytesWritten = 0;
  remoteAddress: string | undefined;
  localAddress: string | undefined;
  remotePort: number | undefined;
  localPort: number | undefined;
  _connected = false;
  attached: unknown;
  connectOptions: unknown;
  writes: number[][] = [];
  ended = false;
  timeoutMs: number | undefined;
  referenced: boolean | undefined;
  destroyError: unknown;

  constructor() {
    super();
    FakeSocket.instances.push(this);
  }

  _attach(connection: unknown): void {
    this.attached = connection;
    this.remoteAddress = "127.0.0.1";
    this.localAddress = "127.0.0.1";
    this.remotePort = 5000;
    this.localPort = 4321;
  }

  connect(options: unknown, callback: () => void): this {
    this.connectOptions = options;
    callback();
    return this;
  }

  write(data: Uint8Array): boolean {
    this.writes.push(Array.from(data));
    this.bytesWritten += data.byteLength;
    return true;
  }

  end(data?: Uint8Array): this {
    if (data) this.write(data);
    this.ended = true;
    return this;
  }

  destroy(error?: unknown): this {
    this.destroyed = true;
    this.destroyError = error;
    this.emit("close", Boolean(error));
    return this;
  }

  setTimeout(milliseconds: number): this {
    this.timeoutMs = milliseconds;
    return this;
  }

  ref(): this {
    this.referenced = true;
    return this;
  }

  unref(): this {
    this.referenced = false;
    return this;
  }
}

function fixture() {
  FakeSocket.instances = [];
  const accepting = { ref: true };
  const waiters = new Set<object>();
  const listenCalls: { hostname: string; port: number }[] = [];
  const closed: number[] = [];
  let onAccept: ((connection: unknown) => void) | undefined;
  const ports = evaluate("net_port")();
  const address = evaluate("net_address")({ require: () => ports });
  const hostname = evaluate("net_hostname")({ require: () => address });
  const internal = {
    native: {
      hostLocalPort(handle: number) { expect(handle).toBe(7); return 4321; },
      hostClose(handle: number) { closed.push(handle); return 0; },
    },
    nextTick(callback: () => void) { callback(); },
    builtin(name: string) {
      expect(name).toBe("node:net");
      return { Socket: FakeSocket };
    },
    require(name: string) {
      if (name === "net_address") return address;
      if (name === "net_hostname") return hostname;
      throw new Error(`Unexpected module ${name}`);
    },
  };
  const transport = {
    listenOrThrow(host: string, port: number) { listenCalls.push({ hostname: host, port }); return 7; },
    acceptLoop(handle: number, callback: (connection: unknown) => void) {
      expect(handle).toBe(7);
      onAccept = callback;
      waiters.add(accepting);
      return accepting;
    },
    waiters,
  };
  const tcp = evaluate("bun_tcp")(internal)(transport);
  return {
    tcp, listenCalls, closed, waiters, accepting,
    accept(connection: unknown) {
      expect(onAccept).toBeDefined();
      onAccept!(connection);
    },
  };
}

test("listen wraps accepted sockets, payloads, reloads and forced shutdown", () => {
  const state = fixture();
  const received: unknown[] = [];
  const closeCodes: number[] = [];
  let opens = 0;
  const listener = state.tcp.listen({
    hostname: null, port: "0", data: null, tls: null, unix: null,
    socket: {
      binaryType: "uint8array",
      open() { opens++; },
      data(_socket: unknown, data: unknown) { received.push(data); },
      close(_socket: unknown, code: number) { closeCodes.push(code); },
      end: null, drain: null, timeout: null, error: null, connectError: null,
    },
  });
  expect(listener.hostname).toBe("0.0.0.0");
  expect(listener.port).toBe(4321);
  expect(listener.data).toBeNull();
  expect(state.listenCalls).toEqual([{ hostname: "0.0.0.0", port: 0 }]);
  state.accept({ connection: 1 });
  const node = FakeSocket.instances[0]!;
  const socket = listener._sockets.values().next().value;
  expect(opens).toBe(1);
  expect(node.attached).toEqual({ connection: 1 });
  expect(socket.remoteAddress).toBe("127.0.0.1");
  expect(socket.localPort).toBe(4321);
  expect(socket.write("hello", 1, 3)).toBe(3);
  expect(node.writes).toEqual([[101, 108, 108]]);
  node.emit("data", Buffer.from([1, 2, 3]));
  expect(received).toHaveLength(1);
  expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2, 3]);
  socket.reload({ socket: { binaryType: "arraybuffer", data(_socket: unknown, data: unknown) { received.push(data); }, close(_socket: unknown, code: number) { closeCodes.push(code); } } });
  node.emit("data", Buffer.from([4, 5]));
  expect(received[1]).toBeInstanceOf(ArrayBuffer);
  expect(Array.from(new Uint8Array(received[1] as ArrayBuffer))).toEqual([4, 5]);
  expect(socket.end(new DataView(Uint8Array.of(9, 8, 7, 6).buffer), 1, 2)).toBe(2);
  expect(node.writes[1]).toEqual([8, 7]);
  expect(socket.readyState).toBe(-2);
  expect(socket.write("ignored")).toBe(-1);
  listener.stop(true);
  expect(node.destroyed).toBe(true);
  expect(state.closed).toEqual([7]);
  expect(state.waiters.size).toBe(0);
  expect(listener._sockets.size).toBe(0);
  expect(closeCodes).toEqual([0]);
});

test("connect resolves the wrapped socket and preserves nullish handlers and buffer inputs", async () => {
  const state = fixture();
  let opens = 0;
  const socket = await state.tcp.connect({
    hostname: false, port: "80", data: null, tls: null, unix: null,
    socket: {
      open() { opens++; }, data: null, close: null, error: null, connectError: null,
      end: null, drain: null, timeout: null, binaryType: null,
    },
  });
  const node = FakeSocket.instances[0]!;
  expect(node.connectOptions).toEqual({ host: "localhost", port: "80" });
  expect(opens).toBe(1);
  expect(socket.data).toBeNull();
  expect(socket.write(new SharedArrayBuffer(2))).toBe(2);
  expect(socket.write(new DataView(new ArrayBuffer(2)))).toBe(2);
  expect(node.writes).toEqual([[0, 0], [0, 0]]);
  socket.timeout(0.5);
  expect(node.timeoutMs).toBe(500);
  expect(socket.ref()).toBe(socket);
  expect(socket.unref()).toBe(socket);
  expect(node.referenced).toBe(false);
  socket.shutdown(false);
  expect(node.destroyed).toBe(true);
  expect(socket.readyState).toBe(-1);
});

const validProbe = `
declare const internal: Parameters<typeof createTcp>[0];
const create = createTcp(internal);
declare const transport: Parameters<typeof create>[0];
const tcp = create(transport);
const listener = tcp.listen({
  hostname: null, port: "0", data: null, tls: null, unix: null,
  socket: {
    binaryType: null, open: undefined, end: null, drain: null, timeout: null,
    data: null, error: null, connectError: null, close: null,
  },
});
const nullData: null = listener.data;
const sameListener: typeof listener = listener.ref();
listener.reload({ socket: { open: null, close: null } });
listener.stop(false);
const clientPromise = tcp.connect({
  hostname: false, port: "80", data: "client",
  socket: {
    binaryType: "arraybuffer",
    data(_socket, data) { const bytes: ArrayBuffer | ArrayBufferView = data; void bytes; },
    close(_socket, code) { const status: 0 | 1 = code; void status; },
    error(_socket, error) { const actual: Error = error; void actual; },
  },
});
clientPromise.then(client => {
  const clientData: string = client.data;
  client.write("text");
  client.write(new ArrayBuffer(2));
  client.write(new SharedArrayBuffer(2));
  client.write(new DataView(new ArrayBuffer(2)), 0, 2);
  client.end(Uint8Array.of(1, 2));
  client.reload({ socket: { data: null, binaryType: null } });
  void clientData;
});
void nullData;
void sameListener;
tcp.listen({ port: 0, socket: { data(_socket, bytes) { bytes.toString("utf8"); } } });
tcp.listen({ port: 0, socket: { data(_socket, bytes: BunWasm.BufferBytes) { bytes.toString("utf8"); } } });
tcp.listen({ port: 0, socket: { binaryType: "buffer", data(_socket, bytes: BunWasm.BufferBytes) { bytes.toString("utf8"); } } });
tcp.listen({ port: 0, socket: { binaryType: null, data(_socket, bytes: BunWasm.BufferBytes) { bytes.toString("utf8"); } } });
tcp.connect({ port: 80, socket: { binaryType: "uint8array", data(_socket, bytes: Uint8Array) { bytes.subarray(1); } } });
tcp.listen({ port: 0, socket: { binaryType: "arraybuffer", data(_socket, bytes: ArrayBuffer) { bytes.slice(1); } } });
tcp.connect({ port: 80, data: { count: 1 }, socket: { open(socket) { socket.data.count++; } } }).then(socket => {
  const count: number = socket.data.count;
  void count;
});
const initializedListener = tcp.listen({ port: 0, data: { count: 1 }, socket: {} });
const initializedCount: number = initializedListener.data.count;
tcp.listen({ port: 0, data: { count: 1 }, socket: { open(socket: { data: { count: number } }) { socket.data.count++; } } });
tcp.connect({ port: 80, socket: {} }).then(socket => { const absent: undefined = socket.data; void absent; });
void initializedCount;
`;

function checkTypes(probe: string) {
  const path = join(scratch, "probe.ts");
  const source = readFileSync(join(runtime, "bun_tcp.ts"), "utf8").replace("(function (internal", "const createTcp = (function (internal");
  writeFileSync(path, `${source};\n${probe}`);
  const config = join(scratch, "tsconfig.json");
  const declarations = readdirSync(runtime).filter(name => name.endsWith(".d.ts")).map(name => join(runtime, name));
  writeFileSync(config, JSON.stringify({
    extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
    include: [], files: declarations.concat([path]),
  }));
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("actual factory types accept Bun and native caller shapes", () => {
  const result = checkTypes(validProbe);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalidProbes = [
  'tcp.listen({ hostname: "localhost", port: 0, socket: null });',
  'tcp.connect({ hostname: "localhost", port: null, socket: {} });',
  'tcp.listen({ hostname: 123, port: 0, socket: {} });',
  'clientPromise.then(client => client.write(null));',
  'tcp.listen({ hostname: "localhost", port: 0, socket: { close(_socket, code: string) {} } });',
  'tcp.listen({ port: 0, socket: { data(_socket, bytes: ArrayBuffer) {} } });',
  'tcp.connect({ port: 80, socket: { binaryType: "uint8array", data(_socket, bytes: ArrayBuffer) {} } });',
  'tcp.listen({ port: 0, socket: { binaryType: "arraybuffer", data(_socket, bytes: Uint8Array) {} } });',
];
for (const probe of invalidProbes) {
  test(`factory types reject ${probe}`, () => {
    const result = checkTypes(`${validProbe}\n${probe}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
