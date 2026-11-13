import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { RecordHost } from "../src/module-records.ts";

const source = readFileSync(new URL("../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");

function method(value: unknown, name: string): (...args: unknown[]) => unknown {
  assert.ok(value && typeof value === "object");
  const fn: unknown = Reflect.get(value, name);
  assert.ok(typeof fn === "function");
  return (...args) => Reflect.apply(fn, value, args);
}

function fixture(moduleUrls: "blob" | "data" = "blob") {
  const live = new Map<string, Blob>();
  const revoked: string[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let importFailure: unknown;
  class ObservedURL extends URL {
    static override createObjectURL(blob: Blob): string {
      const url = URL.createObjectURL(blob);
      live.set(url, blob);
      return url;
    }
    static override revokeObjectURL(url: string): void {
      revoked.push(url);
      live.delete(url);
      URL.revokeObjectURL(url);
    }
  }
  const context = createContext({
    TextEncoder, TextDecoder, URL: ObservedURL, Blob, setTimeout, clearTimeout, queueMicrotask,
    SLOT_NAMES: [], createModuleRecords: (host: RecordHost) => host,
  });
  const prototype: unknown = runInContext(source + "\nEngineHost.prototype;", context, {
    async importModuleDynamically(url: string) {
      const base = url.slice(0, url.indexOf("#"));
      const blob = live.get(base);
      const code = blob ? await blob.text() : undefined;
      started.resolve();
      await release.promise;
      try {
        if (code === undefined) return await import(base);
        return await import(`data:text/javascript,${encodeURIComponent(code + `\n//# sourceURL=${url}`)}`);
      } catch (error) { importFailure = error; throw error; }
    },
  });
  assert.ok(prototype && typeof prototype === "object");
  const makeURL: unknown = Reflect.get(prototype, "url");
  const createRecords: unknown = Reflect.get(prototype, "createRecords");
  assert.ok(typeof makeURL === "function");
  assert.ok(typeof createRecords === "function");
  const paths = new Map<string, string>();
  const owner = {
    o: { moduleUrls }, paths, native: {}, evalPolyfill() {},
    url(code: string, key: string): unknown { return Reflect.apply(makeURL, this, [code, key]); },
  };
  const records: unknown = Reflect.apply(createRecords, owner, []);
  return {
    live, revoked, paths, started: started.promise, release: () => release.resolve(),
    failure: () => importFailure,
    poisonRevoker() {
      ObservedURL.revokeObjectURL = () => { throw new Error("guest revoker"); };
      runInContext('String.prototype.slice = String.prototype.indexOf = () => { throw new Error("guest string method"); };', context);
    },
    evaluate(code: string, key: string) {
      return new Promise<unknown>((resolve, reject) => method(records, "evaluate")(code, key, resolve, reject));
    },
    cleanup() { for (const url of live.keys()) URL.revokeObjectURL(url); },
  };
}

test("record imports release source Blobs after settlement and retain functions and stack names", async () => {
  const host = fixture();
  const loading = host.evaluate('export default function retained() { throw new Error("retained record"); }', "/retained.mjs");
  try {
    await host.started;
    expect(host.live.size).toBe(1);
    expect(host.revoked).toEqual([]);
    const url = host.live.keys().next().value;
    assert.ok(url);
    host.poisonRevoker();
    host.release();
    const record = await loading;
    expect(host.live.size).toBe(0);
    expect(host.revoked).toEqual([url]);
    expect(host.paths.get(url)).toBe("/retained.mjs");
    assert.ok(typeof record === "function");
    assert.throws(() => Reflect.apply(record, undefined, []), error => {
      assert.ok(error instanceof Error);
      expect(error.message).toBe("retained record");
      expect(decodeURIComponent(error.stack ?? "")).toContain(url);
      return true;
    });
  } finally { host.release(); host.cleanup(); }
});

test("a rejected record import releases its Blob and a new import can succeed", async () => {
  const host = fixture();
  const loading = host.evaluate("export default ;", "/retry.mjs").catch(error => error);
  try {
    await host.started;
    expect(host.live.size).toBe(1);
    host.release();
    expect(await loading).toBe(host.failure());
    expect(host.failure()).toBeDefined();
    expect(host.live.size).toBe(0);
    expect(await host.evaluate("export default 42;", "/retry.mjs")).toBe(42);
    expect(host.live.size).toBe(0);
    expect(host.revoked).toHaveLength(2);
    expect(host.paths.size).toBe(2);
  } finally { host.release(); host.cleanup(); }
});

test("data URL record imports keep working without source Blobs", async () => {
  const host = fixture("data");
  const loading = host.evaluate("export default 7;", "/data.mjs");
  try {
    await host.started;
    host.release();
    expect(await loading).toBe(7);
    expect(host.live.size).toBe(0);
    expect(host.revoked).toEqual([]);
  } finally { host.release(); host.cleanup(); }
});
