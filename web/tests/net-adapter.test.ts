import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRuntimeNetwork } from "../node_modules/waffle/browser/net/runtime.ts";
import { NetHost as RuntimeNetHost } from "waffle/browser/net/host";
import { NetNamespace } from "../node_modules/waffle/browser/net/helper.ts";
import { AGAIN, BADF, Kind, type NetRequest, UNSUPPORTED } from "waffle/browser/net/protocol";
import { createRing, RingWriter } from "waffle/browser/net/ring";
import { NetHost } from "../src/net/host";
import { NetHelper, createBunNetworkHelper, dispatchBunNetwork } from "../src/net/helper";
import { processRuntimeFixture } from "./process-runtime-fixture";

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
function deferred<T>() {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}
async function until(ready: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (ready()) return;
    await Bun.sleep(1);
  }
  throw new Error("Network adapter did not make progress");
}

test("Bun slots decode grown guest memory and preserve transferred request bytes", () => {
  const messages: NetRequest[] = [];
  const host = new NetHost(createRing(), (message, transfer) => messages.push(structuredClone(message, { transfer })));
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const slots = host.slots();
  memory.grow(1);
  const bytes = new Uint8Array(memory.buffer);
  const meta = encode(JSON.stringify({ url: "https://network.invalid/", method: "POST" }));
  const body = encode("guest body");
  bytes.set(meta, 65536);
  bytes.set(body, 66000);
  expect(slots.fetch!(65536, meta.length, 66000, body.length)).toBeGreaterThan(0);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ type: "fetch", body });
  expect(bytes.subarray(66000, 66000 + body.length)).toEqual(body);
});

for (const kind of ["resizable", "growable"] as const) {
  for (const operation of ["fetch", "listen", "connect"] as const) {
    test(`Bun ${operation} slots decode fixed private copies of ${kind} guest memory before and after growth`, () => {
      const messages: NetRequest[] = [];
      const host = new NetHost(createRing(), (request, transfer) => messages.push(structuredClone(request, { transfer })));
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 3, shared: kind === "growable" });
      const backing = Reflect.apply(Reflect.get(memory, "toResizableBuffer"), memory, []) as ArrayBufferLike;
      expect(Reflect.get(backing, kind)).toBe(true);
      host.attach(memory);
      const slots = host.slots();
      const natives = host.engineNet().natives;
      const call = (name: string, ...args: unknown[]) => Reflect.apply(natives[name]!, null, args);
      const decoded: ArrayBufferLike[] = [];
      const nativeDecode = TextDecoder.prototype.decode;
      const strict = spyOn(TextDecoder.prototype, "decode").mockImplementation(function (this: TextDecoder, input, options) {
        const buffer = ArrayBuffer.isView(input) ? input.buffer : input;
        if (buffer) {
          if (Reflect.get(buffer, "resizable") || Reflect.get(buffer, "growable")) throw new TypeError("resizable or growable BufferSource is not allowed");
          decoded.push(buffer);
        }
        return nativeDecode.call(this, input, options);
      });
      try {
        const checkGuestMemoryRound = (round: number) => {
          if (round) memory.grow(1);
          const ptr = round * 65536 + 128;
          const text = operation === "fetch" ? JSON.stringify({ url: "https://network.invalid/", method: "POST" }) : "localhost";
          const source = encode(text);
          const body = encode("request body");
          const bytes = new Uint8Array(backing);
          bytes.fill(0xff, ptr - 1, ptr + source.length + 1);
          bytes.set(source, ptr);
          bytes.set(body, ptr + 1000);
          if (operation === "fetch") {
            const handle = slots.fetch!(ptr, source.length, ptr + 1000, body.length);
            expect(handle).toBeGreaterThan(0);
            expect(messages.at(-1)).toMatchObject({ type: "fetch", url: "https://network.invalid/", body });
            expect(bytes.subarray(ptr + 1000, ptr + 1000 + body.length)).toEqual(body);
            expect(call("hostClose", handle)).toBe(0);
            const nativeHandle = call("hostFetch", text, bytes.subarray(ptr + 1000, ptr + 1000 + body.length));
            expect(nativeHandle).toBeGreaterThan(0);
            expect(messages.at(-1)).toMatchObject({ type: "fetch", body });
            expect(slots.close!(nativeHandle)).toBe(0);
          } else {
            const listener = operation === "listen" ? slots.listen!(ptr, source.length, 0) : call("hostListen", "localhost", 0);
            const port = call("hostLocalPort", listener);
            const client = operation === "connect" ? slots.connect!(ptr, source.length, port) : call("hostConnect", "localhost", port);
            const server = call("hostAccept", listener);
            expect(client).toBeGreaterThan(0);
            expect(server).toBeGreaterThan(0);
            expect(JSON.parse(call("hostPeerAddr", client)).port).toBe(port);
            expect(JSON.parse(call("hostLocalAddr", server)).port).toBe(port);
            for (const handle of [client, server, listener]) expect(slots.close!(handle)).toBe(0);
          }
          expect(decoded).toHaveLength(round + 1);
          const copy = decoded[round]!;
          expect(copy).not.toBe(backing);
          expect(Object.prototype.toString.call(copy)).toBe("[object ArrayBuffer]");
          expect(Reflect.get(copy, "resizable")).toBe(false);
          expect(new Uint8Array(copy)).toEqual(source);
        };
        for (let round = 0; round < 2; round++) checkGuestMemoryRound(round);
      } finally {
        strict.mockRestore();
      }
      expect(TextDecoder.prototype.decode).toBe(nativeDecode);
    });
  }

}

