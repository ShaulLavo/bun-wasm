import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../src/buffer-transfer";
import * as lookupBridge from "../src/net/lookup";
import { createScriptEvaluation } from "../src/script-evaluation.ts";

type LookupMessage = Parameters<Parameters<typeof lookupBridge.installLookupServer>[0]["postMessage"]>[0];
type LookupRequest = Extract<LookupMessage, { type: "bun-dns-lookup" }>;
type LookupResponse = Extract<LookupMessage, { type: "bun-dns-lookup-result" }>;
type LookupKind = "callback" | "promise" | "bun";

const engineSource = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const EngineHost = runInNewContext(engineSource + "\nEngineHost;", {
  TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask, SLOT_NAMES: [], Atomics,
  isWasmMemoryBuffer, transferArrayBuffers, createScriptEvaluation, ...lookupBridge,
});
const dnsSource = readFileSync(new URL("../../crates/bunwasm-runtime/src/js/dns.ts", import.meta.url), "utf8");
const dnsFactory = runInNewContext(new Bun.Transpiler({ loader: "ts" }).transformSync(`globalThis.factory = ${dnsSource}`));

async function verifyLookupLifetime(kind: LookupKind, rejects: boolean) {
  const channel = new MessageChannel();
  const lookup = lookupBridge.createLookupClient(channel.port2);
  const received = Promise.withResolvers<LookupRequest>();
  channel.port1.onmessage = event => received.resolve(event.data);
  const events: string[] = [];
  const exited = Promise.withResolvers<number>();
  // Only the unrelated guest ABI and timer/I/O providers are stubs. Host accounting and turns are real.
  const host = Object.assign(Object.create(EngineHost.prototype), {
    o: { net: { natives: { hostLookup: lookup }, caps: {}, onNews() {} }, onExit(code: number) {
      events.push(`exit:${code}`);
      lookup.close();
      exited.resolve(code);
    } },
    wasm: { call() {} }, pendingAsync: 0, testComplete: false, exited: false, timer: null,
    idleWait: true, installSubtleCrypto() {}, resolveDone() {},
    internal: { pumpSignals() {}, runTimers: () => -1, ioPending: () => 0, emitBeforeExit: () => false, beforeExit: () => 0 },
  });
  host.native = Object.assign(host.buildNative({ natives: [], constants: { hostCaps: {} } }), {
    tlsDispose() {}, closeAllDirs() {}, flushOutput() {},
  });
  const facade = dnsFactory({ native: host.native, describe: String, require: () => ({ isIP: () => 0 }),
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]) { queueMicrotask(() => callback(...args)); },
  });
  const delivered = Promise.withResolvers<unknown>();
  const observe = (error: unknown, result: unknown, family?: number) => {
    if (kind === "callback" && !error) expect(family).toBe(4);
    events.push(error ? "lookup:error" : "lookup:success");
    delivered.resolve(error ?? result);
  };
  try {
    if (kind === "callback") facade.module().lookup("localhost", observe);
    else {
      const pending = kind === "promise" ? facade.promises().lookup("localhost") : facade.bun().lookup("localhost");
      pending.then((result: unknown) => observe(null, result), (error: unknown) => observe(error, undefined));
    }
    const request = await received.promise;
    expect(request).toMatchObject({ hostname: "localhost", family: 0, hints: 0 });
    host.pump();
    expect(host.exited).toBe(false);
    expect(host.pendingAsync).toBe(1);
    expect(events).toEqual([]);
    const response: LookupResponse = rejects
      ? { type: "bun-dns-lookup-result", id: request.id, error: { name: "RuntimeNetworkLookupError", message: "unsupported", code: "ENOTSUP", syscall: "getaddrinfo", hostname: "localhost" } }
      : { type: "bun-dns-lookup-result", id: request.id, result: [{ address: "127.0.0.1", family: 4 }] };
    channel.port1.postMessage(response);
    const result = await delivered.promise;
    if (rejects) expect(result).toMatchObject({ code: "ENOTSUP", syscall: "getaddrinfo", hostname: "localhost" });
    else expect(result).toEqual(kind === "callback" ? "127.0.0.1" : kind === "bun" ? [{ address: "127.0.0.1", family: 4 }] : { address: "127.0.0.1", family: 4 });
    expect(await exited.promise).toBe(0);
    expect(host.pendingAsync).toBe(0);
    expect(events).toEqual([rejects ? "lookup:error" : "lookup:success", "exit:0"]);
  } finally {
    host.exit(0);
    lookup.close();
    channel.port1.close();
    channel.port2.close();
  }
}

for (const kind of ["callback", "promise", "bun"] as const) for (const rejects of [false, true]) {
  test(`${kind} lookup holds the real engine loop until a delayed ${rejects ? "error" : "result"} reply`, () => verifyLookupLifetime(kind, rejects));
}
