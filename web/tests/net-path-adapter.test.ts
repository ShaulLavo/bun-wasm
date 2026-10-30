import { expect, spyOn, test } from "bun:test";
import type { RuntimeNetwork } from "waffle";
import { createFilesystemIdentity } from "waffle/fs/protocol";
import { NetHost as RuntimeNetHost } from "waffle/browser/net/host";
import { NetNamespace } from "waffle/browser/net/helper";

import { NetHost } from "../src/net/host";
import { NetHelper, createBunNetworkHelper, dispatchBunNetwork } from "../src/net/helper";
import { trampolineModule } from "../src/net/trampoline";
import { createRing } from "../src/net/ring";

function pathHost() {
  const saved = new Map(["listenPath", "connectPath"].map(name => [name, Object.getOwnPropertyDescriptor(RuntimeNetHost.prototype, name)]));
  const calls: unknown[][] = [];
  Object.defineProperties(RuntimeNetHost.prototype, {
    listenPath: { configurable: true, value(path: string, options: unknown) { calls.push(["listen", path, options]); return 31; } },
    connectPath: { configurable: true, value(path: string) { calls.push(["connect", path]); return 32; } },
  });
  return { calls, dispose() {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(RuntimeNetHost.prototype, name, descriptor);
      else Reflect.deleteProperty(RuntimeNetHost.prototype, name);
    }
  } };
}

test("Unix pointer slots and browser natives call the same fixed Waffle path API", () => {
  const fixture = pathHost();
  try {
    const host = new NetHost(createRing(), () => {});
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    host.attach(memory);
    memory.grow(1);
    const path = "/tmp/nuxt-é.sock";
    const bytes = new TextEncoder().encode(path);
    new Uint8Array(memory.buffer).set(bytes, 65536);
    const slots = host.slots();
    expect(slots.listen_path!(65536, bytes.length, 1)).toBe(31);
    expect(slots.listen_path!(65536, bytes.length, 0)).toBe(31);
    expect(slots.connect_path!(65536, bytes.length)).toBe(32);
    const net = host.engineNet();
    expect(Reflect.apply(net.natives.hostListenPath!, null, [path, 1])).toBe(31);
    expect(Reflect.apply(net.natives.hostConnectPath!, null, [path])).toBe(32);
    expect(net.caps.listen_path).toBe(true);
    expect(net.caps.connect_path).toBe(true);
    expect(fixture.calls).toEqual([
      ["listen", path, { unlinkOnClose: true }], ["listen", path, { unlinkOnClose: false }],
      ["connect", path], ["listen", path, { unlinkOnClose: true }], ["connect", path],
    ]);
    const bomPath = new TextEncoder().encode("\uFEFF/tmp/pipe.sock");
    new Uint8Array(memory.buffer).set(bomPath, 65536);
    slots.connect_path!(65536, bomPath.length);
    expect(fixture.calls.at(-1)).toEqual(["connect", "\uFEFF/tmp/pipe.sock"]);
  } finally { fixture.dispose(); }
});

test("invalid UTF-8, out-of-range path bytes, and reserved flags report EINVAL without calling Waffle", () => {
  const fixture = pathHost();
  try {
    const host = new NetHost(createRing(), () => {});
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.attach(memory);
    const bytes = new Uint8Array(memory.buffer);
    bytes.set([0xff], 16);
    const slots = host.slots();
    expect(slots.connect_path!(16, 1)).toBe(-1);
    const length = slots.error!(0, 128, 4096);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(128, 128 + length)))).toMatchObject({ code: "EINVAL", syscall: "connect" });
    expect(slots.listen_path!(16, 0, 2)).toBe(-1);
    expect(slots.connect_path!(65535, 2)).toBe(-1);
    expect(slots.connect_path!(16, -1)).toBe(-1);
    expect(fixture.calls).toEqual([]);
    expect(slots.fetch!(16, 1, 0, 0)).toBe(-1);
    const size = slots.error!(0, 128, 4096);
    expect(new TextDecoder().decode(bytes.subarray(128, 128 + size))).toContain("malformed request metadata");
  } finally { fixture.dispose(); }
});

test("Bun request admission forwards Unix requests and rejects malformed fields", async () => {
  const helper = new NetHelper(createRing(), await NetNamespace.create());
  const seen: unknown[] = [];
  const handle = spyOn(helper, "handle").mockImplementation(request => { seen.push(request); });
  try {
    const reply = new SharedArrayBuffer(12);
    const requests = [
      { type: "unix-listen", id: 1, path: "/tmp/t.sock", unlinkOnClose: true, reply },
      { type: "unix-connect", id: 2, path: "/tmp/t.sock", reply },
      { type: "unix-close", id: 1, reply },
    ];
    for (const req of requests) dispatchBunNetwork(helper, { type: "net", req });
    expect(seen).toEqual(requests);
    for (const req of [
      { ...requests[0], path: 1 }, { ...requests[0], unlinkOnClose: 1 },
      { ...requests[1], reply: new SharedArrayBuffer(8) }, { ...requests[2], reply: undefined },
    ]) expect(() => dispatchBunNetwork(helper, { type: "net", req })).toThrow("Invalid Bun network request");
  } finally { handle.mockRestore(); helper.dispose(); }
});


test("path call trampolines preserve their three- and two-argument signatures", () => {
  const calls: number[][] = [];
  const module = new WebAssembly.Module(trampolineModule([3, 2]));
  const { f0, f1 } = new WebAssembly.Instance(module, { h: {
    f0: (...args: number[]) => { calls.push(args); return 11; },
    f1: (...args: number[]) => { calls.push(args); return 12; },
  } }).exports;
  if (typeof f0 !== "function" || typeof f1 !== "function") throw new Error("Missing path trampolines");
  expect(f0(100, 20, 1)).toBe(11);
  expect(f1(100, 20)).toBe(12);
  expect(calls).toEqual([[100, 20, 1], [100, 20]]);
});


test("Bun forwards the trusted guest scope without putting it in guest requests", async () => {
  const ring = createRing();
  const helper = new NetHelper(ring, await NetNamespace.create());
  let captured: unknown;
  const network: RuntimeNetwork = {
    lookup: () => [],
    createHelper(options) { captured = options; return helper; },
  };
  const pathScope = { filesystem: createFilesystemIdentity(), directory: 1 };
  try {
    expect(createBunNetworkHelper(network, ring, { pathScope })).toBe(helper);
    expect(captured).toMatchObject({ pathScope });
  } finally { helper.dispose(); }
});