test("Bun sized-result slots return full length without overwriting a small buffer", async () => {
  const sab = createRing();
  const host = new NetHost(sab, () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const bytes = new Uint8Array(memory.buffer);
  const meta = encode(JSON.stringify({ url: "https://network.invalid/" }));
  bytes.set(meta, 32);
  const slots = host.slots();
  const handle = slots.fetch!(32, meta.length, 0, 0);
  expect(slots.fetch_head!(handle, 1000, 100)).toBe(AGAIN);
  const writer = new RingWriter(sab);
  try {
    const head = encode('{"status":201,"headers":[]}');
    await writer.write(handle, Kind.Head, head);
    bytes.fill(0x7f, 1000, 1100);
    expect(slots.fetch_head!(handle, 1000, head.length - 1)).toBe(head.length);
    expect(bytes.subarray(1000, 1000 + head.length)).toEqual(new Uint8Array(head.length).fill(0x7f));
    expect(slots.fetch_head!(handle, 1000, head.length)).toBe(head.length);
    expect(bytes.subarray(1000, 1000 + head.length)).toEqual(head);
    await writer.write(handle, Kind.Data, encode("hello"));
    expect(slots.read!(handle, 1200, 3)).toBe(3);
    expect(decode(bytes.subarray(1200, 1203))).toBe("hel");
    expect(slots.read!(handle, 1200, 3)).toBe(2);
    expect(decode(bytes.subarray(1200, 1202))).toBe("lo");
    expect(slots.read!(999, 1200, 3)).toBe(BADF);
  } finally {
    writer.dispose();
  }
});

test("Bun pointer slots and browser natives share the same generic handle state", () => {
  const host = new NetHost(createRing(), () => {});
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const slots = host.slots();
  const api = host.engineNet().natives;
  const call = (name: string, ...args: unknown[]) => Reflect.apply(api[name]!, null, args);
  const hostname = encode("localhost");
  new Uint8Array(memory.buffer).set(hostname, 128);
  const listener = slots.listen!(128, hostname.length, 0);
  const port = call("hostLocalPort", listener);
  const client = call("hostConnect", "localhost", port);
  const server = slots.accept!(listener);
  const request = encode("request");
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(request, 256);
  expect(slots.write!(client, 256, request.length)).toBe(request.length);
  bytes.fill(0, 256, 256 + request.length);
  expect(call("hostRead", server)).toEqual(request);
  const response = encode("response");
  expect(call("hostWrite", server, response)).toBe(response.length);
  response.fill(0);
  memory.grow(1);
  expect(slots.read!(client, 65536, 100)).toBe(8);
  expect(decode(new Uint8Array(memory.buffer, 65536, 8))).toBe("response");
  const length = slots.local_addr!(server, 66000, 200);
  expect(JSON.parse(decode(new Uint8Array(memory.buffer, 66000, length))).port).toBe(port);
  for (const handle of [client, server, listener]) expect(slots.close!(handle)).toBe(0);
});

test("Bun browser-native names and capability flags remain in the adapter", () => {
  const net = new NetHost(createRing(), () => {}).engineNet();
  const call = (name: string, ...args: unknown[]) => Reflect.apply(net.natives[name]!, null, args);
  expect(call("hostPoll")).toBe(UNSUPPORTED);
  expect(call("hostFetch", "malformed")).toBe(-1);
  expect(JSON.parse(call("hostError", 0)).message).toContain("malformed request metadata");
  expect(net.caps.poll).toBe(false);
  // Signals and processes are the guest's own runtime_proc imports, not host network capabilities.
  expect(Object.hasOwn(net.caps, "signal")).toBe(false);
  expect(Object.keys(net.caps).some(name => name.startsWith("proc_") || name.startsWith("child_") || name === "spawn")).toBe(false);
  expect(net.caps.fetch).toBe(true);
  expect(net.caps.connect).toBe(true);
  expect(net.caps.lookup_start).toBe(true);
  expect(net.caps.lookup_head).toBe(true);
  expect(net.natives.hostLookup).toBeUndefined();
  expect(typeof net.onNews).toBe("function");
});

test("Bun helper keeps installer cache policy outside the generic runtime", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  const opened: string[] = [];
  const cache = {
    async match(url: string) {
      expect(url).toBe("https://network.invalid/pkg.tgz");
      return new Response("cached tarball");
    },
  };
  const sab = createRing();
  const namespace = await NetNamespace.create();
  const helper = new NetHelper(sab, namespace);
  const host = new RuntimeNetHost(sab, (request) => helper.handle(request));
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open(name: string) { opened.push(name); return cache; } } });
    globalThis.fetch = Object.assign(async () => { throw new Error("Installer should use the cached response"); }, { preconnect: fetch.preconnect });
    const handle = host.fetch(JSON.stringify({ url: "https://network.invalid/pkg.tgz", headers: [["accept", "application/vnd.bun.install-tarball"]] }));
    await until(() => typeof host.fetchHead(handle) !== "number");
    let body: Uint8Array | number = AGAIN;
    await until(() => { body = host.read(handle, 65536); return body instanceof Uint8Array; });
    if (typeof body === "number") throw new Error("Expected cached body");
    expect(decode(body)).toBe("cached tarball");
    expect(opened).toEqual(["bun-wasm-install-v1"]);
  } finally {
    try { helper.dispose(); }
    finally { namespace.dispose(); }
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});

