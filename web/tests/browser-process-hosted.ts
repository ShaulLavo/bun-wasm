import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { runPageSuite, writeResult, type DriverCleanup, type RunOptions } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { processAdapter } from "./process-ios-adapter";
import { checkProcessResult, processCommandId, processFilesystemName } from "./process-page-adapter";

type Engine = "chromium" | "webkit";
type Control = "observe" | "assertion" | "late-error" | "delayed-finish";
type Observations = { roles: string[]; foreignSurvived: boolean; lateError: boolean; failure: string | null };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

const seed = `
window.__bunProcessControl = { done: false, error: null };
void (async () => {
  if ((await indexedDB.databases()).some(db => db.name === "waffle-workspace")) throw Error("Control does not own pre-existing default database");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("waffle-workspace", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("control");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("control", "readwrite");
      transaction.objectStore("control").put("bun-process-foreign-sentinel", "sentinel");
      transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
})().catch(error => { window.__bunProcessControl.error = String(error); }).finally(() => { window.__bunProcessControl.done = true; });
return true;`;
const names = `
window.__bunProcessControl = { done: false, error: null };
void indexedDB.databases().then(databases => { window.__bunProcessControl.names = databases.map(db => db.name).sort(); })
.catch(error => { window.__bunProcessControl.error = String(error); }).finally(() => { window.__bunProcessControl.done = true; });
return true;`;
const verifyAndDeleteSentinel = `
window.__bunProcessControl = { done: false, error: null };
void (async () => {
  if (!(await indexedDB.databases()).some(db => db.name === "waffle-workspace")) throw Error("Foreign sentinel database disappeared");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("waffle-workspace");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction("control").objectStore("control").get("sentinel");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    if (value !== "bun-process-foreign-sentinel") throw Error("Foreign sentinel value changed: " + String(value));
  } finally { db.close(); }
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("waffle-workspace");
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  if ((await indexedDB.databases()).some(db => db.name === "waffle-workspace")) throw Error("Owned sentinel cleanup failed");
})().catch(error => { window.__bunProcessControl.error = String(error); }).finally(() => { window.__bunProcessControl.done = true; });
return true;`;

class ObservedProcessDriver extends PlaywrightDriver {
  private seeded = false;
  private role = "";
  private observationStop: Promise<DriverCleanup> | undefined;
  constructor(engine: Engine, scratch: string, private observations: Observations, private control: Control) { super(engine, scratch); }

  private async dispatch(source: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    await super.script(source, signal);
    const deadline = performance.now() + 10_000;
    for (;;) {
      signal.throwIfAborted();
      const state = await super.script("return window.__bunProcessControl", signal);
      if (!record(state)) throw new Error("Control state missing");
      if (state.done === true) {
        if (state.error !== null) throw new Error(String(state.error));
        return state;
      }
      if (performance.now() >= deadline) throw new Error("Bun process control timed out");
      await Bun.sleep(10);
    }
  }

  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (!this.seeded) {
      await super.navigate(`${new URL(url).origin}/process-control.html`, signal);
      await this.dispatch(seed, signal);
      this.seeded = true;
    }
    await super.navigate(url, signal);
    const state = await super.script('return { role: window.__suiteConfiguration.role, progress: typeof globalThis.processProgress, nativeWorker: Function.prototype.toString.call(Worker).includes("[native code]") }', signal);
    if (!record(state) || typeof state.role !== "string") throw new Error("Hosted role missing");
    this.role = state.role;
    this.observations.roles.push(state.role);
    if (state.role === "case") return;
    assert.equal(state.progress, "undefined", "list/finish must not invoke the original envelope");
    assert.equal(state.nativeWorker, true, "list/finish must not replace Worker");
    if (state.role !== "list") return;
    const databases = await this.dispatch(names, signal);
    assert.deepEqual(databases.names, ["waffle-workspace"], "list must not open the process filesystem");
  }

  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    if (this.control === "late-error" && this.role === "case" && !this.observations.lateError) {
      const done = await super.script("return globalThis.processResult?.ok === true && globalThis.processResult.checks.length === 23", signal);
      if (done === true) {
        this.observations.lateError = true;
        await super.script('queueMicrotask(() => { throw Error("BUN_PROCESS_LATE_ERROR_BEFORE_RETIREMENT"); }); return true;', signal);
      }
    }
    return super.script(source, signal);
  }

  override stop(): Promise<DriverCleanup> { return this.observationStop ??= this.finishObservation(); }
  private async finishObservation(): Promise<DriverCleanup> {
    try {
      if (this.seeded) {
        const signal = AbortSignal.timeout(10_000);
        const databases = await this.dispatch(names, signal);
        assert.deepEqual(databases.names, ["waffle-workspace"], "acknowledged finish must remove the process filesystem");
        await this.dispatch(verifyAndDeleteSentinel, signal);
        this.observations.foreignSurvived = true;
      }
    } catch (error) { this.observations.failure = String(error); }
    return super.stop();
  }
}

