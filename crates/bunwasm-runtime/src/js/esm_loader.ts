// ES modules as registration records, for engines without a native module loader
// (Hermes) and for the browser engine's workers, whose import cycles cannot use
// native module URLs. Each module arrives as a registration record
// (bunwasm-transpiler's register.rs): its requests, imports and re-exports as
// data, and its body as a generator whose first two steps register export
// getters and bind dependency namespaces, and whose later steps are top-level
// awaits. This file links the records and evaluates them with the ECMAScript
// algorithm (16.2.1.5.3): depth-first with cycle roots, async modules, pending
// async dependencies, and async parents released in evaluation order.
//
// The factory captures every built-in it uses when it is created, which the
// host does before user code runs, so later changes to globals or prototypes
// cannot reach module loading.
//
// Once `native.active()` turns false (the process exited), nothing new starts:
// no native load or resolve, no module body, no resumed top-level await and no
// fulfilment or rejection. The pending promises stay pending, and no module the
// exit interrupted is marked evaluated.
type Getter = () => unknown;
type RecordBody = Generator<unknown, void, unknown>;
type ModuleRecord = {
  r: string[];
  i: [number, string][];
  x: [string, number, string][];
  s: number[];
  /** Local exports: [export name, local binding]. */
  e: [string, string][];
  a: boolean;
  f: (api: RegistrationApi) => RecordBody;
};
type RegistrationApi = {
  l(getters: Record<string, Getter>): void;
  n: object[];
  ns(request: number): object;
  readonly meta: object;
  import(specifier: unknown, options?: unknown): Promise<object>;
  ga(): unknown;
  gt(): string;
};
type RecordSessionBindings = {
  resolve(specifier: string, referrer: string): string;
  resolveImport?(specifier: string, referrer: string, mode: BunWasm.ImportMode): string;
  load(name: string): { record: ModuleRecord } | { namespace: unknown; default: unknown };
  initMeta(name: string, meta: object): void;
  /** False once the process has exited: nothing new loads, links, evaluates or resumes. */
  active?(): boolean;
  /** Keeps the host's event loop alive while a loader-started dynamic import is pending. */
  track?(operation: Promise<object>): Promise<object>;
  /** Readies `name` and its static imports for `load`, for a host that evaluates records asynchronously. */
  prepare?(name: string): Promise<void>;
};
(function (native: RecordSessionBindings, installHook?: boolean) {
  "use strict";
  type Status = "loaded" | "linked" | "evaluating" | "evaluating-async" | "evaluated";
  type Capability = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
  type Mod = {
    name: string;
    record: ModuleRecord;
    requested: Mod[];
    status: Status;
    /** Getters of the module's exported local bindings, by local name. */
    locals: Record<string, Getter>;
    /** Local exports: export name -> local binding. */
    exports: Map<string, string>;
    bindings: object | null;
    namespace: object | null;
    api: RegistrationApi;
    body: RecordBody | null;
    dfsIndex: number;
    dfsAncestorIndex: number;
    cycleRoot: Mod | null;
    asyncOrder: number | "done" | null;
    asyncParents: Mod[];
    pendingAsync: number;
    capability: Capability | null;
    error: { value: unknown } | null;
  };
  // A resolved export: the module and local binding that hold it, or the
  // module itself for `export * as ns`.
  type Binding = { module: Mod; name: string | null };

  const AMBIGUOUS = "ambiguous" as const;
  // Thrown to unwind loading or evaluation the exit interrupted; never reaches user code.
  const EXITED = { exited: true } as const;
  const call = Function.prototype.call;
  const uncurry = <A extends unknown[], R>(method: (...args: A) => R) =>
    call.bind(method) as unknown as (self: unknown, ...args: A) => R;
  const { create, defineProperty, keys, preventExtensions, is } = Object;
  const objectPrototype = Object.prototype;
  const { apply, get: reflectGet, getOwnPropertyDescriptor: reflectDescriptor, defineProperty: reflectDefine, deleteProperty: reflectDelete } = Reflect;
  const NativeProxy = Proxy;
  const NativePromise = Promise;
  const NativeMap = Map;
  const NativeSyntaxError = SyntaxError;
  let importRequests = globalThis.__bunwasm_importRequests;
  if (importRequests === undefined) {
    defineProperty(globalThis, "__bunwasm_initializeImportRequests", {
      value: (imports: BunWasm.ImportRequests) => { importRequests = imports; }, configurable: true,
    });
  }
  const NativeNumber = Number;
  const min = Math.min;
  const { toStringTag, iterator: iteratorSymbol, asyncIterator: asyncIteratorSymbol } = Symbol;
  // oxlint-disable-next-line no-eval -- A module's `arguments` is resolved in the global scope (ModuleApi.ga).
  const globalEval = eval;
  const rejectPromise = Promise.reject.bind(Promise) as (error: unknown) => Promise<never>;
  const mapForEach = uncurry(Map.prototype.forEach) as <K, V>(map: Map<K, V>, f: (value: V, key: K) => void) => void;
  const hasOwn = uncurry(Object.prototype.hasOwnProperty);
  const promiseThen = uncurry(Promise.prototype.then) as <T>(promise: Promise<T>, onFulfilled: (value: T) => unknown, onRejected?: (error: unknown) => unknown) => Promise<unknown>;
  const resolvePromise = Promise.resolve.bind(Promise) as <T>(value?: T) => Promise<T>;
  const arrayPush = uncurry(Array.prototype.push) as <T>(array: T[], item: T) => number;
  const arrayPop = uncurry(Array.prototype.pop) as <T>(array: T[]) => T | undefined;
  const arraySort = uncurry(Array.prototype.sort) as <T>(array: T[], compare?: (a: T, b: T) => number) => T[];
  const arraySlice = uncurry(Array.prototype.slice) as <T>(array: T[]) => T[];
  const arrayIncludes = uncurry(Array.prototype.includes) as <T>(array: T[], item: T) => boolean;
  const mapGet = uncurry(Map.prototype.get) as <K, V>(map: Map<K, V>, key: K) => V | undefined;
  const mapSet = uncurry(Map.prototype.set) as <K, V>(map: Map<K, V>, key: K, value: V) => Map<K, V>;
  const mapHas = uncurry(Map.prototype.has) as <K, V>(map: Map<K, V>, key: K) => boolean;
  const mapDelete = uncurry(Map.prototype.delete) as <K, V>(map: Map<K, V>, key: K) => boolean;
  const generatorPrototype = Object.getPrototypeOf(function* () {}).prototype as RecordBody;
  const generatorNext = uncurry(generatorPrototype.next) as (body: RecordBody, value?: unknown) => IteratorResult<unknown, void>;
  const generatorThrow = uncurry(generatorPrototype.throw) as (body: RecordBody, error: unknown) => IteratorResult<unknown, void>;
  function newSession(native: RecordSessionBindings, installHook = false) {
  const registry = new NativeMap<string, Mod>();
  let asyncCounter = 0;

  const active = (): boolean => native.active === undefined || native.active();
  // A promise for work the host no longer runs: no reaction of user code ever runs for it.
  const abandoned = <T>(): Promise<T> => new NativePromise<T>(() => {});
  function stillActive(): void {
    if (!active()) throw EXITED;
  }

  function then(promise: Promise<unknown>, onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): void {
    promiseThen(promise, onFulfilled, onRejected);
  }

  function capability(): Capability {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new NativePromise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function map<T, R>(items: T[], f: (item: T) => R): R[] {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) arrayPush(out, f(items[i]!));
    return out;
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
    // `import * as ns`: the module namespace object, created on first use.
    ns(request: number): object {
      return namespaceOf(this.mod.requested[request]!);
    }
    get meta(): object {
      if (this.metaObject !== null) return this.metaObject;
      const meta = create(null);
      this.metaObject = meta;
      native.initMeta(this.mod.name, meta);
      return meta;
    }
    import(specifier: unknown, options?: unknown): Promise<object> {
      return dynamicImport(specifier, this.mod.name, options);
    }
    // A module's `arguments` is the global binding, read in the global scope.
    ga(): unknown {
      return globalEval("arguments");
    }
    gt(): string {
      return globalEval("typeof arguments") as string;
    }
    ai(value: { [Symbol.asyncIterator]?: () => AsyncIterator<unknown>; [Symbol.iterator](): Iterator<unknown> }): AsyncIterator<unknown> {
      const method = value[asyncIteratorSymbol as typeof Symbol.asyncIterator];
      if (method != null) return apply(method, value, []);
      return fromSyncIterator(apply(value[iteratorSymbol as typeof Symbol.iterator], value, []));
    }
    ac(iterator: AsyncIterator<unknown>): unknown {
      const close = iterator.return;
      return close === undefined ? undefined : apply(close, iterator, []);
    }
  }

  function fromSyncIterator(iterator: Iterator<unknown>): AsyncIterator<unknown> {
    const settle = (result: IteratorResult<unknown>) =>
      promiseThen(resolvePromise(result.value), value => ({ value, done: result.done })) as Promise<IteratorResult<unknown>>;
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
      locals: create(null),
      exports: localExports(record),
      bindings: null,
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

  function localExports(record: ModuleRecord): Map<string, string> {
    const exports = new NativeMap<string, string>();
    for (let i = 0; i < record.e.length; i++) mapSet(exports, record.e[i]![0], record.e[i]![1]);
    return exports;
  }

  // A CommonJS, JSON or built-in module: its enumerable keys and values now,
  // with the default supplied separately. Each name is its own local.
  function syntheticRecord(namespace: unknown, defaultValue: unknown): ModuleRecord {
    const getters: Record<string, Getter> = create(null);
    const exports: [string, string][] = [];
    const source = namespace !== null && (typeof namespace === "object" || typeof namespace === "function") ? namespace : {};
    const names = keys(source);
    for (let i = 0; i < names.length; i++) {
      const key = names[i]!;
      if (key === "default" || key === "__esModule") continue;
      const value = reflectGet(source, key);
      defineProperty(getters, key, descriptor({ value: () => value, enumerable: true }));
      arrayPush(exports, [key, key]);
    }
    defineProperty(getters, "default", descriptor({ value: () => defaultValue, enumerable: true }));
    arrayPush(exports, ["default", "default"]);
    return {
      r: [], i: [], x: [], s: [], e: exports, a: false,
      f: function* (api) { api.l(getters); yield; yield; },
    };
  }

  // Register `name` from its record source and load what it imports. New
  // modules are appended to `added` so a failed load can forget them.
  function register(name: string, added: Mod[]): Mod {
    stillActive();
    const source = native.load(name);
    const record = "record" in source ? source.record : syntheticRecord(source.namespace, source.default);
    const mod = createModule(name, record);
    mapSet(registry, name, mod);
    arrayPush(added, mod);
    mod.requested = map(mod.record.r, specifier => load(specifier, name, added));
    return mod;
  }

  function load(specifier: string, referrer: string, added: Mod[]): Mod {
    stillActive();
    const name = native.resolve(specifier, referrer);
    return loadName(name, added);
  }

  function loadName(name: string, added: Mod[]): Mod {
    return mapGet(registry, name) ?? register(name, added);
  }

  function loadGraph(start: (added: Mod[]) => Mod): Mod {
    const added: Mod[] = [];
    try {
      const mod = start(added);
      link(mod);
      return mod;
    } catch (error) {
      for (let i = 0; i < added.length; i++) forget(added[i]!);
      throw error;
    }
  }

  function forget(mod: Mod): void {
    if (mod.status === "loaded" && mapGet(registry, mod.name) === mod) mapDelete(registry, mod.name);
  }

  // --- linking -------------------------------------------------------------

  function unlinked(root: Mod): Mod[] {
    const found: Mod[] = [];
    const seen = new NativeMap<Mod, true>();
    const visit = (mod: Mod) => {
      if (mapHas(seen, mod) || mod.status !== "loaded") return;
      mapSet(seen, mod, true);
      arrayPush(found, mod);
      for (let i = 0; i < mod.requested.length; i++) visit(mod.requested[i]!);
    };
    visit(root);
    return found;
  }

  function link(root: Mod): void {
    const fresh = unlinked(root);
    try {
      for (let i = 0; i < fresh.length; i++) start(fresh[i]!);
      for (let i = 0; i < fresh.length; i++) checkImports(fresh[i]!);
      for (let i = 0; i < fresh.length; i++) bind(fresh[i]!);
    } catch (error) {
      for (let i = 0; i < fresh.length; i++) unlink(fresh[i]!);
      throw error;
    }
    for (let i = 0; i < fresh.length; i++) fresh[i]!.status = "linked";
  }

  // The body runs as a strict function called without a receiver: module code's `this`.
  function start(mod: Mod): void {
    mod.body = apply(mod.record.f, undefined, [mod.api]);
    generatorNext(mod.body!);
  }

  function bind(mod: Mod): void {
    mod.api.n = map(mod.requested, bindingsOf);
    generatorNext(mod.body!);
  }

  function unlink(mod: Mod): void {
    mod.body = null;
    mod.locals = create(null);
    mod.bindings = null;
    mod.namespace = null;
  }

  // The local binding behind the local export `name`, when the module has one.
  function localBinding(mod: Mod, name: string): string | undefined {
    const local = mapGet(mod.exports, name);
    return local !== undefined && hasOwn(mod.locals, local) ? local : undefined;
  }

  function missingExport(mod: Mod, name: string, ambiguous: boolean): SyntaxError {
    const what = ambiguous ? "ambiguous" : "not found";
    return new NativeSyntaxError(`Export named '${name}' ${what} in module '${mod.name}'.`);
  }

  function checkImports(mod: Mod): void {
    const imports = mod.record.i;
    for (let i = 0; i < imports.length; i++) {
      const request = imports[i]![0];
      const name = imports[i]![1];
      const target = mod.requested[request]!;
      const binding = resolveExport(target, name, []);
      if (binding === null || binding === AMBIGUOUS) throw missingExport(target, name, binding === AMBIGUOUS);
    }
    const reexports = mod.record.x;
    for (let i = 0; i < reexports.length; i++) {
      const name = reexports[i]![0];
      const binding = resolveExport(mod, name, []);
      if (binding === null || binding === AMBIGUOUS) throw missingExport(mod, name, binding === AMBIGUOUS);
    }
  }

  function sameBinding(a: Binding, b: Binding): boolean {
    return a.module === b.module && a.name === b.name;
  }

  function seenBefore(seen: Binding[], mod: Mod, name: string): boolean {
    for (let i = 0; i < seen.length; i++) {
      if (seen[i]!.module === mod && seen[i]!.name === name) return true;
    }
    return false;
  }

  function resolveExport(mod: Mod, name: string, seen: Binding[]): Binding | null | typeof AMBIGUOUS {
    if (seenBefore(seen, mod, name)) return null;
    arrayPush(seen, { module: mod, name });
    const local = localBinding(mod, name);
    if (local !== undefined) return { module: mod, name: local };
    const reexports = mod.record.x;
    for (let i = 0; i < reexports.length; i++) {
      const reexport = reexports[i]!;
      if (reexport[0] !== name) continue;
      const imported = reexport[2];
      const target = mod.requested[reexport[1]]!;
      return imported === "*" ? { module: target, name: null } : resolveExport(target, imported, seen);
    }
    if (name === "default") return null;
    return resolveStarExport(mod, name, seen);
  }

  function resolveStarExport(mod: Mod, name: string, seen: Binding[]): Binding | null | typeof AMBIGUOUS {
    let found: Binding | null = null;
    const stars = mod.record.s;
    for (let i = 0; i < stars.length; i++) {
      const binding = resolveExport(mod.requested[stars[i]!]!, name, seen);
      if (binding === AMBIGUOUS) return AMBIGUOUS;
      if (binding === null) continue;
      if (found !== null && !sameBinding(found, binding)) return AMBIGUOUS;
      found = binding;
    }
    return found;
  }

  function exportedNames(mod: Mod, seen: Mod[]): string[] {
    if (arrayIncludes(seen, mod)) return [];
    arrayPush(seen, mod);
    const names: string[] = [];
    mapForEach(mod.exports, (local, name) => {
      if (hasOwn(mod.locals, local)) arrayPush(names, name);
    });
    const reexports = mod.record.x;
    for (let i = 0; i < reexports.length; i++) arrayPush(names, reexports[i]![0]);
    const stars = mod.record.s;
    for (let i = 0; i < stars.length; i++) addStarNames(names, exportedNames(mod.requested[stars[i]!]!, seen));
    return names;
  }

  function addStarNames(names: string[], starNames: string[]): void {
    for (let i = 0; i < starNames.length; i++) {
      const name = starNames[i]!;
      if (name !== "default" && !arrayIncludes(names, name)) arrayPush(names, name);
    }
  }

  function bindingGetter(binding: Binding): Getter {
    if (binding.name === null) {
      const target = binding.module;
      return () => namespaceOf(target);
    }
    return binding.module.locals[binding.name]!;
  }

  // The module's exports and their binding getters, in namespace key order (UTF-16
  // code units, as `Array.prototype.sort` compares strings).
  function exportGetters(mod: Mod): Map<string, Getter> {
    const names = arraySort(exportedNames(mod, []));
    const getters = new NativeMap<string, Getter>();
    for (let i = 0; i < names.length; i++) {
      const binding = resolveExport(mod, names[i]!, []);
      if (binding !== null && binding !== AMBIGUOUS) mapSet(getters, names[i]!, bindingGetter(binding));
    }
    return getters;
  }

  // What a module's named imports read: getters over the live bindings. Never
  // given to user code; the module namespace object is `namespaceOf`. Records read
  // only linked export names, which are own properties, so the ordinary prototype is
  // never consulted; it keeps V8 from storing the object as a slow dictionary
  // (`Object.create(null)` does), which makes each import read about 35% faster.
  function bindingsOf(mod: Mod): object {
    if (mod.bindings !== null) return mod.bindings;
    const bindings = create(objectPrototype);
    mod.bindings = bindings;
    mapForEach(exportGetters(mod), (getter, name) => defineProperty(bindings, name, descriptor({ get: getter, enumerable: true })));
    preventExtensions(bindings);
    return bindings;
  }

  // A property descriptor without a prototype, so properties added to Object.prototype by
  // user code are not read as descriptor fields.
  function descriptor(fields: PropertyDescriptor): PropertyDescriptor {
    return { __proto__: null, ...fields } as PropertyDescriptor;
  }

  // The module namespace object (ECMA-262 10.4.6). Its target holds a writable,
  // non-configurable data property per export (so a Proxy may report live values for
  // them) and the "Module" tag, and is not extensible. Reads and descriptor reads go
  // through the binding, so an uninitialized export throws, as natively.
  function namespaceOf(mod: Mod): object {
    if (mod.namespace !== null) return mod.namespace;
    const getters = exportGetters(mod);
    const target = create(null);
    const ownKeys: (string | symbol)[] = [];
    mapForEach(getters, (_, name) => {
      defineProperty(target, name, descriptor({ value: undefined, writable: true, enumerable: true, configurable: false }));
      arrayPush(ownKeys, name);
    });
    defineProperty(target, toStringTag, descriptor({ value: "Module", writable: false, enumerable: false, configurable: false }));
    arrayPush(ownKeys, toStringTag);
    preventExtensions(target);
    const exportGetter = (key: string | symbol) => typeof key === "string" ? mapGet(getters, key) : undefined;
    // No prototype: a trap is looked up on the handler at every operation.
    const handler: ProxyHandler<object> = {
      __proto__: null,
      get(target, key, receiver) {
        const getter = exportGetter(key);
        return getter === undefined ? reflectGet(target, key, receiver) : getter();
      },
      getOwnPropertyDescriptor(target, key) {
        const getter = exportGetter(key);
        if (getter === undefined) return reflectDescriptor(target, key);
        return descriptor({ value: getter(), writable: true, enumerable: true, configurable: false });
      },
      defineProperty(target, key, fields) {
        if (typeof key === "symbol") return reflectDefine(target, key, fields);
        const getter = exportGetter(key);
        return getter !== undefined && compatible(fields, getter());
      },
      deleteProperty(target, key) {
        if (typeof key === "symbol") return reflectDelete(target, key);
        return !mapHas(getters, key);
      },
      set() {
        return false;
      },
      ownKeys() {
        return arraySlice(ownKeys);
      },
    } as ProxyHandler<object>;
    const namespace = new NativeProxy(target, handler);
    mod.namespace = namespace;
    return namespace;
  }

  // [[DefineOwnProperty]] of a namespace export (ECMA-262 10.4.6.6), after its current
  // value was read.
  function compatible(descriptor: PropertyDescriptor, current: unknown): boolean {
    if (descriptor.configurable === true || descriptor.enumerable === false) return false;
    if ("get" in descriptor || "set" in descriptor || descriptor.writable === false) return false;
    return "value" in descriptor ? is(descriptor.value, current) : true;
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
      if (error === EXITED || !active()) return abandoned();
      for (let i = 0; i < stack.length; i++) {
        stack[i]!.status = "evaluated";
        stack[i]!.error = { value: error };
      }
      cap.reject(error);
      return cap.promise;
    }
    if (!active()) return abandoned();
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
    arrayPush(stack, mod);
    for (let i = 0; i < mod.requested.length; i++) index = evaluateDependency(mod, mod.requested[i]!, stack, index);
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
      mod.dfsAncestorIndex = min(mod.dfsAncestorIndex, required.dfsAncestorIndex);
    } else {
      required = required.cycleRoot!;
      if (required.error !== null) throw required.error.value;
    }
    if (typeof required.asyncOrder === "number") {
      mod.pendingAsync += 1;
      arrayPush(required.asyncParents, mod);
    }
    return index;
  }

  function popCycle(mod: Mod, stack: Mod[]): void {
    for (;;) {
      const done = arrayPop(stack)!;
      done.status = typeof done.asyncOrder === "number" ? "evaluating-async" : "evaluated";
      done.cycleRoot = mod;
      if (done === mod) return;
    }
  }

  function executeSync(mod: Mod): void {
    stillActive();
    const body = mod.body!;
    mod.body = null;
    generatorNext(body);
  }

  // Run the body like an async function: a yielded value is awaited. Its
  // completion settles a promise whose reaction, one job later, releases the
  // importers (ExecuteAsyncModule). Nothing resumes after the process exited.
  function executeAsync(mod: Mod): void {
    stillActive();
    const body = mod.body!;
    mod.body = null;
    const done = capability();
    then(done.promise, () => asyncFulfilled(mod), error => asyncRejected(mod, error));
    const step = (resume: () => IteratorResult<unknown, void>) => {
      if (!active()) return;
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
      then(resolvePromise(result.value), value => step(() => generatorNext(body, value)), error => step(() => generatorThrow(body, error)));
    };
    step(() => generatorNext(body));
  }

  function gatherAncestors(mod: Mod, list: Mod[]): void {
    for (let i = 0; i < mod.asyncParents.length; i++) {
      const parent = mod.asyncParents[i]!;
      if (arrayIncludes(list, parent) || parent.cycleRoot!.error !== null) continue;
      parent.pendingAsync -= 1;
      if (parent.pendingAsync !== 0) continue;
      arrayPush(list, parent);
      if (!parent.record.a) gatherAncestors(parent, list);
    }
  }

  function asyncFulfilled(mod: Mod): void {
    if (mod.status === "evaluated" || !active()) return;
    mod.asyncOrder = "done";
    mod.status = "evaluated";
    mod.capability?.resolve();
    const ready: Mod[] = [];
    gatherAncestors(mod, ready);
    arraySort(ready, (a, b) => NativeNumber(a.asyncOrder) - NativeNumber(b.asyncOrder));
    for (let i = 0; i < ready.length; i++) runReady(ready[i]!);
  }

  function runReady(mod: Mod): void {
    if (mod.status === "evaluated" || !active()) return;
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
    if (mod.status === "evaluated" || !active()) return;
    mod.error = { value: error };
    mod.status = "evaluated";
    mod.asyncOrder = "done";
    mod.capability?.reject(error);
    for (let i = 0; i < mod.asyncParents.length; i++) asyncRejected(mod.asyncParents[i]!, error);
  }

  // --- entry points --------------------------------------------------------

  // A promise `run` settles. Reactions here never return a promise, so settling one looks up
  // no `then` that user code could have replaced; only a namespace (as natively) is resolved
  // with. After the exit nothing is published, neither a namespace nor an error.
  function settled<T>(run: (resolve: (value: T) => void, reject: (error: unknown) => void) => void): Promise<T> {
    return new NativePromise<T>((resolve, reject) => {
      run(value => { if (active()) resolve(value); }, error => { if (active()) reject(error); });
    });
  }

  function settleNamespace(mod: Mod): Promise<object> {
    return settled<object>((resolve, reject) => then(evaluate(mod), () => resolve(namespaceOf(mod)), reject));
  }

  function track(operation: Promise<object>): Promise<object> {
    return native.track === undefined ? operation : native.track(operation);
  }

  // `import()` inside a module: loads in a later job, like a host fetch, once the
  // host has readied the module's graph.
  function dynamicImport(specifier: unknown, referrer: string, options?: unknown): Promise<object> {
    const requests = importRequests;
    if (requests === undefined) throw new NativeSyntaxError("Import helpers are not initialized");
    return track(requests.request<object>(specifier, options, (text, mode, resolve, reject) => {
      if (!active()) return;
      let name: string;
      let ready: Promise<void>;
      try {
        name = native.resolveImport ? native.resolveImport(text, referrer, mode) : mode === "text" ? requests.resolve(text, referrer, mode) : native.resolve(text, referrer);
        ready = native.prepare === undefined ? resolvePromise() : native.prepare(name);
      } catch (error) {
        reject(error);
        return;
      }
      then(ready, () => then(settleGraph(added => loadName(name, added)), value => resolve(value as object), reject), reject);
    }));
  }

  if (installHook) defineProperty(globalThis, "__bunwasm_import", descriptor({
    value: (referrer: string) => (specifier: unknown, options?: unknown) => dynamicImport(specifier, referrer, options),
    configurable: true,
  }));

  function settleGraph(start: (added: Mod[]) => Mod): Promise<object> {
    if (!active()) return abandoned();
    try {
      return settleNamespace(loadGraph(start));
    } catch (error) {
      return error === EXITED || !active() ? abandoned() : rejectPromise(error);
    }
  }

  return {
    // The engine's `import_module`: loads, links and starts evaluating now.
    importModule(specifier: string, referrer: string): Promise<object> {
      return settleGraph(added => load(specifier, referrer, added));
    },
    importName(name: string): Promise<object> {
      return settleGraph(added => loadName(name, added));
    },
    dynamicImport,
    newSession,
  };
  }
  return newSession(native, installHook !== false);
})
