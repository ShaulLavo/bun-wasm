import assert from "node:assert/strict";
import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { positives, faults, survivors, runEntryControls, type EntryCommand } from "./controls.ts";
import { qualifyCommand, qualify } from "./qualify.ts";
import { forwardPost } from "./post.ts";
import { sandboxModel } from "./transforms.ts";

type Row = Record<string, any>;
const capture = "00000000-0000-4000-8000-000000000084";
const url = "http://127.0.0.1:12345/?template=hono&entryControls=labelled";
const origin = new URL(url).origin;
function synthetic(spec: EntryCommand) {
  const rows: Row[] = [];
  const push = (row: Row) => rows.push({ capture, origin, pageURL: url, cell: spec.id, runtimeId: capture, workerId: 2, workerIsolated: true, ...row });
  push({ kind: "native-worker", url: origin + "/fs-worker.js" });
  function process(entry: "bun" | "shell", owner: number, parentPid: number, fault: boolean) {
    const workerURL = origin + (entry === "bun" ? "/__bunwasm/worker.js" : "/shell-worker.js");
    const common = { kind: "endpoint", workerId: owner, commandId: spec.id, entry, args: spec.args, moduleURL: workerURL, pid: owner, parentPid, processGeneration: 1,
      qualificationEnvironment: spec.fault ? { QUALIFY_TARGET: spec.entry, QUALIFY_FAULT: spec.fault } : {} };
    const state = { tree: "native-entry", realm: "native-client", endpoint: "client", workerURL, owner, generation: owner, handlersQualified: false, first: null };
    const emit = (stage: string, detail: Row = {}) => push({ ...common, stage, snapshot: { ...state }, ...detail });
    emit("before-original-handlers");
    state.handlersQualified = true;
    emit("original-handlers-qualified");
    emit("after-original-preopen", { preopenCalls: 1, posts: fault ? 0 : 1 });
    if (!fault) {
      emit("original-instantiated", { instantiated: true });
      emit("before-original-guest-entry", { instantiated: true, guestEntry: true });
      if (entry === "bun") emit("original-browser-host-entry", { engine: "browser" });
    }
    const service = { ...state, realm: "native-service", endpoint: "service", workerURL: origin + "/fs-worker.js" };
    push({ kind: "endpoint", workerId: 1, stage: "before-original-handlers", moduleURL: service.workerURL, snapshot: { ...service, handlersQualified: false }, mode: "fast", implementation: "indexeddb" });
    push({ kind: "endpoint", workerId: 1, stage: "service-original-handlers-qualified", moduleURL: service.workerURL, snapshot: { ...service } });
    const posted = { owner, generation: owner, pid: owner, parentPid, processGeneration: 1, commandId: spec.id };
    const native = { workerId: owner, url: workerURL, posted };
    push({ kind: "native-request-post", ...native });
    push({ kind: "native-request-post-returned", ...native });
    if (fault) {
      const first = { kind: "messageerror", trusted: false, closedBefore: null };
      if (spec.fault === "client") emit("after-local-messageerror", { snapshot: { ...state, first } });
      else push({ kind: "endpoint", workerId: 1, stage: "after-labelled-service-fault", moduleURL: service.workerURL, snapshot: { ...service, first } });
      push({ kind: "native-message", ...native, type: "error", code: 1, errno: "EIO", message: "filesystem [code=CLOSED] [errno=29]" });
    } else push({ kind: "native-message", ...native, type: "exit", code: 0 });
  }
  process("bun", 2, 0, spec.kind === "fault" && spec.entry === "bun");
  if (spec.entry === "shell") process("shell", 3, 2, spec.kind === "fault");
  push({ kind: "original-command-completed", commandId: spec.id, outcome: { done: true, code: spec.kind === "fault" ? 1 : 0,
    error: spec.kind === "fault" && spec.entry === "bun" ? "bun.wasm crashed: filesystem [code=CLOSED] [errno=29]" : null,
    output: spec.marker ? spec.marker + "\n" : "" } });
  return { source: "84ff8588028edcc013eb67aa4bb740b3a518b96d", capture, url, rows, originalRuntimeExposed: true, originalFilesystem: true, isolated: true,
    runtimeChanged: false, runtimeRegistrations: 1, contextCount: 1, pageCount: 2, engine: "browser", profile: "split", template: "hono", filesystem: { mode: "fast", implementation: "indexeddb", persistent: true } };
}
for (const spec of positives.concat(faults, survivors)) test(`synthetic gate shape ${spec.id}`, () => expect(qualifyCommand(synthetic(spec), spec).id).toBe(spec.id));
function reject(name: string, change: (raw: ReturnType<typeof synthetic>) => void, spec = positives[0]!) {
  test(name, () => { const raw = synthetic(spec); change(raw); expect(() => qualifyCommand(raw, spec)).toThrow(); });
}
for (const key of ["owner", "generation", "pid", "parentPid", "processGeneration", "commandId"]) reject(`posted ${key} cannot be missing`, raw => { for (const row of raw.rows) if (row.posted) delete row.posted[key]; });
for (const key of ["owner", "generation", "workerURL", "tree", "realm"]) reject(`missing endpoint ${key} rejected`, raw => { for (const row of raw.rows) if (row.snapshot) delete row.snapshot[key]; });
reject("capture mismatch rejected", raw => { raw.rows[0]!.capture = "different"; });
reject("same URL with different Worker instance cannot acknowledge", raw => { for (const row of raw.rows) if (row.kind === "native-message") row.workerId = 99; });
reject("post that never returned cannot qualify", raw => { raw.rows = raw.rows.filter(row => row.kind !== "native-request-post-returned"); });
reject("finish hook cannot replace shell exit", raw => { raw.rows = raw.rows.filter(row => !(row.kind === "native-message" && row.posted?.pid === 3)); }, positives[1]!);
for (const key of ["done", "code", "error", "output"]) reject(`missing outcome ${key} rejected`, raw => { delete raw.rows.find(row => row.kind === "original-command-completed")!.outcome[key]; });
reject("positive output must contain actual marker", raw => { raw.rows.find(row => row.kind === "original-command-completed")!.outcome.output = ""; });
reject("exact CLOSED code required", raw => { raw.rows.find(row => row.type === "error")!.message = "code=CLOSED errno=29"; }, faults[0]!);
reject("exact errno token required", raw => { raw.rows.find(row => row.type === "error")!.message = "[code=CLOSED] [errno=290]"; }, faults[0]!);
reject("fault first event cannot be missing", raw => { for (const row of raw.rows) if (row.snapshot) row.snapshot.first = null; }, faults[0]!);
reject("fault trust must be false", raw => { for (const row of raw.rows) if (row.snapshot?.first) row.snapshot.first.trusted = true; }, faults[0]!);
reject("fault cannot enter guest", raw => { raw.rows.push({ ...raw.rows.find(row => row.stage === "original-handlers-qualified"), stage: "before-original-guest-entry" }); }, faults[0]!);
test("post forwarding preserves tuple, receiver, return and exception identity", () => {
  const receiver = {}, transfer: unknown[] = [], message = {}, result = {}, thrown = {};
  const args = [message, transfer];
  const rows: object[] = [];
  function send(this: unknown, ...actual: unknown[]) { expect(this).toBe(receiver); expect(actual[0]).toBe(message); expect(actual[1]).toBe(transfer); return result; }
  expect(forwardPost(send, receiver, args, row => rows.push(row), {})).toBe(result);
  try { forwardPost(() => { throw thrown; }, receiver, args, row => rows.push(row), {}); assert.fail("must throw"); } catch (error) { expect(error).toBe(thrown); }
});
test("Sandbox-owned sequence stops before faults when positive gate rejects", async () => {
  const ran: string[] = [];
  Reflect.set(globalThis, "sandboxObserver", { gate() { throw new Error("incomplete positive"); } });
  await expect(runEntryControls(async spec => { ran.push(spec.id); })).rejects.toThrow("incomplete positive");
  expect(ran).toEqual(positives.map(spec => spec.id));
});
test("Sandbox-owned sequence gates every fault and survivor before original dev", async () => {
  const order: string[] = [];
  Reflect.set(globalThis, "sandboxObserver", { async gate(phase: string) { order.push(`gate:${phase}`); } });
  await runEntryControls(async spec => { order.push(spec.id); });
  expect(order.slice(0, 3)).toEqual(["bun-positive", "shell-positive", "gate:positives"]);
  expect(order.at(-1)).toBe("gate:before-original-dev");
  expect(order.length).toBe(20);
});
for (const script of ["install", "dev"] as const) test(`option-absent ${script} keeps original args, environment reference, hooks and result`, async () => {
  const source = execFileSync("git", ["show", "84ff8588028edcc013eb67aa4bb740b3a518b96d:sandbox/src/sandbox.ts"], { encoding: "utf8" });
  const transformed = sandboxModel(source, import.meta.dir);
  expect(transformed).toContain('if (this.params.get("entryControls") === "labelled")');
  const method = transformed.slice(transformed.indexOf("  private async command("), transformed.indexOf("  private retryStorage<"))
    .replace('const { startRun } = await import("../../web/src/runner");', 'const startRun = globalThis.__startRun;');
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`class ControlModel { engine="browser";workspace={term:{write(){}}};serverRevision=1;listenerRevision=0;run=null;setStatus(){};setServerState(){};${method}};`);
  const Model = new Function("StartupOutput", "startupRecord", "isStorageFull", "ENGINES", js + "\nreturn ControlModel;")(class { constructor(readonly output: unknown) {} flush() {} }, () => {}, () => false, {browser:{name:"Browser"}});
  const env = { X: "same" }, outcome = { code: 0 };
  Reflect.set(globalThis, "sandboxObserver", { beginCommand() {}, record() {} });
  Reflect.set(globalThis, "__startRun", (options: Row, hooks: Row) => { expect(options.args).toEqual(script === "install" ? ["install"] : ["run", "dev"]); expect(options.env).toBe(env); expect(typeof hooks.stdout).toBe("function"); return { done: Promise.resolve(outcome) }; });
  expect(await new Model().command(script, { env }, 0, 1)).toBe(outcome);
});
