import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPageSuite, type DriverCleanup } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { prepareProcessBundle, processDirectoryAssets } from "../web/tests/process-page-assets";
import { runtimeProcAdapter } from "../web/tests/runtime-proc-ios-adapter";
import { runtimeProcFilesystemName, runtimeProcIds } from "../web/tests/runtime-proc-page-contract";

let output: string | undefined;
let producer: Promise<void> | undefined;
let assets: Record<string, Blob>;
const preparation = new AbortController();
beforeAll(async () => {
  output = await mkdtemp(join(tmpdir(), "brp-"));
  const out = join(output, "runtime-proc");
  producer = prepareProcessBundle(out, preparation.signal, "runtime-proc");
  await producer;
  assets = await processDirectoryAssets(out, preparation.signal);
}, 30_000);
afterAll(async () => {
  preparation.abort();
  await producer?.catch(() => undefined);
  if (output) await rm(output, { recursive: true, force: true });
});

const sentinel = `return (async () => {
  const name = "runtime-proc-foreign-sentinel";
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sentinel");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const tx = db.transaction("sentinel", "readwrite");
  tx.objectStore("sentinel").put("retained", "key");
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close(); return true;
})();`;
const verify = `return (async () => {
  const names = (await indexedDB.databases()).map(db => db.name);
  if (JSON.stringify(names) !== JSON.stringify(["runtime-proc-foreign-sentinel"])) throw Error("Owned database remains or sentinel vanished: " + JSON.stringify(names));
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("runtime-proc-foreign-sentinel");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const value = await new Promise((resolve, reject) => {
    const request = db.transaction("sentinel").objectStore("sentinel").get("key");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  db.close(); if (value !== "retained") throw Error("Foreign value changed"); return true;
})();`;

type Control = "observe" | "assertion" | "late-console";
class ObservedDriver extends PlaywrightDriver {
  seeded = false;
  verified = false;
  injected = false;
  roles: unknown[] = [];
  private checkedStop: Promise<DriverCleanup> | undefined;
  constructor(engine: "chromium" | "webkit", scratch: string, private control: Control) { super(engine, scratch); }
  override async navigate(url: string, signal: AbortSignal) {
    if (!this.seeded) {
      await super.navigate(`${new URL(url).origin}/control.html`, signal);
      await super.script(sentinel, signal);
      this.seeded = true;
    }
    await super.navigate(url, signal);
    const state = await super.script('return { role: window.__suiteConfiguration.role, fixture: typeof globalThis.runtimeProcDiagnostics, nativeWorker: Function.prototype.toString.call(Worker).includes("[native code]") }', signal);
    if (!state || typeof state !== "object" || !("role" in state)) throw Error("Missing hosted role");
    this.roles.push(state.role);
    if (state.role === "case") return;
    expect(state).toMatchObject({ fixture: "undefined", nativeWorker: true });
    await super.script(verify, signal);
  }
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    if (this.control === "late-console" && !this.injected) await this.injectError(signal);
    return super.script(source, signal);
  }
  private async injectError(signal: AbortSignal) {
    if (await super.script("return globalThis.runtimeProcResult?.ok === true", signal) !== true) return;
    this.injected = true;
    await super.script('console.error("RUNTIME_PROC_LATE_CONSOLE_CONTROL"); return true;', signal);
  }
  override stop(): Promise<DriverCleanup> { return this.checkedStop ??= this.verifyStop(); }
  private async verifyStop(): Promise<DriverCleanup> {
    let cleanup: DriverCleanup;
    try {
      if (this.seeded) this.verified = await super.script(verify, AbortSignal.timeout(10_000)) === true;
    } finally { cleanup = await super.stop(); }
    return cleanup;
  }
}

for (const { engine, control, exit } of [
  { engine: "chromium", control: "observe", exit: 0 },
  { engine: "webkit", control: "observe", exit: 0 },
  { engine: "chromium", control: "assertion", exit: 1 },
  { engine: "chromium", control: "late-console", exit: 2 },
] as const) {
  test(`runtime-proc hosted ${engine} ${control} retains the original four rows and owned cleanup`, async () => {
    if (!output) throw Error("runtime-proc assets missing");
    let driver: ObservedDriver | undefined;
    const adapter = { ...runtimeProcAdapter, policy: { ...runtimeProcAdapter.policy, check(id: string, value: unknown) {
      runtimeProcAdapter.policy.check(id, value);
      if (control === "assertion") throw Error("RUNTIME_PROC_HOST_ASSERTION_CONTROL");
    } } };
    const result = await runPageSuite(adapter, scratch => driver = new ObservedDriver(engine, scratch, control), {
      resultPath: join(output, `${engine}-${control}.json`), port: "ephemeral", scratchRoot: tmpdir(),
      assets: { ...assets, "/control.html": new Blob(["<!doctype html>"], { type: "text/html" }) },
    });
    expect({ exit: result.exit, failures: result.failures }).toMatchObject({ exit });
    expect(result.required).toEqual(runtimeProcIds);
    expect(result.selected).toEqual(runtimeProcIds);
    expect(result.storageRemaining).toEqual([]);
    expect(result.ledger).toEqual([{ kind: "indexeddb", name: runtimeProcFilesystemName(result.run) }]);
    expect(driver?.verified).toBe(true);
    if (control === "observe") {
      expect(driver?.roles).toEqual(["list", "case", "case", "case", "case", "finish"]);
      expect(Object.keys(result.results)).toEqual(runtimeProcIds);
      for (const id of runtimeProcIds) runtimeProcAdapter.policy.check(id, result.results[id]);
    }
    if (control === "late-console") expect(driver?.injected).toBe(true);
    for (const key of ["session", "launcher", "server", "storage", "scratch"] as const) expect(result.cleanup[key].status).toBe("confirmed");
    for (const key of ["fixture", "callbacks"] as const) expect(result.cleanup[key].status).toBe("not-created");
  }, 180_000);
}
