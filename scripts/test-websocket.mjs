#!/usr/bin/env node
// Interoperability and malformed-frame checks against each wasm engine.
// No external dependencies, internet, fixed ports, or temporary server files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readlinkSync } from "node:fs";
import { once } from "node:events";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = process.env.BUN_WASM_LAUNCHER || `${process.env.CARGO_TARGET_DIR || "/work/tmp/bun-wasm-target"}/release/bun-wasm`;
const engines = process.argv.slice(2);
if (!engines.length) engines.push("quickjs", "jsc", "browser");
const children = new Set();
const sockets = new Set();
let assertions = 0;

async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  assert.equal(readlinkSync(`/proc/${child.pid}/cwd`), root.replace(/\/$/, ""));
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function cleanup() {
  for (const socket of sockets) socket.destroy();
  for (const child of children) {
    await stop(child);
  }
  children.clear();
}
process.on("uncaughtException", (error) => {
  console.error(error);
  void cleanup().finally(() => process.exit(1));
});
const deadline = setTimeout(() => {
  console.error("WebSocket checks exceeded 120 seconds");
  void cleanup().finally(() => process.exit(1));
}, 120000);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void cleanup().then(() => process.exit(130)));

async function start(engine) {
  const wasm = resolve(root, `dist/${engine === "quickjs" ? "bun" : `bun-${engine}`}.wasm`);
  const args = ["--wasm", wasm, "--dir", `${root}/tests/servers::/`, "--env", "PWD=/", "run", "/websocket.js"];
  const command = engine === "browser" ? process.execPath : launcher;
  const childArgs = engine === "browser"
    ? [resolve(root, "web/scripts/node-host.mjs"), "--net"].concat(args.slice(0, 6), ["--"], args.slice(6))
    : args;
  const child = spawn(command, childArgs, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stderr.on("data", (bytes) => { output += bytes; });
  const port = await new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 30000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    child.stdout.on("data", (bytes) => {
      output += bytes;
      const match = /PORT=(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
  });
  return { child, port };
}

function frame(opcode, data, { fin = true, mask = true } = {}) {
  const body = Buffer.from(data);
  assert(body.length < 126);
  const key = Buffer.from([11, 22, 33, 44]);
  const bytes = Buffer.alloc(2 + (mask ? 4 : 0) + body.length);
  bytes[0] = (fin ? 128 : 0) | opcode;
  bytes[1] = (mask ? 128 : 0) | body.length;
  if (mask) key.copy(bytes, 2);
  for (let i = 0; i < body.length; i++) bytes[bytes.length - body.length + i] = body[i] ^ (mask ? key[i % 4] : 0);
  return bytes;
}

async function raw(port, first = Buffer.alloc(0), extra = "") {
  const socket = connect({ host: "127.0.0.1", port });
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  const queue = [];
  let buffer = Buffer.alloc(0);
  let waiting = null;
  let upgraded = false;
  let closed = false;
  socket.on("data", (bytes) => {
    buffer = Buffer.concat([buffer, bytes]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString(), /^HTTP\/1.1 101 /);
      buffer = buffer.subarray(end + 4);
      upgraded = true;
    }
    parse();
  });
  socket.on("close", () => { closed = true; waiting?.(); });
  function parse() {
    while (buffer.length >= 2) {
      let size = buffer[1] & 127;
      let offset = 2;
      assert.equal(buffer[1] & 128, 0, "servers must not mask frames");
      if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
      if (size === 127) { if (buffer.length < 10) return; size = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + size) return;
      queue.push({ opcode: buffer[0] & 15, data: buffer.subarray(offset, offset + size) });
      buffer = buffer.subarray(offset + size);
      waiting?.();
    }
  }
  async function next() {
    while (!queue.length) {
      if (closed) throw new Error("socket closed before the expected frame");
      await new Promise((wake, reject) => {
        const timer = setTimeout(() => reject(new Error("frame timed out")), 5000);
        waiting = () => { clearTimeout(timer); waiting = null; wake(); };
      });
    }
    return queue.shift();
  }
  await once(socket, "connect");
  const head = Buffer.from(`GET /raw HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`);
  // A split request head followed immediately by a frame exercises HTTP takeover.
  socket.write(head.subarray(0, 13));
  socket.write(Buffer.concat([head.subarray(13), first]));
  assert.equal((await next()).data.toString(), "open:/raw");
  return { socket, next };
}

async function nativeClient(port) {
  const client = new WebSocket(`ws://127.0.0.1:${port}/native`, "bun-hmr");
  client.binaryType = "arraybuffer";
  let stage = 0;
  const done = new Promise((resolveDone, reject) => {
    client.onerror = () => reject(new Error("native WebSocket failed"));
    client.onmessage = ({ data }) => {
      try {
        if (stage++ === 0) {
          assert.equal(data, "open:/native");
          assert.equal(client.protocol, "bun-hmr");
          client.send(new Uint8Array([0, 128, 255]));
        } else if (stage === 2) {
          assert.deepEqual(Array.from(new Uint8Array(data)), [0, 128, 255]);
          client.send("λ".repeat(40000));
        } else {
          assert.equal(data, "λ".repeat(40000));
          client.close(1000, "done");
        }
      } catch (error) { reject(error); }
    };
    client.onclose = (event) => {
      try {
        assert.equal(event.code, 1000);
        assert.equal(event.reason, "done");
        assert.equal(event.wasClean, true);
        resolveDone();
      } catch (error) { reject(error); }
    };
  });
  try { await done; assertions += 7; }
  finally { if (client.readyState < 2) client.close(); }
}

async function check(port) {
  await nativeClient(port);
  const pipelined = await raw(port, frame(1, "pipelined"));
  try {
    assert.equal((await pipelined.next()).data.toString(), "pipelined");
    // Split a UTF-8 code point across fragmented data frames, with an interleaved ping.
    pipelined.socket.write(frame(1, [0xe2], { fin: false }));
    pipelined.socket.write(frame(9, "probe"));
    const pong = await pipelined.next();
    assert.equal(pong.opcode, 10);
    assert.equal(pong.data.toString(), "probe");
    assert.equal((await pipelined.next()).data.toString(), "ping:probe");
    const continuation = frame(0, [0x82, 0xac]);
    for (const byte of continuation) pipelined.socket.write(Buffer.from([byte]));
    assert.equal((await pipelined.next()).data.toString(), "€");
    assertions += 5;
  } finally { pipelined.socket.destroy(); }
  const cases = [
    [frame(1, "unmasked", { mask: false }), 1002],
    [frame(0, "no initial frame"), 1002],
    [frame(9, "fragmented ping", { fin: false }), 1002],
    [frame(1, [0xff]), 1007],
    [frame(8, [0x03, 0xed]), 1002],
    [Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0, 0x20, 0, 0]), 1009],
  ];
  for (const [bytes, code] of cases) {
    const peer = await raw(port);
    try {
      peer.socket.write(bytes);
      const response = await peer.next();
      assert.equal(response.opcode, 8);
      assert.equal(response.data.readUInt16BE(), code);
      assertions += 2;
    } finally { peer.socket.destroy(); }
  }
}

try {
  for (const engine of engines) {
    const { child, port } = await start(engine);
    try { await check(port); console.log(`PASS ${engine}: native client, binary, 80KB UTF-8, protocol, takeover, fragments, ping, six invalid frames`); }
    finally { await stop(child); children.delete(child); }
  }
  console.log(`${assertions} protocol and interoperability assertions passed`);
} finally { clearTimeout(deadline); await cleanup(); }
