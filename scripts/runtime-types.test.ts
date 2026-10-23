import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runtime-types-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const probe = join(scratch, "probe.ts");
const config = join(scratch, "tsconfig.json");
writeFileSync(config, JSON.stringify({
  extends: join(root, "crates/bunwasm-runtime/tsconfig.json"),
  include: [],
  files: [join(root, "crates/bunwasm-runtime/src/js/runtime.d.ts"), join(root, "crates/bunwasm-runtime/src/js/websocket_types.d.ts"), probe],
}));

function check(source: string) {
  writeFileSync(probe, 'declare const native: BunWasm.Native;\n' + source);
  return Bun.spawnSync([join(root, "web/node_modules/.bin/tsc"), "-p", config], { stdout: "pipe", stderr: "pipe" });
}

test("accepts the positional glob native contract including its optional flag", () => {
  expect(check('native.globScan("*", "/", false, false, false, false, true);\nnative.globScan("*", "/", false, false, false, false, true, true);').exitCode).toBe(0);
});

const invalid: [string, string][] = [
  ["missing cwd", 'native.globScan("*");'],
  ["boolean cwd", 'native.globScan("*", true, false, false, false, false, true);'],
  ["string flag", 'native.globScan("*", "/", "not a flag", false, false, false, true);'],
  ["string optional flag", 'native.globScan("*", "/", false, false, false, false, true, "not a flag");'],
  ["non-string UTF-8 encoding", 'native.utf8Encode(7);'],
  ["non-byte concatenation", 'declare const internal: BunWasm.Internal; internal.concatBytes(["text"]);'],
  ["unknown generated-function kind", 'native.functionImports([], "constructor");'],
  ["non-string module specifier", 'native.resolve(7, "/index.ts", false);'],
  ["runtime type error", 'const value: number = "wrong";'],
];
for (const [label, source] of invalid) {
  test(`rejects ${label}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

test("accepts native byte-sink encoding and concatenation contracts", () => {
  expect(check('native.utf8Encode("text");\ndeclare const internal: BunWasm.Internal;\ninternal.concatBytes([new Uint8Array(2)]);').exitCode).toBe(0);
});

test("accepts generated-function parser and module-loader contracts", () => {
  const result = check('native.functionImports(["return 1"], "normal");\nnative.importModule(native.resolve("./x", "/index.ts", false));');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});


test("accepts format graph, boxed coercion and shared buffer input contracts", () => {
  const result = check('native.parseData(new Uint8Array(), "YAML");\ndeclare const internal: BunWasm.Internal;\ninternal.require("yaml_coercion")(new String("value"));\ninternal.toUint8(new SharedArrayBuffer(4));');
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

for (const source of ['native.parseData("bytes", "YAML");', 'native.parseData(new Uint8Array(), "CSV");']) {
  test(`rejects invalid format graph call ${source}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}

test("accepts websocket native, byte connection, handler and queued payload contracts", () => {
  const result = check(`
    native.hostConnect("127.0.0.1", 12345);
    declare const connection: BunWasm.WebSocketServerConnection;
    connection.onData = bytes => connection.write(bytes);
    connection.onDrain = () => {};
    const handlers: BunWasm.WebSocketHandlers = {
      message(socket, data) { socket.send(data); },
      close(socket, code, reason) { socket.close(code, reason); },
      error(_socket, error) { const received: unknown = error; void received; },
    };
    const item: BunWasm.WebSocketSendItem = { bytes: new Blob(["data"]), size: 4, opcode: 2 };
    void handlers; void item;
  `);
  expect(result.stdout.toString()).toBe("");
  expect(result.exitCode).toBe(0);
});

const invalidWebsocketCalls = [
  'declare const socket: BunWasm.WebSocketServerSocket; socket.binaryType = "invalid";',
  'native.hostConnect(7, 12345);',
  'native.hostConnect("127.0.0.1", "12345");',
  'native.hostConnect("127.0.0.1", 12345, true);',
  'declare const connection: BunWasm.WebSocketConnection; connection.write("bytes");',
  'declare const connection: BunWasm.WebSocketConnection; connection.onData = (bytes: string) => {};',
  'declare const socket: BunWasm.WebSocketServerSocket; socket.send(new Blob());',
  'declare const socket: BunWasm.WebSocketServerSocket; socket.readyState = 1;',
  'const state: BunWasm.WebSocketReadyState = 4;',
  'const handlers: BunWasm.WebSocketHandlers = { close(_socket, code: string) {} };',
  'const item: BunWasm.WebSocketSendItem = { bytes: "data", size: 4, opcode: 1 };',
];
for (const source of invalidWebsocketCalls) {
  test(`rejects invalid websocket contract ${source}`, () => {
    const result = check(source);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toString()).toContain("error TS");
  });
}