test("Bun helper publishes head and first body chunk before a cold cache reaches EOF", async () => {
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const originalFetch = globalThis.fetch;
  const eof = deferred<void>();
  let cachePutStarted = false;
  let cachePutFinished = false;
  let upstreamCancelled = false;
  let sourceClosed = false;
  const cache = {
    async match() { return undefined; },
    async put(_url: string, response: Response) {
      cachePutStarted = true;
      await response.arrayBuffer();
      cachePutFinished = true;
    },
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encode("first adapter chunk"));
      eof.promise.then(() => {
        if (sourceClosed) return;
        sourceClosed = true;
        try { controller.close(); } catch { /* close raced with cancellation */ }
      });
    },
    cancel() {
      upstreamCancelled = true;
      sourceClosed = true;
      eof.resolve();
    },
  });
  const namespace = await NetNamespace.create();
  const ring = createRing();
  const helper = new NetHelper(ring, namespace);
  const host = new RuntimeNetHost(ring, request => helper.handle(request));
  let handle = 0;
  try {
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open() { return cache; } } });
    globalThis.fetch = Object.assign(async () => new Response(body, { status: 200, headers: { "x-stream": "held" } }), { preconnect: originalFetch.preconnect });
    handle = host.fetch(JSON.stringify({ url: "https://network.invalid/pkg.tgz", method: "GET", headers: [["accept", "application/vnd.bun.install-tarball"]] }));
    await until(() => typeof host.fetchHead(handle) !== "number", 1000);
    const head = host.fetchHead(handle);
    if (typeof head === "number") throw new Error("Expected response head");
    expect(JSON.parse(decode(head))).toMatchObject({ status: 200, headers: [["x-stream", "held"]] });
    let first: Uint8Array | number = AGAIN;
    await until(() => { first = host.read(handle, 65536); return first instanceof Uint8Array; }, 1000);
    if (typeof first === "number") throw new Error("Expected response body");
    expect(decode(first)).toBe("first adapter chunk");
    expect(cachePutStarted).toBe(false);
    expect(cachePutFinished).toBe(false);
    expect(upstreamCancelled).toBe(false);
    host.close(handle);
    await until(() => upstreamCancelled, 1000);
    expect(cachePutStarted).toBe(false);
  } finally {
    if (handle) host.close(handle);
    helper.dispose();
    namespace.dispose();
    globalThis.fetch = originalFetch;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});


