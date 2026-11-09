import { expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

const names = ["esm_loader", "hot_serve", "hot_run", "hot_revisions"];
const sources = new Map(names.map(name => [name, execFileSync("node", ["--disable-warning=ExperimentalWarning", "-e",
  'process.stdout.write(require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0,"utf8"), {mode:"strip"}))',
], { input: readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url), "utf8"), encoding: "utf8" })]));

type Input = { body: string; imports?: string[]; syntax?: boolean; wait?: boolean };
type Watch = { change(kind: string, file: string | null): void; error(error: unknown): void; close(): void; ended(): void };

function harness(initial: Input, unsupported = false) {
  const inputs = new Map<string, Input>([["/app/entry.mts", initial]]);
  const watches = new Map<string, Watch>();
  const tasks = new Set<() => void>();
  const errors: unknown[] = [];
  const commits: number[] = [];
  const directories = new Map([["/", 1], ["/app", 2]]);
  let runs = 0;
  let bindings = 0;
  let stops = 0;
  let ready: (() => void) | undefined;
  let duringRead: (() => void) | undefined;
  const process = { env: {}, exitCode: 0 };
  const context = vm.createContext({ process, Response, console, Promise, AsyncLocalStorage, Map, Set });
  const getFactory = (name: string) => vm.runInContext(sources.get(name)!, context);
  const digest = (file: string) => { const value = inputs.get(file); if (!value) throw new Error("ENOENT"); return JSON.stringify(value); };
  const fs = {
    statSync(file: string) {
      const ino = directories.get(file);
      if (!ino) throw new Error("ENOENT");
      return { dev: 1, ino, isDirectory: () => true };
    },
    watch(root: string, change: Watch["change"]) {
      if (unsupported) throw Object.assign(new Error("ENOTSUP: watch"), { code: "ENOTSUP" });
      const listeners = { error(_error: unknown) {}, ended() {} };
      const watch = { change, error: (error: unknown) => listeners.error(error), ended: () => listeners.ended(),
        close() { watches.delete(root); },
        on(kind: string, callback: (error?: unknown) => void) { if (kind === "error") listeners.error = callback; else listeners.ended = callback; },
      };
      watches.set(root, watch);
      return watch;
    },
  };
  const server = { port: 43219, reload(_options: unknown) { return server; }, stop() { stops++; return Promise.resolve(); } };
  const globals = {
    effect() { runs++; },
    serve() { internal.hotServers.serve({ port: 43219, fetch: () => new Response("ok") }, () => { bindings++; return server; }); },
    wait() { return new Promise<void>(resolve => { ready = resolve; }); },
  };
  Object.assign(context, globals);
  const native = {
    getAsyncContext: () => undefined,
    randomBytes: (length: number) => new Uint8Array(length).fill(1),
    mapPosition: () => undefined,
    hotMapPosition: (_r: unknown, _m: unknown, _s: unknown, _o: unknown, line: number, column: number) => [line, column],
    modulePath: (name: string) => name,
    hotDigest: digest,
    resolveImport(specifier: string, from: string) {
      const name = path.resolve(path.dirname(from), specifier);
      if (!inputs.has(name)) throw Object.assign(new Error("missing import"), { specifier, referrer: from });
      return name;
    },
    hotPrepare(id: number, name: string) {
      const input = inputs.get(name);
      if (!input) throw new Error("ENOENT");
      const stamp = digest(name);
      const body = input.body;
      duringRead?.();
      duringRead = undefined;
      if (input.syntax) throw Object.assign(new SyntaxError(body), { __bunwasmHotPath: name, __bunwasmHotDigest: stamp });
      const code = `({r:${JSON.stringify(input.imports ?? [])},i:[],x:[],s:[],e:[],a:${Boolean(input.wait)},f:function*(api){api.l({});yield;yield;${input.wait ? "yield wait();" : ""}${body}}})`;
      return { kind: "esm", path: name, digest: stamp, identity: `bunwasm:hot:${id}:${name}`, code,
        diagnostic: { path: name, original: body, line1Shift: 0, lineOffset: 0 } };
    },
    loadPolyfill: getFactory,
    evalScript: (code: string) => vm.runInContext(code, context),
  };
  const internal = {
    native,
    getSourceLine: () => undefined,
    mapPosition: native.mapPosition,
    isBuiltinId: () => false,
    hotServers: undefined as unknown as { serve(options: object, create: () => typeof server): typeof server },
    builtin: (name: string) => name === "node:fs" ? fs : { AsyncLocalStorage },
    require(name: string): unknown {
      if (name === "path") return path.posix;
      if (name === "net_hostname") return (value: string) => value;
      if (name === "hot_serve" || name === "hot_revisions") return getFactory(name)(internal);
      throw new Error(name);
    },
    runInContext: (_frame: unknown, callback: () => unknown) => callback(),
    initImportMeta() {},
    printError: (error: unknown) => errors.push(error),
    hotCommitted: (id: number) => commits.push(id),
    realTimers: {
      setImmediate(callback: () => void) { tasks.add(callback); return callback; },
      clearImmediate(callback: () => void) { tasks.delete(callback); },
    },
  };
  const runner = getFactory("hot_run")(internal);
  async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
  async function flush() { const batch = Array.from(tasks); tasks.clear(); for (const task of batch) task(); await settle(); }
  return { runner, inputs, watches, errors, commits, directories, tasks, process, settle, flush,
    get runs() { return runs; }, get bindings() { return bindings; }, get stops() { return stops; },
    resume() { ready?.(); }, race(callback: () => void) { duringRead = callback; } };
}

