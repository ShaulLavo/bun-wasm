import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function factory(name: string) {
  const source = readFileSync(new URL(`../crates/bunwasm-runtime/src/js/${name}.ts`, import.meta.url), "utf8");
  const code = execFileSync("node", ["--disable-warning=ExperimentalWarning", "-e",
    'process.stdout.write(require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0,"utf8"), {mode:"strip"}))',
  ], { input: source, encoding: "utf8" });
  return vm.runInThisContext(code);
}
const hotServe = factory("hot_serve");
const hotRequest = factory("hot_request");
const hotRevisions = factory("hot_revisions");
let token = 0;

function setup() {
  let owner: unknown;
  let context: unknown = "initial";
  const notices: unknown[] = [];
  const internal = {
    native: { getAsyncContext: () => context, randomBytes: (length: number) => new Uint8Array(length).fill(++token) },
    printError(error: unknown) { notices.push(error); },
    require: (name: string) => name === "hot_revisions" ? hotRevisions(internal) : (value: string) => value,
    runInContext(frame: unknown, callback: (...args: unknown[]) => unknown, receiver: unknown, args: unknown[]) {
      const previous = context;
      context = frame;
      try { return callback.apply(receiver, args); } finally { context = previous; }
    },
    hotCommitted: (...notice: unknown[]) => notices.push(notice),
  };
  const manager = hotServe(internal)(() => owner);
  let binds = 0;
  let closes = 0;
  const reloads: unknown[] = [];
  const server = {
    port: 48761,
    reload(options: unknown) { reloads.push(options); return server; },
    stop() { closes++; return Promise.resolve(); },
  };
  const create = () => { binds++; return server; };
  const graph = (id: number) => ({ id, sources: new Map(), interests: new Set(), inputs: new Map(), phase: "candidate", leases: 0, releases: 0, releaseDiagnostics() { this.releases++; } });
  function begin(id: number, frame: string) {
    const generation = graph(id);
    owner = generation;
    context = frame;
    manager.begin(generation);
    return generation;
  }
  const serve = (extra = {}) => manager.serve({ hostname: "LOCALHOST.", port: server.port, fetch: () => new Response("ok"), ...extra }, create);
  const run = hotRequest(internal).run;
  return { manager, begin, serve, run, create, server, notices, reloads, setOwner(value: unknown) { owner = value; },
    get context() { return context; }, get binds() { return binds; }, get closes() { return closes; } };
}

test("same server and bind across commits; snapshots retain handler, missing error and registration frame", async () => {
  const app = setup();
  const first = app.begin(1, "old ALS");
  const error = () => new Response("old error");
  const one = app.serve({ error });
  app.manager.commit(first);
  first.phase = "committed";
  const before = await app.manager.select(one);
  const second = app.begin(2, "new ALS");
  expect(app.serve()).toBe(one);
  app.manager.commit(second);
  second.phase = "committed";
  const after = await app.manager.select(one);
  expect(app.binds).toBe(1);
  expect(before.error).toBe(error);
  expect(after.error).toBeUndefined();
  expect(before.context).toBe("old ALS");
  expect(after.context).toBe("new ALS");
  expect(app.reloads).toHaveLength(2);
  app.manager.release(before);
  app.manager.release(after);
  app.manager.dispose();
  app.manager.dispose();
  expect(app.closes).toBe(1);
});

test("an aborted generation's late serve cannot stage into a later attempt", () => {
  const app = setup();
  const initial = app.begin(1, "one");
  app.serve();
  app.manager.commit(initial);
  const aborted = app.begin(2, "aborted");
  app.serve();
  app.manager.abort(aborted);
  const current = app.begin(3, "TLA");
  app.setOwner(aborted);
  expect(() => app.serve()).toThrow("outside the current evaluation");
  app.setOwner(current);
  expect(app.serve()).toBe(app.server);
  app.manager.commit(current);
  expect(app.closes).toBe(0);
  expect(app.binds).toBe(1);
  app.manager.dispose();
});

test("first evaluation rejection closes its provisional listener and releases waiting requests", async () => {
  const app = setup();
  const candidate = app.begin(1, "provisional");
  const server = app.serve();
  const waiting = app.manager.select(server);
  app.manager.abort(candidate);
  await expect(waiting).rejects.toThrow("did not commit");
  expect(app.closes).toBe(1);
  const fixed = app.begin(2, "fixed");
  app.serve();
  app.manager.commit(fixed);
  expect(app.binds).toBe(2);
  app.manager.dispose();
});

for (const options of [{ port: 0 }, { port: 65536 }, { port: 1.2 }, { tls: {} }, { routes: {} }, { websocket: {} }, { unix: "/tmp/a" }]) {
  test(`unsupported hot server form rejects before bind ${JSON.stringify(options)}`, () => {
    const app = setup();
    const graph = app.begin(1, "unsupported");
    expect(() => app.serve(options)).toThrow("--hot");
    expect(app.binds).toBe(0);
    app.manager.abort(graph);
    app.manager.dispose();
  });
}

test("request lease lasts through output work, releases exactly once on teardown, and enters its own frame", async () => {
  const app = setup();
  const graph = app.begin(1, "request ALS");
  app.serve();
  app.manager.commit(graph);
  const abort = new AbortController();
  let finish = () => {};
  const output = new Promise<void>(resolve => { finish = resolve; });
  const request = app.run(app.manager, app.server, { closed: false }, (_snapshot: unknown, releaseOnAbort: (signal: AbortSignal) => void) => {
    expect(app.context).toBe("request ALS");
    releaseOnAbort(abort.signal);
    return output;
  });
  await Promise.resolve();
  expect(graph.leases).toBe(1);
  graph.phase = "retired";
  abort.abort();
  expect(graph.leases).toBe(0);
  expect(graph.releases).toBe(1);
  finish();
  await request;
  expect(graph.leases).toBe(0);
  expect(graph.releases).toBe(1);
  app.manager.dispose();
});


test("commit source registers and snapshots synchronously, isolates observers, and closes once", async () => {
  const app = setup();
  const first = app.begin(1, "one");
  app.serve();
  const source = app.manager.revisions(app.server);
  const notices: { kind: string; stamp?: { server: string; revision: number } }[] = [];
  const unsubscribe = source.subscribe((notice: typeof notices[number]) => notices.push(notice));
  expect(notices).toHaveLength(0);
  app.manager.commit(first);
  app.manager.publish(first);
  expect(notices.map(notice => notice.stamp?.revision)).toEqual([1]);
  const immediate: typeof notices = [];
  source.subscribe((notice: typeof notices[number]) => immediate.push(notice));
  expect(immediate).toEqual(notices);
  source.subscribe(() => { throw new Error("bad observer"); });
  const old = await app.manager.select(app.server);
  const second = app.begin(3, "three");
  app.serve();
  app.manager.commit(second);
  app.manager.publish(second);
  const latest = await app.manager.select(app.server);
  expect(old.stamp.revision).toBe(1);
  expect(latest.stamp.revision).toBe(3);
  expect(old.stamp.server).toBe(latest.stamp.server);
  expect(app.notices).toHaveLength(1);
  unsubscribe(); unsubscribe();
  app.manager.close(app.server); app.manager.close(app.server);
  expect(notices).toHaveLength(2);
  expect(immediate.map(notice => notice.kind)).toEqual(["committed", "committed", "closed"]);
  const closed: typeof notices = [];
  source.subscribe((notice: typeof notices[number]) => closed.push(notice));
  expect(closed).toEqual([{ kind: "closed" }]);
  app.manager.release(old); app.manager.release(latest);
  app.manager.dispose();
});