test("paired DNS slots share runtime lookup handles, pending state and sized reads after memory growth", async () => {
  const runtime = processRuntimeFixture({});
  const ring = createRing();
  const helper = createBunNetworkHelper(await runtime.network(), ring);
  const host = new NetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }), undefined, { shared: true });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  host.attach(memory);
  const slots = host.slots();
  const hostname = encode("localhost");
  new Uint8Array(memory.buffer).set(hostname, 123);
  try {
    const handle = slots.lookup_start!(123, hostname.length, 4, 0);
    expect(handle).toBeGreaterThan(0);
    expect(slots.lookup_head!(handle, 1000, 0)).toBe(AGAIN);
    await until(() => slots.lookup_head!(handle, 1000, 0) !== AGAIN);
    memory.grow(1);
    const bytes = new Uint8Array(memory.buffer);
    const length = slots.lookup_head!(handle, 65536, 0);
    expect(length).toBeGreaterThan(0);
    bytes.fill(0x7f, 65536, 65536 + length);
    expect(slots.lookup_head!(handle, 65536, length - 1)).toBe(length);
    expect(bytes.subarray(65536, 65536 + length)).toEqual(new Uint8Array(length).fill(0x7f));
    expect(slots.lookup_head!(handle, 65536, length)).toBe(length);
    expect(JSON.parse(decode(bytes.subarray(65536, 65536 + length)))).toEqual({ addresses: [{ address: "127.0.0.1", family: 4 }] });
    expect(slots.lookup_head!(handle, 65536, length)).toBe(length);
    expect(slots.close!(handle)).toBe(0);
    expect(slots.lookup_head!(handle, 65536, length)).toBe(BADF);
    expect(slots.lookup_start!(123, hostname.length, 7, 0)).toBe(UNSUPPORTED);
  } finally { helper.dispose(); await runtime.dispose(); }
});

test("paired DNS preserves runtime errors and suppresses a closed pending lookup", async () => {
  const runtime = processRuntimeFixture({});
  const ring = createRing();
  const helper = createBunNetworkHelper(await runtime.network(), ring);
  const host = new NetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }));
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.attach(memory);
  const slots = host.slots();
  const hostname = encode("unsupported.example");
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(hostname, 16);
  try {
    const failed = slots.lookup_start!(16, hostname.length, 0, 0);
    await until(() => slots.lookup_head!(failed, 1000, 0) !== AGAIN);
    expect(slots.lookup_head!(failed, 1000, 0)).toBe(-1);
    const size = slots.error!(failed, 1000, 4096);
    expect(JSON.parse(decode(bytes.subarray(1000, 1000 + size)))).toMatchObject({ code: "ENOTSUP", syscall: "getaddrinfo", hostname: "unsupported.example" });
    expect(slots.close!(failed)).toBe(0);
    const cancelled = slots.lookup_start!(16, hostname.length, 0, 0);
    expect(slots.close!(cancelled)).toBe(0);
    await Bun.sleep(0);
    expect(slots.lookup_head!(cancelled, 1000, 4096)).toBe(BADF);
    expect(slots.error!(cancelled, 1000, 4096)).toBe(BADF);
  } finally { helper.dispose(); await runtime.dispose(); }
});