export async function runHostedProcess(engine: Engine, resultPath: string, port: number, control: Control = "observe") {
  const startedAt = performance.now();
  const observations: Observations = { roles: [], foreignSurvived: false, lateError: false, failure: null };
  const adapter = {
    ...processAdapter,
    page: control === "delayed-finish"
      ? { path: "/current/", script: "/process-delayed-finish.js" }
      : processAdapter.page,
    policy: {
      ...processAdapter.policy,
      check(id: string, result: unknown) {
        processAdapter.policy.check(id, result);
        if (control === "assertion") throw new Error("BUN_PROCESS_INTENTIONAL_HOST_ASSERTION");
      },
    },
    async assets(context: Parameters<typeof processAdapter.assets>[0]) {
      const assets = await processAdapter.assets(context);
      return {
        ...assets,
        "/process-control.html": new Blob(["<!doctype html><title>Bun process control</title>"], { type: "text/html" }),
        "/process-delayed-finish.js": new Blob([
          'if (window.__suiteConfiguration.role === "finish") await new Promise(resolve => setTimeout(resolve, 500)); await import("/current/process-browser-main.js");',
        ], { type: "application/javascript" }),
      };
    },
  };
  const options: RunOptions = { resultPath, startedAt, port };
  const result = await runPageSuite(adapter, scratch => new ObservedProcessDriver(engine, scratch, observations, control), options);
  await writeResult(`${resultPath}.controls.json`, observations);
  const expectedExit = control === "assertion" ? 1 : control === "late-error" ? 2 : 0;
  assert.equal(result.exit, expectedExit, JSON.stringify(result));
  assert.equal(observations.failure, null);
  assert.equal(observations.foreignSurvived, true);
  const expectedRoles = control === "late-error" && observations.roles.length === 4
    ? ["list", "case", "finish", "finish"] : ["list", "case", "finish"];
  assert.deepEqual(observations.roles, expectedRoles);
  assert.equal(result.ledger.length, 1);
  assert.deepEqual(result.ledger[0], { kind: "indexeddb", name: processFilesystemName(result.run) });
  assert.deepEqual(result.storageRemaining, []);
  checkProcessResult(result.results[processCommandId]);
  for (const item of Object.values(result.cleanup)) {
    if (record(item)) assert.equal(item.status, "confirmed", JSON.stringify(result.cleanup));
  }
  if (control === "late-error") assert.equal(observations.lateError, true);
  return result;
}

if (import.meta.main) {
  const [engine, flag, resultPath, control = "observe"] = process.argv.slice(2);
  if ((engine !== "chromium" && engine !== "webkit") || flag !== "--result" || !resultPath || !isAbsolute(resultPath) || !["observe", "assertion", "late-error", "delayed-finish"].includes(control)) throw new Error("Usage: browser-process-hosted.ts chromium|webkit --result /absolute/result.json [observe|assertion|late-error|delayed-finish]");
  if (control !== "observe" && control !== "assertion" && control !== "late-error" && control !== "delayed-finish") throw new Error("unknown control");
  const port = Number(process.env.PROCESS_SMOKE_PORT ?? 4186);
  await runHostedProcess(engine, resultPath, port, control);
}
