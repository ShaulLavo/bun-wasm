(function (internal: BunWasm.Internal) {
  "use strict";
  type Graph = BunWasm.HotGraph;
  type Source = BunWasm.HotSource;
  type Prepared = ReturnType<RecordSessionBindings["load"]>;
  const parseJson = JSON.parse;
  const native = internal.native;
  const fs = internal.builtin("node:fs");
  const path = internal.require("path");
  const { AsyncLocalStorage } = internal.builtin("node:async_hooks");
  const association = new AsyncLocalStorage<Graph>();
  const promiseThen = Promise.prototype.then;
  const apply = Reflect.apply;
  const pendingImports = new Map<Graph, number>();
  const leasedGraphs = new Set<Graph>();
  const controllerContext = native.getAsyncContext();
  const servers = internal.require("hot_serve")(() => association.getStore());
  internal.hotServers = servers;
  internal.hotFileRequire = () => {
    if (association.getStore()) throw new TypeError("--hot does not support file require, createRequire or Module.require");
  };
  const sessions = native.loadPolyfill("esm_loader")({
    resolve: (name, from) => native.resolveImport(name, from, "inferred"),
    load() { throw new Error("--hot default session is not an application graph"); },
    initMeta() {},
  }, false);
  const diagnostics = new Map<string, BunWasm.HotDiagnostic>();
  const ordinaryMap = native.mapPosition;
  const ordinaryLine = internal.getSourceLine;
  const HOT = "bunwasm:hot:";
  const ordinaryDisplay = internal.hotDisplayName;
  internal.hotDisplayName = name => {
    const diagnostic = diagnostics.get(name);
    if (diagnostic) return diagnostic.path;
    if (!name.startsWith(HOT)) return ordinaryDisplay?.(name);
    const path = name.slice(name.indexOf(":", HOT.length) + 1).split("#module=")[0];
    try { return decodeURIComponent(path); } catch { return name; }
  };
  native.hotMapLookup = (name, line, column) => {
    if (!name.startsWith(HOT)) return ordinaryMap(name, line, column);
    const diagnostic = diagnostics.get(name);
    if (!diagnostic) return undefined;
    return native.hotMapPosition(diagnostic.record, diagnostic.map, diagnostic.line1Shift, diagnostic.lineOffset, line, column);
  };
  native.mapPosition = native.hotMapLookup;
  internal.mapPosition = native.hotMapLookup;
  internal.getSourceLine = (name, line) => name.startsWith(HOT) ? diagnostics.get(name)?.original.split("\n")[line - 1] : ordinaryLine?.(name, line);

  type Watcher = ReturnType<typeof fs.watch>;
  type Subscription = { watcher: Watcher; identity: string; names: Set<string>; invalid: boolean };
  type RunnerState = { kind: "waiting" } | { kind: "serving"; graph: Graph } |
    { kind: "updating"; previous: Graph | null; candidate: Graph } | { kind: "closed" };
  const subscriptions = new Map<string, Subscription>();
  let state: RunnerState = { kind: "waiting" };
  let failed: Set<string> = new Set();
  let failedInputs = new Map<string, string>();
  let observed = new Map<string, string>();
  let entry: string | null = null;
  let revision = 0;
  let dirty = false;
  let scheduled: unknown = null;

  function closed(): boolean { return state.kind === "closed"; }

  function inController<T>(callback: () => T): T {
    return internal.runInContext(controllerContext, callback, undefined, []);
  }

  function fingerprint(file: string): string {
    try { return native.hotDigest(file); }
    catch {
      try { const stat = fs.statSync(file); return `node:${stat.dev}:${stat.ino}`; }
      catch { return "missing"; }
    }
  }

  function allInterests(): Set<string> {
    const interests = new Set(failed);
    if (entry) interests.add(entry);
    for (const graph of pendingImports.keys()) for (const file of graph.interests) interests.add(file);
    for (const graph of leasedGraphs) for (const file of graph.interests) interests.add(file);
    if (state.kind === "serving") for (const file of state.graph.interests) interests.add(file);
    if (state.kind === "updating") {
      for (const file of state.candidate.interests) interests.add(file);
      if (state.previous) for (const file of state.previous.interests) interests.add(file);
    }
    return interests;
  }

  function directory(file: string): { root: string; child: string; identity: string } {
    let root = path.dirname(file);
    let child = path.basename(file);
    for (;;) {
      try {
        const stat = fs.statSync(root);
        if (stat.isDirectory()) return { root, child, identity: `${stat.dev}:${stat.ino}` };
      } catch {}
      const parent = path.dirname(root);
      if (parent === root) throw new Error(`--hot cannot watch any ancestor of '${file}'`);
      child = path.basename(root);
      root = parent;
    }
  }

  function fatal(error: unknown): void {
    if (state.kind === "closed") return;
    dispose();
    internal.reportHotError(error);
    globalThis.process.exitCode = 1;
  }

  function unsupported(error: unknown): boolean {
    return error !== null && typeof error === "object" && "code" in error && (error.code === "ENOTSUP" || error.code === "ENOSYS" || error.code === "EACCES" || error.code === "EPERM");
  }

  function subscribe(root: string, identity: string, names: Set<string>): Subscription {
    let subscription: Subscription;
    const watcher = inController(() => fs.watch(root, (kind, name) => {
      if (state.kind === "closed" || subscriptions.get(root) !== subscription) return;
      if (name === null || name === path.basename(root)) subscription.invalid = true;
      if (subscription.invalid || name === null || subscription.names.has(name) || kind === "rename") changed();
    }));
    subscription = { watcher, identity, names, invalid: false };
    watcher.on("error", error => {
      if (subscriptions.get(root) !== subscription) return;
      if (unsupported(error)) { fatal(error); return; }
      subscription.invalid = true;
      changed();
    });
    watcher.on("close", () => {
      if (subscriptions.get(root) !== subscription) return;
      subscription.invalid = true;
      changed();
    });
    return subscription;
  }

  function removeSubscription(root: string): void {
    const subscription = subscriptions.get(root);
    subscriptions.delete(root);
    subscription?.watcher.close();
  }

  function reconcile(): void {
    if (state.kind === "closed") return;
    const wanted = new Map<string, { identity: string; names: Set<string> }>();
    for (const file of allInterests()) {
      const target = directory(file);
      let item = wanted.get(target.root);
      if (!item) { item = { identity: target.identity, names: new Set() }; wanted.set(target.root, item); }
      item.names.add(target.child);
    }
    for (const root of subscriptions.keys()) if (!wanted.has(root)) removeSubscription(root);
    for (const [root, item] of wanted) {
      if (closed()) return;
      updateSubscription(root, item);
    }
  }

  function updateSubscription(root: string, item: { identity: string; names: Set<string> }): void {
    const previous = subscriptions.get(root);
    if (previous && !previous.invalid && previous.identity === item.identity) { previous.names = item.names; return; }
    removeSubscription(root);
    try { subscriptions.set(root, subscribe(root, item.identity, item.names)); }
    catch (error) { fatal(error); }
  }

  function interested(graph: Graph, file: string, captureStamp = true): void {
    graph.interests.add(file);
    if (captureStamp && !graph.inputs.has(file)) graph.inputs.set(file, fingerprint(file));
    inController(reconcile);
  }

  function recovery(graph: Graph, error: unknown): void {
    if (error === null || typeof error !== "object" || !("specifier" in error) || !("referrer" in error)) return;
    if (typeof error.specifier !== "string" || typeof error.referrer !== "string") return;
    const specifier = error.specifier;
    let root = path.dirname(native.modulePath(error.referrer));
    if (specifier.startsWith(".") || specifier.startsWith("/")) { interested(graph, path.resolve(root, specifier)); return; }
    if (specifier.includes(":")) return;
    for (;;) {
      interested(graph, path.resolve(root, "node_modules", specifier));
      const parent = path.dirname(root);
      if (parent === root) return;
      root = parent;
    }
  }

  function resolve(graph: Graph, specifier: string, referrer: string, mode: BunWasm.ImportMode): string {
    try { return native.resolveImport(specifier, referrer, mode); }
    catch (error) { recovery(graph, error); throw error; }
  }

  function active(graph: Graph): boolean { return state.kind !== "closed" && graph.phase !== "cancelled"; }

  function prepare(graph: Graph, name: string): void {
    if (!active(graph)) return;
    const errors = preparationErrors.get(graph)!;
    const failure = errors.get(name);
    if (failure) throw failure.value;
    if (graph.sources.has(name)) return;
    try { prepareSource(graph, name); }
    catch (error) { errors.set(name, { value: error }); throw error; }
  }

  function prepareSource(graph: Graph, name: string): void {
    if (!internal.isBuiltinId(name)) interested(graph, native.modulePath(name), false);
    if (!active(graph)) return;
    let source: Source;
    try { source = native.hotPrepare(graph.id, name); }
    catch (error) {
      if (error && typeof error === "object" && "__bunwasmHotPath" in error && "__bunwasmHotDigest" in error && typeof error.__bunwasmHotPath === "string" && typeof error.__bunwasmHotDigest === "string") graph.inputs.set(error.__bunwasmHotPath, error.__bunwasmHotDigest);
      throw error;
    }
    graph.sources.set(name, source);
    if (source.kind === "builtin") return;
    graph.inputs.set(source.path, source.digest);
    if (source.kind !== "esm") {
      const value: unknown = source.kind === "json" ? json(source.path, source.text) : source.text;
      records.get(graph)!.set(name, { namespace: value, default: value });
      return;
    }
    if (graph.phase !== "retired" || graph.leases > 0 || pendingImports.has(graph)) diagnostics.set(source.identity, source.diagnostic);
    const record = registration(native.evalScript(source.code, source.identity, 1));
    records.get(graph)!.set(name, { record });
    for (const request of record.r) prepare(graph, resolve(graph, request, name, "inferred"));
  }

  const records = new WeakMap<Graph, Map<string, Prepared>>();
  const preparationErrors = new WeakMap<Graph, Map<string, { value: unknown }>>();

  function json(file: string, text: string): unknown {
    try { return parseJson(text); }
    catch (error) {
      if (error instanceof SyntaxError) Object.defineProperty(error, "__bunwasmFormatted", { value: `SyntaxError: ${error.message}\n    at ${file}\n` });
      throw error;
    }
  }

  function loaded(graph: Graph, name: string): Prepared {
    const source = graph.sources.get(name);
    if (!source) throw new Error(`--hot source was not prepared: ${name}`);
    if (source.kind === "builtin") { const value = internal.builtin(source.name); return { namespace: value, default: value }; }
    const value = records.get(graph)!.get(name);
    if (!value) throw new Error(`--hot registration was not prepared: ${name}`);
    return value;
  }

  function registration(value: unknown): ModuleRecord {
    if (typeof value !== "object" || value === null) throw new TypeError("Invalid hot registration record");
    if (!("r" in value && "i" in value && "x" in value && "s" in value && "e" in value && "a" in value && "f" in value)) throw new TypeError("Incomplete hot registration record");
    if (!Array.isArray(value.r) || !Array.isArray(value.i) || !Array.isArray(value.x) || !Array.isArray(value.s) || !Array.isArray(value.e) || typeof value.a !== "boolean" || typeof value.f !== "function") throw new TypeError("Invalid hot registration fields");
    return value as ModuleRecord;
  }

  function validate(graph: Graph, previous = new Set<string>()): boolean {
    for (const source of graph.sources.values()) {
      if (source.kind === "builtin" || previous.has(source.path)) continue;
      if (fingerprint(source.path) !== source.digest) return false;
    }
    return true;
  }

  function newGraph(): Graph {
    const graph: Graph = {
      id: ++revision, sources: new Map(), interests: new Set(), inputs: new Map(), phase: "candidate", leases: 0,
      releaseDiagnostics() {
        if (pendingImports.has(graph) || graph.leases > 0) return;
        leasedGraphs.delete(graph);
        for (const source of graph.sources.values()) if (source.kind === "esm") diagnostics.delete(source.identity);
        inController(reconcile);
      },
    };
    records.set(graph, new Map());
    preparationErrors.set(graph, new Map());
    return graph;
  }

  function session(graph: Graph): BunWasm.HotRecordSession {
    return sessions.newSession({
      resolve: (specifier, from) => resolve(graph, specifier, from, "inferred"),
      resolveImport: (specifier, from, mode) => resolve(graph, specifier, from, mode),
      load: name => loaded(graph, name),
      initMeta(name, meta) { internal.initImportMeta(meta, name, name === entry); },
      active: () => active(graph),
      track(operation) {
        if (!active(graph)) return operation;
        pendingImports.set(graph, (pendingImports.get(graph) ?? 0) + 1);
        const finish = () => finishImport(graph);
        apply(promiseThen, operation, [finish, finish]);
        return operation;
      },
      async prepare(name) {
        const previous = new Set(Array.from(graph.sources.values(), source => source.kind === "esm" ? source.path : ""));
        prepare(graph, name);
        if (!validate(graph, previous)) throw new Error("--hot newly imported source changed during preparation");
      },
    });
  }

  function finishImport(graph: Graph): void {
    const count = pendingImports.get(graph);
    if (count === undefined) return;
    if (count > 1) { pendingImports.set(graph, count - 1); return; }
    pendingImports.delete(graph);
    if (graph.phase === "retired") graph.releaseDiagnostics();
    inController(reconcile);
  }

  function retire(graph: Graph): void {
    graph.phase = "retired";
    if (graph.leases > 0) leasedGraphs.add(graph);
    if (graph.leases === 0) graph.releaseDiagnostics();
  }

  function saveObserved(): void {
    observed = new Map();
    const graph = state.kind === "serving" ? state.graph : null;
    if (graph) for (const [file, stamp] of graph.inputs) observed.set(file, stamp);
    for (const [file, stamp] of failedInputs) observed.set(file, stamp);
  }

  function differs(): boolean {
    for (const file of allInterests()) if (fingerprint(file) !== observed.get(file)) return true;
    return false;
  }

  function cancel(graph: Graph): void {
    graph.phase = "cancelled";
    pendingImports.delete(graph);
    servers.abort(graph);
    graph.releaseDiagnostics();
    records.delete(graph);
    preparationErrors.delete(graph);
    graph.sources.clear();
  }

  async function attempt(): Promise<void> {
    if (state.kind === "closed" || state.kind === "updating" || entry === null) return;
    const previous = state.kind === "serving" ? state.graph : null;
    const graph = newGraph();
    state = { kind: "updating", previous, candidate: graph };
    dirty = false;
    servers.begin(graph);
    try {
      prepare(graph, entry);
      if (!active(graph)) return;
      if (!validate(graph)) { dirty = true; return; }
      await association.run(graph, () => session(graph).importName(entry!));
      if (!active(graph)) return;
      inController(reconcile);
      if (!validate(graph)) { dirty = true; return; }
      const server = servers.commit(graph);
      graph.phase = "committed";
      state = { kind: "serving", graph };
      failed = new Set();
      failedInputs = new Map();
      if (previous) retire(previous);
      inController(reconcile);
      saveObserved();
      servers.publish(graph);
      try { internal.hotCommitted?.(graph.id, server); } catch (error) { internal.reportHotError(error); }
    } catch (error) {
      if (active(graph)) internal.reportHotError(error);
    } finally {
      finishAttempt(graph, previous);
    }
  }

  function finishAttempt(graph: Graph, previous: Graph | null): void {
    if (state.kind === "closed") return;
    if (graph.phase !== "committed") {
      failed = graph.interests;
      failedInputs = graph.inputs;
      cancel(graph);
      state = previous ? { kind: "serving", graph: previous } : { kind: "waiting" };
      inController(reconcile);
      saveObserved();
    }
    if (dirty) schedule();
  }

  function schedule(): void {
    if (scheduled !== null || state.kind === "closed" || state.kind === "updating") return;
    scheduled = inController(() => internal.realTimers.setImmediate(() => {
      scheduled = null;
      if (state.kind === "closed") return;
      try { reconcile(); } catch { return; }
      if (!dirty && !differs()) return;
      void attempt();
    }));
  }

  function changed(): void {
    if (state.kind === "closed") return;
    // Events are hints. A delayed duplicate does not force another evaluation.
    schedule();
  }

  function dispose(): void {
    if (state.kind === "closed") return;
    const previous = state;
    state = { kind: "closed" };
    if (scheduled !== null) internal.realTimers.clearImmediate(scheduled);
    scheduled = null;
    if (previous.kind === "updating") cancel(previous.candidate);
    if (previous.kind === "serving") retire(previous.graph);
    if (previous.kind === "updating" && previous.previous) retire(previous.previous);
    for (const root of Array.from(subscriptions.keys())) removeSubscription(root);
    servers.dispose();
    failed.clear();
    failedInputs.clear();
    observed.clear();
    diagnostics.clear();
    pendingImports.clear();
    leasedGraphs.clear();
  }

  return {
    run(name: string) {
      if (entry !== null || state.kind === "closed") throw new Error("--hot runner already started");
      entry = name;
      try { inController(reconcile); } catch { return; }
      void inController(attempt);
    },
    dispose,
  };
})