test("network request guard accepts lookup options and refuses malformed lookup messages", async () => {
  const runtime = processRuntimeFixture({});
  const helper = createBunNetworkHelper(await runtime.network(), createRing());
  try {
    for (const req of [
      { type: "lookup", id: 1, hostname: 1, options: {} },
      { type: "lookup", id: 1, hostname: "localhost", options: null },
      { type: "lookup", id: 1, hostname: "localhost", options: { family: 7 } },
      { type: "lookup", id: 1, hostname: "localhost", options: { hints: NaN } },
    ]) expect(() => dispatchBunNetwork(helper, { type: "net", req })).toThrow("Invalid Bun network request");
    expect(() => dispatchBunNetwork(helper, { type: "net", req: { type: "lookup", id: 1, hostname: "localhost", options: { family: 4, hints: 0 } } })).not.toThrow();
  } finally { helper.dispose(); await runtime.dispose(); }
});


test("the exact guest lookup factory decodes the real runtime helper result and closes once", async () => {
  const owner = await createRuntimeNetwork(() => {});
  const ring = createRing();
  const helper = createBunNetworkHelper(owner.network, ring);
  const host = new NetHost(ring, req => dispatchBunNetwork(helper, { type: "net", req }));
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  host.attach(memory);
  const slots = host.slots();
  const hostname = encode("localhost");
  new Uint8Array(memory.buffer).set(hostname, 123);
  const waiters = new Set<{ step(): boolean }>();
  const closed: number[] = [];
  const native = {
    hostCaps: Object.fromEntries(Object.keys(slots).map(name => [name, true])),
    hostLookupStart: () => slots.lookup_start!(123, hostname.length, 4, 0),
    hostLookupHead(handle: number) {
      const size = slots.lookup_head!(handle, 65536, 0);
      if (size < 0) return size;
      expect(slots.lookup_head!(handle, 65536, size - 1)).toBe(size);
      expect(slots.lookup_head!(handle, 65536, size)).toBe(size);
      return decode(new Uint8Array(memory.buffer, 65536, size));
    },
    hostClose(handle: number) { closed.push(handle); return slots.close!(handle); },
  };
  const net = {
    addWaiter<T extends { step(): boolean }>(waiter: T): T { waiters.add(waiter); return waiter; },
    removeWaiter(waiter: { step(): boolean }) { waiters.delete(waiter); },
  };
  try {
    const source = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/host_lookup.ts", import.meta.url), "utf8");
    const factory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${source}`), { Array, Error, JSON, Object, Promise, TypeError });
    factory({ native, require: () => net }).install();
    const lookup = Reflect.get(native, "hostLookup");
    if (typeof lookup !== "function") throw new Error("Guest factory did not install hostname lookup");
    const completion: Promise<unknown> = lookup("localhost", 4, 0);
    memory.grow(1);
    await until(() => {
      for (const waiter of Array.from(waiters)) waiter.step();
      return waiters.size === 0;
    });
    await expect(completion).resolves.toEqual([{ address: "127.0.0.1", family: 4 }]);
    expect(closed).toHaveLength(1);
    expect(slots.lookup_head!(closed[0]!, 65536, 0)).toBe(BADF);
  } finally { try { helper.dispose(); } finally { await owner.dispose(); } }
});


async function fetchBody(host: RuntimeNetHost, handle: number): Promise<string> {
  await until(() => typeof host.fetchHead(handle) !== "number", 1000);
  let body: Uint8Array | number = AGAIN;
  await until(() => { body = host.read(handle, 65536); return body instanceof Uint8Array; });
  if (typeof body === "number") throw new Error("Expected early request body");
  return decode(body);
}

test("standalone CLI helper handles requests sent immediately after initialization", async () => {
  const ring = createRing();
  const worker = new Worker(new URL("../scripts/net-helper.ts", import.meta.url).href);
  try {
    worker.postMessage({ type: "init", ring });
    const host = new RuntimeNetHost(ring, (request, transfer = []) => worker.postMessage(request, transfer));
    const bodies = ["first early request", "second early request"];
    const requests = bodies.map(body => ({ handle: host.fetch(JSON.stringify({ url: `data:text/plain,${encodeURIComponent(body)}` })), body }));
    for (const { handle, body } of requests) {
      expect(await fetchBody(host, handle)).toBe(body);
      host.close(handle);
    }
  } finally { await worker.terminate(); }
});

test("process fixture shares one awaited network capability across concurrent callers", async () => {
  const runtime = processRuntimeFixture({});
  try {
    const [first, second] = await Promise.all([runtime.network(), runtime.network()]);
    expect(first).toBe(second);
  } finally { await runtime.dispose(); }
});

test("process fixture rejects network admission before native namespace creation when disposed", async () => {
  const create = spyOn(NetNamespace, "create");
  const dispose = spyOn(NetNamespace.prototype, "dispose");
  const runtime = processRuntimeFixture({});
  const pending = runtime.network();
  const disposal = runtime.dispose();
  try {
    await expect(pending).rejects.toThrow("Runtime is disposed");
    const creation = create.mock.results[0]?.value;
    if (!(creation instanceof Promise)) throw new Error("Expected namespace initialization");
    const observed: Promise<unknown> = creation;
    const [admission, cancellation] = await Promise.all([pending.catch(error => error), observed.catch(error => error)]);
    expect(admission).toBe(cancellation);
    expect(dispose).not.toHaveBeenCalled();
    await disposal;
  } finally {
    await runtime.dispose();
    create.mockRestore();
    dispose.mockRestore();
  }
});


test("process fixture owns one namespace and disposes it after its helpers", async () => {
  const create = spyOn(NetNamespace, "create");
  const dispose = spyOn(NetNamespace.prototype, "dispose");
  const runtime = processRuntimeFixture({});
  try {
    const [first, second] = await Promise.all([runtime.network(), runtime.network()]);
    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
    const helper = createBunNetworkHelper(first, createRing());
    helper.dispose();
    expect(dispose).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.dispose();
    const created = create.mock.results[0]?.value;
    if (!dispose.mock.calls.length && created instanceof Promise) {
      const namespace: unknown = await created;
      if (namespace instanceof NetNamespace) namespace.dispose();
    }
    create.mockRestore();
    dispose.mockRestore();
  }
});


test("process fixture preserves helper failure identity and still disposes its namespace", async () => {
  const runtime = processRuntimeFixture({});
  const network = await runtime.network();
  const stopped = new Error("listener cleanup failed");
  const helper = createBunNetworkHelper(network, createRing(), { stopped() { throw stopped; } });
  const namespaceDispose = spyOn(NetNamespace.prototype, "dispose");
  try {
    helper.handle({ type: "listen", id: 1, host: "127.0.0.1", port: 0 });
    const failure: unknown = await runtime.dispose().catch(error => error);
    if (!(failure instanceof AggregateError)) throw new Error("Expected listener cleanup failure");
    expect(cleanupFailures(failure)).toEqual([stopped]);
    await expect(runtime.dispose()).rejects.toBe(failure);
    expect(namespaceDispose).toHaveBeenCalledTimes(1);
  } finally {
    await runtime.dispose().catch(() => {});
    namespaceDispose.mockRestore();
  }
});


function cleanupFailures(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) return [error];
  return error.errors.flatMap(cleanupFailures);
}
