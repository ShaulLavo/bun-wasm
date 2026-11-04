import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Readable, Writable, Duplex, getDefaultHighWaterMark } from "node:stream";
import { runInNewContext } from "node:vm";
import type { Server } from "node:http";
import { netAddressSource } from "./net-address-source";

function fixture(refuse = false, protocol: "http" | "tcp" = "http") {
  const ticks: (() => void)[] = [];
  const calls: { host: string; port: number }[] = [];
  const pathCalls: { path: string; flags: number }[] = [];
  const native = {
    hostListen(host: string, port: number) { calls.push({ host, port }); return refuse ? -1 : 7; },
    hostListenPath(path: string, flags: number) { pathCalls.push({ path, flags }); return refuse ? -1 : 8; },
    cwd: () => "/home/user",
    hostLocalPort: () => 4321,
    hostLocalAddr: () => -2,
    hostClose: () => 0,
    hostError: () => JSON.stringify({ code: "EADDRINUSE", message: "fixture bind failure" }),
  };
  function load(name: string, extension = "ts") {
    const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
    const code = name === "net_address" ? netAddressSource() : new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`);
    return runInNewContext(code, { TextEncoder, Buffer });
  }
  const ports = load("net_port")();
  const modules: Record<string, unknown> = {
    events: EventEmitter, buffer: { Buffer }, net_port: ports, net_address: load("net_address")({ require: () => ports }),
    http_common: load("http_common")(), http_agent: load("http_agent")(), websocket: { clientClass() {} },
    net_listener: load("net_listener")({ native }),
  };
  modules.net_hostname = load("net_hostname")({ require: (name: string) => modules[name] });
  const internal = {
    native, web: {}, builtinFactories: {}, require: (name: string) => modules[name],
    builtin: () => ({ Readable, Writable, Duplex, getDefaultHighWaterMark }), nextTick: (callback: () => void) => ticks.push(callback),
  };
  modules.net_path = load("net_path")(internal);
  modules.http_server_response = load("http_server_response")(internal);
  modules.node_net_server = load("node_net_server")(internal);
  modules.node_net = load("node_net", "js")(internal);
  const net = load("net", "js")(internal);
  const server: Server = protocol === "tcp" ? net.nodeNet().createServer() : net.nodeHttp("http:").createServer();
  return { server, calls, pathCalls, ticks, drain() { while (ticks.length) ticks.shift()?.(); } };
}

const invalid = [NaN, Infinity, -Infinity, 1.5, -1, 65536, "NaN", "Infinity", "1.5", "-1", "65536", "", " ", "${PORT:-3137}"];
for (const value of invalid) test(`HTTP rejects ${String(value)} before the native listen call`, () => {
  const state = fixture();
  const errors: unknown[] = [];
  state.server.on("error", error => errors.push(error));
  expect(() => Reflect.apply(state.server.listen, state.server, [{ port: value, host: "127.0.0.1" }])).toThrow(expect.objectContaining({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" }));
  expect(state.calls).toEqual([]);
  expect(state.ticks).toEqual([]);
  expect(state.server.listenerCount("listening")).toBe(0);
  expect(state.server.listening).toBe(false);
  state.drain();
  expect(errors).toEqual([]);
});

for (const value of [{}, [], false, true]) test(`HTTP rejects invalid option port type ${JSON.stringify(value)}`, () => {
  const state = fixture();
  expect(() => Reflect.apply(state.server.listen, state.server, [{ port: value }])).toThrow(expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_VALUE" }));
  expect(state.calls).toEqual([]);
  expect(state.ticks).toEqual([]);
});

for (const value of [0, "0", " 0 ", 3137, "3137", "3.137e3", "0xc41", 65535, undefined, null]) test(`HTTP normalizes valid object port ${String(value)}`, () => {
  const state = fixture();
  expect(Reflect.apply(state.server.listen, state.server, [{ port: value, host: "127.0.0.1" }])).toBe(state.server);
  expect(state.calls).toEqual([{ host: "127.0.0.1", port: Number(value ?? 0) }]);
});

function tcpOptions(protocol: "http" | "tcp", options: object, expectedPort: number) {
  const state = fixture(false, protocol);
  const errors: Error[] = [];
  state.server.on("error", error => errors.push(error));
  try {
    Reflect.apply(state.server.listen, state.server, [options]);
    state.drain();
    expect(errors).toEqual([]);
    expect(state.calls).toEqual([{ host: "127.0.0.1", port: expectedPort }]);
    expect(state.pathCalls).toEqual([]);
    expect(Reflect.get(state.server, "_pipeName")).toBeUndefined();
  } finally { state.server.close(); state.drain(); }
}

function pathOptions(protocol: "http" | "tcp", options: object) {
  const state = fixture(false, protocol);
  try {
    Reflect.apply(state.server.listen, state.server, [options]);
    expect(state.calls).toEqual([]);
    expect(state.pathCalls).toEqual([{ path: "/tmp/bun-wasm-listen.sock", flags: 1 }]);
  } finally { state.server.close(); state.drain(); }
}

for (const protocol of ["http", "tcp"] as const) {
  test(`${protocol} accepts adapter-node's false socket path with a supplied port`, () => {
    tcpOptions(protocol, { path: false, host: "127.0.0.1", port: "3137" }, 3137);
  });

  test(`${protocol} selects TCP before reading or validating the unused socket path`, () => {
    const options = { host: "127.0.0.1", port: 0, get path(): never { throw new Error("Unused path getter"); } };
    tcpOptions(protocol, options, 0);
    for (const path of [undefined, null, false, true, 0, {}, "/tmp/unused.sock"]) tcpOptions(protocol, { path, host: "127.0.0.1", port: 0 }, 0);
  });

  test(`${protocol} distinguishes an omitted port from an explicitly undefined or null port`, () => {
    pathOptions(protocol, { path: "/tmp/bun-wasm-listen.sock", host: "127.0.0.1" });
    pathOptions(protocol, { path: "/tmp/bun-wasm-listen.sock", port: false });
    tcpOptions(protocol, { path: "/tmp/bun-wasm-listen.sock", host: "127.0.0.1", port: undefined }, 0);
    tcpOptions(protocol, { path: "/tmp/bun-wasm-listen.sock", host: "127.0.0.1", port: null }, 0);
  });

  test(`${protocol} keeps selected TCP port errors synchronous before the native call`, () => {
    const state = fixture(false, protocol);
    for (const port of [NaN, 65536, "invalid"]) expect(() => Reflect.apply(state.server.listen, state.server, [{ path: "/tmp/unused.sock", port }, () => {}])).toThrow(expect.objectContaining({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" }));
    expect(state.calls).toEqual([]);
    expect(state.pathCalls).toEqual([]);
    expect(state.ticks).toEqual([]);
    expect(state.server.listenerCount("listening")).toBe(0);
  });

  test(`${protocol} keeps invalid selected Unix paths on the existing asynchronous error path`, () => {
    for (const path of [false, null, true, 0, {}]) {
      const state = fixture(false, protocol);
      const errors: Error[] = [];
      state.server.on("error", error => errors.push(error));
      Reflect.apply(state.server.listen, state.server, [{ path }]);
      expect(errors).toEqual([]);
      state.drain();
      expect(errors).toEqual([expect.objectContaining({ name: "TypeError", code: "ERR_INVALID_ARG_TYPE", message: expect.stringContaining("options.path") })]);
      expect(state.calls).toEqual([]);
      expect(state.pathCalls).toEqual([]);
      expect(state.server.listening).toBe(false);
    }
  });
}

for (const value of [0, "0", "3137", 3137]) test(`HTTP preserves positional port ${String(value)}`, () => {
  const state = fixture();
  Reflect.apply(state.server.listen, state.server, [value, "127.0.0.1"]);
  expect(state.calls).toEqual([{ host: "127.0.0.1", port: Number(value) }]);
});

test("HTTP host bind errors still emit asynchronously", () => {
  const state = fixture(true);
  const errors: unknown[] = [];
  state.server.on("error", error => errors.push(error));
  expect(state.server.listen(0, "127.0.0.1")).toBe(state.server);
  expect(errors).toEqual([]);
  state.drain();
  expect(errors).toEqual([expect.objectContaining({ code: "EADDRINUSE" })]);
});

test("native Node confirms invalid object ports throw synchronously", () => {
  const source = `
    const { createServer } = require("node:http");
    const invalid = [NaN, Infinity, -Infinity, 1.5, -1, 65536, "NaN", "Infinity", "1.5", "-1", "65536", "", " ", "\${PORT:-3137}", {}, [], false, true];
    for (const port of invalid) {
      const server = createServer();
      try { server.listen({port, host: "127.0.0.1"}); throw new Error("invalid port reached listen"); }
      catch (error) { console.log(JSON.stringify({name: error.name, code: error.code})); }
      finally { server.close(); }
    }
  `;
  const node = Bun.which("node");
  if (!node) throw new Error("Native Node reference executable is required");
  const result = Bun.spawnSync([node, "-e", source], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const rows: unknown[] = result.stdout.toString().trim().split("\n").map(line => JSON.parse(line));
  expect(rows).toEqual(invalid.map(() => ({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" })).concat(Array.from({ length: 4 }, () => ({ name: "TypeError", code: "ERR_INVALID_ARG_VALUE" }))));
});

test("native Node accepts zero and numeric zero strings as loopback TCP ports", () => {
  const source = `
    const { createServer } = require("node:http");
    (async () => {
      for (const port of [0, "0", " 0 ", "0x0", "0e0", undefined, null]) {
        const server = createServer();
        try {
          await new Promise((resolve, reject) => server.once("error", reject).listen({port, host: "127.0.0.1"}, resolve));
          const address = server.address();
          if (!address || typeof address === "string" || address.port < 1) throw new Error("not a TCP listener");
          console.log("TCP");
        } finally { await new Promise(resolve => server.close(resolve)); }
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const node = Bun.which("node");
  if (!node) throw new Error("Native Node reference executable is required");
  const result = Bun.spawnSync([node, "-e", source], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual(Array(7).fill("TCP"));
});

test("native Node gives supplied TCP ports precedence over optional Unix paths", () => {
  const source = `
    const { createServer } = require("node:http");
    async function inspect(options) {
      const server = createServer();
      try {
        await new Promise((resolve, reject) => server.once("error", reject).listen(options, resolve));
        const address = server.address();
        if (!address || typeof address === "string" || address.port < 1) throw new Error("not a TCP listener");
        console.log("TCP");
      } finally { await new Promise(resolve => server.close(resolve)); }
    }
    async function main() {
      for (const path of [undefined, null, false, true, 0, {}, "/unused.sock"]) await inspect({ path, port: 0, host: "127.0.0.1" });
      await inspect({ path: false, port: "0", host: "127.0.0.1" });
      await inspect({ path: "/unused.sock", port: undefined, host: "127.0.0.1" });
      await inspect({ path: "/unused.sock", port: null, host: "127.0.0.1" });
      await inspect({ port: 0, host: "127.0.0.1", get path() { throw new Error("unused path getter"); } });
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const node = Bun.which("node");
  if (!node) throw new Error("Native Node reference executable is required");
  const result = Bun.spawnSync([node, "-e", source], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim().split("\n")).toEqual(Array(11).fill("TCP"));
});