test("initial malformed entry recovers without fatal entry rejection; duplicate notifications do not re-evaluate", async () => {
  const host = harness({ syntax: true, body: "broken entry" });
  try {
    host.runner.run("/app/entry.mts");
    await host.settle();
    expect(host.errors).toHaveLength(1);
    expect(host.bindings).toBe(0);
    expect(host.watches.size).toBe(1);
    host.inputs.set("/app/entry.mts", { body: "effect();serve();" });
    host.watches.get("/app")!.change("change", "entry.mts");
    await host.flush();
    expect(host.commits).toHaveLength(1);
    host.watches.get("/app")!.change("change", "entry.mts");
    await host.flush();
    expect(host.runs).toBe(1);
    expect(host.bindings).toBe(1);
  } finally { host.runner.dispose(); }
  expect(host.watches.size).toBe(0);
  expect(host.tasks.size).toBe(0);
  expect(host.stops).toBe(1);
});

test("entire static graph compiles before any application body and recovers from a dependency error", async () => {
  const host = harness({ body: "effect();serve();", imports: ["./dep.mts"] });
  host.inputs.set("/app/dep.mts", { syntax: true, body: "broken dependency" });
  try {
    host.runner.run("/app/entry.mts");
    await host.settle();
    expect(host.runs).toBe(0);
    host.inputs.set("/app/dep.mts", { body: "effect();" });
    host.watches.get("/app")!.change("rename", "dep.mts");
    await host.flush();
    expect(host.runs).toBe(2);
    expect(host.commits).toHaveLength(1);
  } finally { host.runner.dispose(); }
});

test("input stamp belongs to compiled bytes, not a second read", async () => {
  const host = harness({ body: "effect();serve();" });
  host.race(() => host.inputs.set("/app/entry.mts", { body: "effect();effect();serve();" }));
  try {
    host.runner.run("/app/entry.mts");
    await host.settle();
    expect(host.runs).toBe(0);
    expect(host.commits).toHaveLength(0);
    await host.flush();
    expect(host.runs).toBe(2);
    expect(host.commits).toHaveLength(1);
  } finally { host.runner.dispose(); }
});

test("write during finite TLA is rejected at the commit barrier before its watch event arrives", async () => {
  const host = harness({ body: "effect();serve();", wait: true });
  try {
    host.runner.run("/app/entry.mts");
    await host.settle();
    host.inputs.set("/app/entry.mts", { body: "effect();effect();serve();" });
    host.resume();
    await host.settle();
    expect(host.commits).toHaveLength(0);
    await host.flush();
    expect(host.commits).toHaveLength(1);
    expect(host.stops).toBe(1);
  } finally { host.runner.dispose(); }
});

test("missing nested path, replaced directory, unexpected close and overflow reconcile owned interests", async () => {
  const host = harness({ body: "effect();serve();", imports: ["./nested/dep.mts"] });
  try {
    host.runner.run("/app/entry.mts");
    await host.settle();
    host.directories.set("/app/nested", 3);
    host.inputs.set("/app/nested/dep.mts", { body: "" });
    host.watches.get("/app")!.change("rename", "nested");
    await host.flush();
    expect(host.commits).toHaveLength(1);
    host.directories.set("/app/nested", 4);
    host.watches.get("/app/nested")!.ended();
    await host.flush();
    expect(host.commits).toHaveLength(1);
    host.watches.get("/app/nested")!.error(Object.assign(new Error("overflow"), { code: "EOVERFLOW" }));
    await host.flush();
    expect(host.commits).toHaveLength(1);
    expect(host.watches.size).toBe(2);
  } finally { host.runner.dispose(); }
  expect(host.watches.size).toBe(0);
});

test("cancellation during TLA drops controller watches/work without settling abandoned application work", async () => {
  const host = harness({ body: "effect();serve();", wait: true });
  host.runner.run("/app/entry.mts");
  await host.settle();
  host.runner.dispose();
  host.runner.dispose();
  host.resume();
  await host.settle();
  expect(host.commits).toHaveLength(0);
  expect(host.runs).toBe(0);
  expect(host.watches.size).toBe(0);
  expect(host.tasks.size).toBe(0);
});

test("unsupported real-host watching is fatal once and owns no recovery loop", async () => {
  const host = harness({ body: "effect();serve();" }, true);
  host.runner.run("/app/entry.mts");
  await host.settle();
  expect(host.errors).toHaveLength(1);
  expect(host.process.exitCode).toBe(1);
  expect(host.watches.size).toBe(0);
  expect(host.tasks.size).toBe(0);
  expect(host.bindings).toBe(0);
});
