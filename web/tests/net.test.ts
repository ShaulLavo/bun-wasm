// Bun networking bindings; generic transport and helper regressions live in runtime/tests/browser-net.test.ts.
import { expect, test } from "bun:test";
import { createRing } from "waffle/browser/net/ring";
import { trampolineModule } from "../src/net/trampoline";

const encode = (s: string) => new TextEncoder().encode(s);

test("trampoline module forwards each arity to its import", () => {
  const bytes = trampolineModule([1, 3, 4, 1]);
  expect(WebAssembly.validate(bytes)).toBe(true);
  const calls: number[][] = [];
  const h = {
    f0: (a: number) => (calls.push([a]), a + 1),
    f1: (a: number, b: number, c: number) => (calls.push([a, b, c]), a + b + c),
    f2: (a: number, b: number, c: number, d: number) => (calls.push([a, b, c, d]), -4),
    f3: () => 7,
  };
  const exports = new WebAssembly.Instance(new WebAssembly.Module(bytes), { h }).exports;
  // The exports are wasm functions: a funcref table accepts them.
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 0 });
  for (let i = 0; i < 4; i++) table.grow(1, exports[`f${i}`] as never);
  expect((table.get(0) as Function)(41)).toBe(42);
  expect((table.get(1) as Function)(1, 2, 3)).toBe(6);
  expect((table.get(2) as Function)(1, 2, 3, 4)).toBe(-4);
  expect((table.get(3) as Function)(5)).toBe(7);
  expect(calls).toEqual([[41], [1, 2, 3], [1, 2, 3, 4]]);
});

test("guest TCP pipes keep reads open after write shutdown", async () => {
  const { NetHost } = await import("../src/net/host");
  const host = new NetHost(createRing(), () => {});
  const api = host.engineNet().natives;
  const call = (name: string, ...args: unknown[]) => {
    const fn = api[name];
    if (!fn) throw new Error(`Missing native ${name}`);
    return Reflect.apply(fn, null, args);
  };
  const listener = call("hostListen", "127.0.0.1", 0);
  const port = call("hostLocalPort", listener);
  const client = call("hostConnect", "127.0.0.1", port);
  const peer = call("hostAccept", listener);
  const full = new Uint8Array(1 << 20);
  expect(call("hostWrite", client, full)).toBe(full.length);
  expect(call("hostWrite", client, encode("full"))).toBe(-2);
  expect(call("hostRead", peer, full.length)).toEqual(full);
  expect(call("hostWrite", client, encode("request"))).toBe(7);
  expect(call("hostShutdown", client)).toBe(0);
  expect(call("hostRead", peer)).toEqual(encode("request"));
  expect(call("hostRead", peer)).toBe(0);
  expect(call("hostWrite", peer, encode("response"))).toBe(8);
  expect(call("hostRead", client)).toEqual(encode("response"));
  expect(call("hostWrite", client, encode("after-fin"))).toBe(-1);
  expect(call("hostShutdown", peer)).toBe(0);
  expect(call("hostRead", client)).toBe(0);
  for (const handle of [peer, client, listener]) expect(call("hostClose", handle)).toBe(0);
  expect(call("hostConnect", "127.0.0.1", port)).toBe(-1);
  expect(JSON.parse(String(call("hostError", 0))).code).toBe("ECONNREFUSED");
  expect(call("hostConnect", "example.com", 80)).toBe(-4);
  expect(JSON.parse(String(call("hostError", 0))).code).toBe("ENOTSUP");
});
