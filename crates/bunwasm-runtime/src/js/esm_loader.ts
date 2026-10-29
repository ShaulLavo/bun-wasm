// ES modules for engines without a native module loader (Hermes). Each module
// arrives as a registration record (bunwasm-transpiler's register.rs): its
// requests, imports and re-exports as data, and its body as a generator whose
// first two steps register export getters and bind dependency namespaces,
// and whose later steps are top-level awaits. This file links the records
// and evaluates them with the ECMAScript algorithm (16.2.1.5.3): depth-first
// with cycle roots, async modules, pending async dependencies, and async
// parents released in evaluation order.
(function (native: {
  resolve(specifier: string, referrer: string): string;
  load(name: string): { record: ModuleRecord } | { namespace: object; default: unknown };
  initMeta(name: string, meta: object): void;
}) {
  "use strict";
  type Getter = () => unknown;
  type Body = Generator<unknown, void, unknown>;
  type ModuleRecord = {
    r: string[];
    i: [number, string][];
    x: [string, number, string][];
    s: number[];
    a: boolean;
    f: (api: ModuleApi) => Body;
  };
  type Status = "loaded" | "linked" | "evaluating" | "evaluating-async" | "evaluated";
  type Capability = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  type Mod = {
    name: string;
    record: ModuleRecord;
    requested: Mod[];
    status: Status;
    locals: Record<string, Getter>;
    namespace: object | null;
    api: ModuleApi;
    body: Body | null;
    dfsIndex: number;
    dfsAncestorIndex: number;
    cycleRoot: Mod | null;
    asyncOrder: number | "done" | null;
    asyncParents: Mod[];
    pendingAsync: number;
    capability: Capability | null;
    error: { value: unknown } | null;
  };
  // A resolved export: the module and local name that hold the binding, or
  // the module itself for `export * as ns`.
  type Binding = { module: Mod; name: string | null };

  const AMBIGUOUS = "ambiguous" as const;
  const promiseThen = Promise.prototype.then;
  const resolvePromise = Promise.resolve.bind(Promise);
  const hasOwn = Object.prototype.hasOwnProperty;
  const registry = new Map<string, Mod>();
  let asyncCounter = 0;

  function then(promise: Promise<unknown>, onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): void {
    promiseThen.call(promise, onFulfilled, onRejected);
  }

  function capability(): Capability {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // `__bunwasm_m` in a module body.
  class ModuleApi {
    mod: Mod;
    n: object[];
    metaObject: object | null;
    constructor(mod: Mod) {
      this.mod = mod;
      this.n = [];
      this.metaObject = null;
    }
    l(getters: Record<string, Getter>): void {
      this.mod.locals = getters;
    }
    get meta(): object {
      if (this.metaObject !== null) return this.metaObject;
      const meta = Object.create(null);
      this.metaObject = meta;
      native.initMeta(this.mod.name, meta);
      return meta;
    }
    import(specifier: unknown): Promise<object> {
      return dynamicImport(specifier, this.mod.name);
    }
    ai(value: { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; [Symbol.iterator](): Iterator<unknown> }): AsyncIterator<unknown> {
      const method = value[Symbol.asyncIterator];
      if (method != null) return method.call(value);
      return fromSyncIterator(value[Symbol.iterator]());
    }
    ac(iterator: AsyncIterator<unknown>): unknown {
      const close = iterator.return;
      return close === undefined ? undefined : close.call(iterator);
    }
  }

  function fromSyncIterator(iterator: Iterator<unknown>): AsyncIterator<unknown> {
    const settle = (result: IteratorResult<unknown>) =>
      resolvePromise(result.value).then(value => ({ value, done: result.done }));
    return {
      next: (value?: unknown) => settle(iterator.next(value)),
      return: (value?: unknown) => settle(iterator.return ? iterator.return(value) : { value, done: true }),
    };
  }

  // --- loading -------------------------------------------------------------

  function createModule(name: string, record: ModuleRecord): Mod {
    let api: ModuleApi | null = null;
    const mod: Mod = {
      get api() { return api ??= new ModuleApi(mod); },
      name,
      record,
      requested: [],
      status: "loaded",
      locals: Object.create(null),
      namespace: null,
      body: null,
      dfsIndex: 0,
      dfsAncestorIndex: 0,
      cycleRoot: null,
      asyncOrder: null,
      asyncParents: [],
      pendingAsync: 0,
      capability: null,
      error: null,
    };
    return mod;
  }

  // Register `name` from its record source and load what it imports. New
  // modules are appended to `added` so a failed load can forget them.
  function syntheticRecord(namespace: object, defaultValue: unknown): ModuleRecord {
    const getters: Record<string, Getter> = Object.create(null);
    for (const key of Object.keys(namespace)) {
      if (key === "default" || key === "__esModule") continue;
      const value = Reflect.get(namespace, key);
      getters[key] = () => value;
    }
    getters.default = () => defaultValue;
    return {
      r: [], i: [], x: [], s: [], a: false,
      f: function* (api) { api.l(getters); yield; yield; },
    };
  }

  function register(name: string, added: Mod[]): Mod {
    const source = native.load(name);
    const record = "record" in source ? source.record : syntheticRecord(source.namespace, source.default);
    const mod = createModule(name, record);
    registry.set(name, mod);
    added.push(mod);
    mod.requested = mod.record.r.map(specifier => load(specifier, name, added));
    return mod;
  }

  function load(specifier: string, referrer: string, added: Mod[]): Mod {
    const name = native.resolve(specifier, referrer);
    return loadName(name, added);
  }

  function loadName(name: string, added: Mod[]): Mod {
    return registry.get(name) ?? register(name, added);
  }

  function loadGraph(start: (added: Mod[]) => Mod): Mod {
    const added: Mod[] = [];
    try {
      const mod = start(added);
      link(mod);
      return mod;
    } catch (error) {
      for (const mod of added) if (mod.status === "loaded") registry.delete(mod.name);
      throw error;
    }
  }

  // --- linking -------------------------------------------------------------

  function unlinked(root: Mod): Mod[] {
    const found: Mod[] = [];
    const seen = new Set<Mod>();
    const visit = (mod: Mod) => {
      if (seen.has(mod) || mod.status !== "loaded") return;
      seen.add(mod);
      found.push(mod);
      mod.requested.forEach(visit);
    };
    visit(root);
    return found;
  }

  function link(root: Mod): void {
    const fresh = unlinked(root);
    try {
      for (const mod of fresh) {
        mod.body = mod.record.f(mod.api);
        mod.body.next();
      }
      for (const mod of fresh) checkImports(mod);
      for (const mod of fresh) {
        mod.api.n = mod.requested.map(namespaceOf);
        mod.body!.next();
      }
    } catch (error) {
      for (const mod of fresh) unlink(mod);
      throw error;
    }
    for (const mod of fresh) mod.status = "linked";
  }

  function unlink(mod: Mod): void {
    mod.body = null;
    mod.locals = Object.create(null);
    mod.namespace = null;
  }

  function missingExport(mod: Mod, name: string, ambiguous: boolean): SyntaxError {
    const what = ambiguous ? "ambiguous" : "not found";
    return new SyntaxError(`Export named '${name}' ${what} in module '${mod.name}'.`);
  }

  function checkImports(mod: Mod): void {
    for (const [request, name] of mod.record.i) {
      const target = mod.requested[request]!;
      const binding = resolveExport(target, name, []);
      if (binding === null || binding === AMBIGUOUS) throw missingExport(target, name, binding === AMBIGUOUS);
    }
    for (const [name] of mod.record.x) {
      const binding = resolveExport(mod, name, []);
      if (binding === null || binding === AMBIGUOUS) throw missingExport(mod, name, binding === AMBIGUOUS);
    }
  }

  function sameBinding(a: Binding, b: Binding): boolean {
    return a.module === b.module && a.name === b.name;
  }

  function resolveExport(mod: Mod, name: string, seen: Binding[]): Binding | null | typeof AMBIGUOUS {
    if (seen.some(entry => entry.module === mod && entry.name === name)) return null;
    seen.push({ module: mod, name });
    if (hasOwn.call(mod.locals, name)) return { module: mod, name };
    for (const [exported, request, imported] of mod.record.x) {
      if (exported !== name) continue;
      const target = mod.requested[request]!;
      return imported === "*" ? { module: target, name: null } : resolveExport(target, imported, seen);
    }
    if (name === "default") return null;
    let found: Binding | null = null;
    for (const request of mod.record.s) {
      const binding = resolveExport(mod.requested[request]!, name, seen);
      if (binding === AMBIGUOUS) return AMBIGUOUS;
      if (binding === null) continue;
      if (found !== null && !sameBinding(found, binding)) return AMBIGUOUS;
      found = binding;
    }
    return found;
  }

  function exportedNames(mod: Mod, seen: Set<Mod>): string[] {
    if (seen.has(mod)) return [];
    seen.add(mod);
    const names = Object.keys(mod.locals).concat(mod.record.x.map(entry => entry[0]));
    for (const request of mod.record.s) {
      for (const name of exportedNames(mod.requested[request]!, seen)) {
        if (name !== "default" && !names.includes(name)) names.push(name);
      }
    }
    return names;
  }

  function bindingGetter(binding: Binding): Getter {
    if (binding.name === null) return () => namespaceOf(binding.module);
    return binding.module.locals[binding.name]!;
  }

  // Namespace properties are getters over the live bindings; the object is
  // non-extensible with a null prototype and the "Module" tag.
  function namespaceOf(mod: Mod): object {
    if (mod.namespace !== null) return mod.namespace;
    const namespace = Object.create(null);
    mod.namespace = namespace;
    for (const name of exportedNames(mod, new Set()).sort()) {
      const binding = resolveExport(mod, name, []);
      if (binding === null || binding === AMBIGUOUS) continue;
      Object.defineProperty(namespace, name, { get: bindingGetter(binding), enumerable: true });
    }
    Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
    Object.preventExtensions(namespace);
    return namespace;
  }

  // --- evaluation ----------------------------------------------------------

  function evaluate(root: Mod): Promise<void> {
    const mod = root.status === "evaluating-async" || root.status === "evaluated" ? root.cycleRoot ?? root : root;
    if (mod.capability !== null) return mod.capability.promise;
    const cap = capability();
    mod.capability = cap;
    const stack: Mod[] = [];
    try {
      innerEvaluate(mod, stack, 0);
    } catch (error) {
      for (const failed of stack) {
        failed.status = "evaluated";
        failed.error = { value: error };
      }
      cap.reject(error);
      return cap.promise;
    }
    if (mod.asyncOrder === null || mod.asyncOrder === "done") cap.resolve();
    return cap.promise;
  }

  function innerEvaluate(mod: Mod, stack: Mod[], index: number): number {
    if (mod.status === "evaluating-async" || mod.status === "evaluated") {
      if (mod.error !== null) throw mod.error.value;
      return index;
    }
    if (mod.status === "evaluating") return index;
    mod.status = "evaluating";
    mod.dfsIndex = index;
    mod.dfsAncestorIndex = index;
    mod.pendingAsync = 0;
    index += 1;
    stack.push(mod);
    for (const required of mod.requested) index = evaluateDependency(mod, required, stack, index);
    if (mod.pendingAsync > 0 || mod.record.a) {
      mod.asyncOrder = asyncCounter++;
      if (mod.pendingAsync === 0) executeAsync(mod);
    } else {
      executeSync(mod);
    }
    if (mod.dfsAncestorIndex === mod.dfsIndex) popCycle(mod, stack);
    return index;
  }

  function evaluateDependency(mod: Mod, required: Mod, stack: Mod[], index: number): number {
    index = innerEvaluate(required, stack, index);
    if (required.status === "evaluating") {
      mod.dfsAncestorIndex = Math.min(mod.dfsAncestorIndex, required.dfsAncestorIndex);
    } else {
      required = required.cycleRoot!;
      if (required.error !== null) throw required.error.value;
    }
    if (typeof required.asyncOrder === "number") {
      mod.pendingAsync += 1;
      required.asyncParents.push(mod);
    }
    return index;
  }

  function popCycle(mod: Mod, stack: Mod[]): void {
    for (;;) {
      const done = stack.pop()!;
      done.status = typeof done.asyncOrder === "number" ? "evaluating-async" : "evaluated";
      done.cycleRoot = mod;
      if (done === mod) return;
    }
  }

  function executeSync(mod: Mod): void {
    const body = mod.body!;
    mod.body = null;
    body.next();
  }

  // Run the body like an async function: a yielded value is awaited. Its
  // completion settles a promise whose reaction, one job later, releases the
  // importers (ExecuteAsyncModule).
  function executeAsync(mod: Mod): void {
    const body = mod.body!;
    mod.body = null;
    const done = capability();
    then(done.promise, () => asyncFulfilled(mod), error => asyncRejected(mod, error));
    const step = (resume: () => IteratorResult<unknown, void>) => {
      let result: IteratorResult<unknown, void>;
      try {
        result = resume();
      } catch (error) {
        done.reject(error);
        return;
      }
      if (result.done) {
        done.resolve();
        return;
      }
      then(resolvePromise(result.value), value => step(() => body.next(value)), error => step(() => body.throw(error)));
    };
    step(() => body.next());
  }

  function gatherAncestors(mod: Mod, list: Mod[]): void {
    for (const parent of mod.asyncParents) {
      if (list.includes(parent) || parent.cycleRoot!.error !== null) continue;
      parent.pendingAsync -= 1;
      if (parent.pendingAsync !== 0) continue;
      list.push(parent);
      if (!parent.record.a) gatherAncestors(parent, list);
    }
  }

  function asyncFulfilled(mod: Mod): void {
    if (mod.status === "evaluated") return;
    mod.asyncOrder = "done";
    mod.status = "evaluated";
    mod.capability?.resolve();
    const ready: Mod[] = [];
    gatherAncestors(mod, ready);
    ready.sort((a, b) => Number(a.asyncOrder) - Number(b.asyncOrder));
    for (const parent of ready) runReady(parent);
  }

  function runReady(mod: Mod): void {
    if (mod.status === "evaluated") return;
    if (mod.record.a) {
      executeAsync(mod);
      return;
    }
    try {
      executeSync(mod);
    } catch (error) {
      asyncRejected(mod, error);
      return;
    }
    mod.asyncOrder = "done";
    mod.status = "evaluated";
    mod.capability?.resolve();
  }

  function asyncRejected(mod: Mod, error: unknown): void {
    if (mod.status === "evaluated") return;
    mod.error = { value: error };
    mod.status = "evaluated";
    mod.asyncOrder = "done";
    mod.capability?.reject(error);
    for (const parent of mod.asyncParents) asyncRejected(parent, error);
  }

  // --- entry points --------------------------------------------------------

  function settleNamespace(mod: Mod): Promise<object> {
    return evaluate(mod).then(() => namespaceOf(mod));
  }

  // `import()` inside a module: loads in a later job, like a host fetch.
  function dynamicImport(specifier: unknown, referrer: string): Promise<object> {
    return resolvePromise().then(() => {
      const mod = loadGraph(added => load(String(specifier), referrer, added));
      return settleNamespace(mod);
    });
  }

  Object.defineProperty(globalThis, "__bunwasm_import", {
    value: (referrer: string) => (specifier: unknown) => dynamicImport(specifier, referrer),
    configurable: true,
  });

  return {
    // The engine's `import_module`: loads, links and starts evaluating now.
    importModule(specifier: string, referrer: string): Promise<object> {
      try {
        return settleNamespace(loadGraph(added => load(specifier, referrer, added)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    importName(name: string): Promise<object> {
      try {
        return settleNamespace(loadGraph(added => loadName(name, added)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    dynamicImport,
  };
})
