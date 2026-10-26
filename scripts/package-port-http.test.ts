import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { runInNewContext } from "node:vm";
import type { Server } from "node:http";

function fixture(refuse = false) {
  const ticks: (() => void)[] = [];
  const calls: { host: string; port: number }[] = [];
  const native = {
    hostListen(host: string, port: number) { calls.push({ host, port }); return refuse ? -1 : 7; },
    hostLocalPort: () => 4321,
    hostLocalAddr: () => -2,
    hostError: () => JSON.stringify({ code: "EADDRINUSE", message: "fixture bind failure" }),
  };
  function load(name: string, extension = "ts") {
    const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.${extension}`, import.meta.url), "utf8");
    return runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`), { TextEncoder, Buffer });
  }
  const modules: Record<string, unknown> = {
    events: EventEmitter, buffer: { Buffer }, net_address: load("net_address", "js")(),
    http_common: load("http_common")(), http_agent: load("http_agent")(), websocket: { clientClass() {} },
    net_listener: load("net_listener")({ native }),
  };
  modules.net_hostname = load("net_hostname")({ require: (name: string) => modules[name] });
  const internal = {
    native, web: {}, builtinFactories: {}, require: (name: string) => modules[name],
    builtin: () => ({ Readable, Writable }), nextTick: (callback: () => void) => ticks.push(callback),
  };
  const net = load("net", "js")(internal);
  const server: Server = net.nodeHttp("http:").createServer();
  return { server, calls, ticks, drain() { while (ticks.length) ticks.shift()?.(); } };
}

const invalid = [NaN, Infinity, -Infinity, 1.5, -1, 65536, "NaN", "Infinity", "1.5", "-1", "65536", "", " ", "${PORT:-3137}"];
for (const value of invalid) test(`HTTP rejects ${JSON.stringify(value)} before the native listen call`, () => {
  const state = fixture();
  const errors: unknown[] = [];
  state.server.on("error", error => errors.push(error));
  expect(() => Reflect.apply(state.server.listen, state.server, [{ port: value, host: "127.0.0.1" }])).toThrow(expect.objectContaining({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" }));
  expect(state.calls).toEqual([]);
  expect(state.ticks).toEqual([]);
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

for (const value of [0, "0", "3137", 3137]) test(`HTTP preserves positional port ${String(value)}`, () => {
  const state = fixture();
  state.server.listen(value, "127.0.0.1");
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
