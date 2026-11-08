(function (internal: BunWasm.WasmInternal) {
  'use strict';
  type MemoryState = { resource: number; generation: bigint | undefined; token?: number } & (
    { kind: 'unshared'; buffer: ArrayBuffer } | { kind: 'shared'; buffer: SharedArrayBuffer; prefixes?: Map<number, WeakRef<SharedArrayBuffer>> }
  );
  type Callback = { callback: (...args: unknown[]) => unknown; results: BunWasm.WasmType[] };
  type Callable = (...args: unknown[]) => unknown;
  const native = internal.native.wasm;
  const modules = new WeakMap<Module, BunWasm.WasmModule>();
  const memoryStates = new WeakMap<Memory, MemoryState>();
  const tableStates = new WeakMap<Table, BunWasm.WasmTable>();
  const globalStates = new WeakMap<Global, { id: number; name: string; type: BunWasm.WasmType; mutable: boolean }>();
  const memories = new Map<number, WeakRef<Memory>>();
  const memoryResources = new Map<number, WeakRef<MemoryState>>();
  const memoryBufferStates = new WeakMap<ArrayBuffer | SharedArrayBuffer, MemoryState>();
  const tables = new Map<number, WeakRef<Table>>();
  const functions = new Map<number, Callable>();
  const functionStates = new WeakMap<object, BunWasm.WasmFunction>();
  const callbacks: Callback[] = [];
  const nestedCallbacks = new Map<number, Callback>();
  const freeNestedCallbacks: number[] = [];
  let nextNestedCallback = 0;
  // Wasmi retains externrefs until Store teardown. These roots have the same runtime lifetime.
  const references = new Map<number, unknown>();
  const memoryCleanup = new FinalizationRegistry<{ resource: number; reference: WeakRef<Memory> }>(({ resource, reference }) => {
    if (memories.get(resource) === reference) memories.delete(resource);
  });
  const memoryBuffers = new WeakSet<ArrayBuffer | SharedArrayBuffer>();
  internal.isWasmMemoryBuffer = value => (value instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && value instanceof SharedArrayBuffer)) && memoryBuffers.has(value);
  class CompileError extends Error { constructor(message: string) { super(message); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor(message: string) { super(message); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor(message: string) { super(message); this.name = 'RuntimeError'; } }
  function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
  function byteView(source: unknown): Uint8Array {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new TypeError('Expected a WebAssembly BufferSource');
  }
  function description(module: Module) {
    const result = modules.get(module);
    if (!result) throw new TypeError('Expected a WebAssembly.Module');
    return result;
  }
  class Module {
    constructor(source: unknown) {
      const input = byteView(source);
      try { modules.set(this, native.compile(input)); }
      catch (error) { throw new CompileError(message(error)); }
    }
    static imports(module: Module) { return description(module).imports.map(({ module, name, kind }) => ({ module, name, kind })); }
    static exports(module: Module) { return description(module).exports.map(({ name, kind }) => ({ name, kind })); }
  }
  function isObject(value: unknown): value is object {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }
  function exoticPrimitive(method: unknown, receiver: object) {
    if (typeof method !== 'function') throw new TypeError('Invalid primitive conversion');
    const result: unknown = Reflect.apply(method, receiver, ['number']);
    if (isObject(result)) throw new TypeError('Invalid primitive conversion result');
    return result;
  }
  function primitive(value: unknown): unknown {
    if (!isObject(value)) return value;
    const exotic: unknown = Reflect.get(value, Symbol.toPrimitive);
    if (exotic !== undefined && exotic !== null) return exoticPrimitive(exotic, value);
    for (const key of ['valueOf', 'toString']) {
      const method: unknown = Reflect.get(value, key);
      if (typeof method !== 'function') continue;
      const result: unknown = Reflect.apply(method, value, []);
      if (!isObject(result)) return result;
    }
    throw new TypeError('Cannot convert object to primitive');
  }
  function numeric(value: unknown) {
    const input = primitive(value);
    if (typeof input === 'bigint') throw new TypeError('Cannot convert BigInt to number');
    return Number(input);
  }
  function count(value: unknown) {
    const number = numeric(value);
    if (!Number.isFinite(number) || number < 0 || Math.trunc(number) > 0xffffffff) throw new TypeError('Invalid WebAssembly size');
    return Math.trunc(number);
  }
  class Memory {
    constructor(descriptor: { initial: unknown; maximum?: unknown; shared?: unknown }) {
      if (!descriptor || (typeof descriptor !== 'object' && typeof descriptor !== 'function')) throw new TypeError('WebAssembly.Memory descriptor must be an object');
      const initial = count(descriptor.initial);
      if (initial > 65536) throw new RangeError('WebAssembly.Memory exceeds the 32-bit page limit');
      const limit = descriptor.maximum;
      const maximum = limit === undefined ? undefined : count(limit);
      if (maximum !== undefined && maximum > 65536) throw new RangeError('WebAssembly.Memory exceeds the 32-bit page limit');
      if (maximum !== undefined && maximum < initial) throw new RangeError('WebAssembly.Memory maximum is smaller than initial');
      const shared = !!descriptor.shared;
      if (shared && maximum === undefined) throw new TypeError('Shared WebAssembly memories require a maximum');
      if (shared && !native.sharedMemorySupported()) throw new LinkError('Shared WebAssembly memories are not supported');
      let resource: number;
      try { resource = shared && maximum !== undefined ? native.createSharedMemory(initial, maximum) : native.createMemory(initial, maximum); }
      catch (error) { throw new RangeError(message(error)); }
      rememberMemory(resource, this);
      refreshMemory(memoryState(this));
    }
    get buffer() { const state = memoryState(this); if (state.kind === 'shared') refreshMemory(state); return state.buffer; }
    grow(delta: unknown) {
      const state = memoryState(this);
      const amount = count(delta);
      let old: number;
      try { old = native.growMemory(state.resource, amount); }
      catch (error) { throw new RangeError(message(error)); }
      refreshMemory(state);
      return old;
    }
  }
  function tableState(table: Table) {
    const state = tableStates.get(table);
    if (!state) throw new TypeError('Expected a WebAssembly.Table');
    return state;
  }
  class Table {
    constructor(descriptor: { element: unknown; initial: unknown; maximum?: unknown }, value?: unknown) {
      if (!isObject(descriptor)) throw new TypeError('WebAssembly.Table descriptor must be an object');
      const requested = String(descriptor.element);
      if (requested !== 'anyfunc' && requested !== 'externref') throw new TypeError('Invalid WebAssembly table element');
      const element = requested === 'anyfunc' ? 'funcref' : 'externref';
      const initial = count(descriptor.initial);
      const limit = descriptor.maximum;
      const maximum = limit === undefined ? undefined : count(limit);
      if (maximum !== undefined && maximum < initial) throw new RangeError('WebAssembly.Table maximum is smaller than initial');
      const init = coerce(value === undefined && element === 'funcref' ? null : value, element);
      let state: BunWasm.WasmTable;
      try { state = native.createTable(element, initial, maximum, init); }
      catch (error) { throw new RangeError(message(error)); }
      tableStates.set(this, state);
      tables.set(state.id, new WeakRef(this));
    }
    get length() { return native.tableLength(tableState(this).id); }
    get(index: unknown) { return decode(native.tableGet(tableState(this).id, count(index))); }
    set(index: unknown, value?: unknown) {
      const state = tableState(this);
      const offset = count(index);
      native.tableSet(state.id, offset, coerce(arguments.length < 2 && state.element === 'funcref' ? null : value, state.element));
    }
    grow(delta: unknown, value?: unknown) {
      const state = tableState(this);
      const amount = count(delta);
      return native.tableGrow(state.id, amount, coerce(arguments.length < 2 && state.element === 'funcref' ? null : value, state.element));
    }
  }
  function globalState(global: Global) {
    const state = globalStates.get(global);
    if (!state) throw new TypeError('Expected a WebAssembly.Global');
    return state;
  }
  class Global {
    constructor() { throw new LinkError('Standalone WebAssembly globals are not supported'); }
    get value() { const state = globalState(this); return decode(native.global(state.id, state.name)); }
    set value(value: unknown) {
      const state = globalState(this);
      if (!state.mutable) throw new TypeError('Immutable WebAssembly global');
      native.global(state.id, state.name, coerce(value, state.type));
    }
    valueOf() { return this.value; }
  }
  function memoryState(memory: Memory) {
    const state = memoryStates.get(memory);
    if (!state) throw new TypeError('Expected a WebAssembly.Memory');
    return state;
  }
  function sync(action: (state: MemoryState) => void) {
    for (const [resource, reference] of memoryResources) {
      const state = reference.deref();
      if (!state) { memoryResources.delete(resource); continue; }
      action(state);
    }
  }
  function memoryResourceState(resource: number) {
    const known = memoryResources.get(resource)?.deref();
    if (known) return known;
    const span = native.memorySpan(resource);
    const state: MemoryState = span.shared
      ? { kind: 'shared', resource, buffer: internal.native.wasmSharedMemoryBuffer(resource), generation: span.generation }
      : { kind: 'unshared', resource, buffer: new ArrayBuffer(0), generation: undefined };
    if (state.kind === 'shared') { memoryBufferStates.set(state.buffer, state); memoryBuffers.add(state.buffer); }
    memoryResources.set(resource, new WeakRef(state));
    return state;
  }
  function rememberMemory(resource: number, memory: Memory) {
    const reference = new WeakRef(memory);
    memoryStates.set(memory, memoryResourceState(resource));
    memories.set(resource, reference);
    memoryCleanup.register(memory, { resource, reference });
  }
  // The buffer views the store's bytes in place. Only growth can move them, so after
  // every call, resume or grow that might have grown a memory, the old buffer and all
  // its views are detached before user code runs again.
  function refreshMemory(memory: MemoryState) {
    const { generation } = native.memorySpan(memory.resource);
    if (memory.generation === generation) return;
    if (memory.kind === 'shared') {
      memory.buffer = internal.native.wasmSharedMemoryBuffer(memory.resource);
    } else {
      const previous = memory.generation === undefined ? undefined : memory.buffer;
      memoryBufferStates.delete(memory.buffer);
      memory.buffer = internal.native.wasmMemoryBuffer(memory.resource, previous);
    }
    memory.generation = generation;
    memoryBufferStates.set(memory.buffer, memory);
    memoryBuffers.add(memory.buffer);
  }
  function execute(action: () => BunWasm.WasmCall) {
    try { return action(); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new RuntimeError(message(error));
    } finally { sync(refreshMemory); }
  }
  function coerce(value: unknown, type: BunWasm.WasmType): BunWasm.WasmValue {
    switch (type) {
      case 'v128': throw new TypeError('WebAssembly v128 cannot cross the JavaScript boundary');
      case 'i32': return numeric(value) >> 0;
      case 'i64': {
        const input = primitive(value);
        if (typeof input !== 'bigint' && typeof input !== 'boolean' && typeof input !== 'string') throw new TypeError('Expected a WebAssembly i64');
        return BigInt.asIntN(64, BigInt(input));
      }
      case 'f32': return Math.fround(numeric(value));
      case 'f64': return numeric(value);
      case 'funcref': {
        if (value === null) return null;
        const info = typeof value === 'function' ? functionStates.get(value) : undefined;
        if (!info) throw new TypeError('Expected a WebAssembly function');
        return { kind: 'function', id: info.id };
      }
      case 'externref': {
        if (value === null) return null;
        const id = references.size;
        references.set(id, value);
        return { kind: 'externref', id };
      }
    }
  }
  function decode(value: BunWasm.WasmValue): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (value.kind === 'function') return callable(native.functionInfo(value.id));
    if (!references.has(value.id)) throw new RuntimeError('Invalid WebAssembly externref');
    return references.get(value.id);
  }
  function callable(info: BunWasm.WasmFunction): Callable {
    const existing = functions.get(info.id);
    if (existing) return existing;
    const fn = (...args: unknown[]) => invoke(info, args);
    functionStates.set(fn, info);
    functions.set(info.id, fn);
    return fn;
  }
  function invoke(info: BunWasm.WasmFunction, args: unknown[]) {
    if (info.results.includes('v128')) throw new TypeError('WebAssembly v128 cannot cross the JavaScript boundary');
    const inputs = info.params.map((type, index) => coerce(args[index], type));
    let result = info.backend === 'nested' ? nestedExecute(token => native.call(info.id, inputs, token)) : execute(() => native.call(info.id, inputs));
    while ('import' in result) result = imported(result);
    const values = result.values.map(decode);
    if (values.length === 1) return values[0];
    return values.length === 0 ? undefined : values;
  }
  function nestedCallback(id: number, args: BunWasm.WasmValue[]) {
    const entry = nestedCallbacks.get(id);
    if (!entry) throw new RuntimeError('Invalid nested callback');
    return callbackResults(entry, args).map((value, index) => ({ type: entry.results[index], value }));
  }
  function nestedExecute<T>(action: (token: number) => T): T {
    return internal.native.wasmNestedExecute(token => {
      try { return action(token); }
      catch (error) {
        if (error instanceof Error && error.name === 'LinkError') throw new LinkError(error.message);
        if (error instanceof Error && error.name === 'RuntimeError') throw new RuntimeError(error.message);
        throw error;
      }
    }, nestedCallback);
  }
  function callbackResults(entry: Callback, args: BunWasm.WasmValue[]) {
    const value = entry.callback(...args.map(decode));
    if (entry.results.length === 0) return [];
    if (entry.results.length === 1) return [coerce(value, entry.results[0])];
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || !(Symbol.iterator in value)) throw new TypeError('Invalid WebAssembly result sequence');
    const iterator = value[Symbol.iterator];
    if (typeof iterator !== 'function') throw new TypeError('Invalid WebAssembly result sequence');
    const values: unknown[] = Array.from({ [Symbol.iterator]: () => iterator.call(value) });
    if (values.length !== entry.results.length) throw new TypeError('Invalid WebAssembly result count');
    return values.map((value, index) => coerce(value, entry.results[index]));
  }
  function imported(result: { call: number; import: number; args: BunWasm.WasmValue[] }) {
    const entry = callbacks[result.import];
    let values: BunWasm.WasmValue[];
    try { values = callbackResults(entry, result.args); }
    catch (error) { native.cancel(result.call); throw error; }
    return execute(() => native.resume(result.call, values));
  }
  type Exports = Record<string, Callable | Memory | Table | Global>;
  type Imports = Record<string, Record<string, unknown>>;
  class Instance {
    declare readonly exports: Exports;
    constructor(module: Module, imports: Imports = {}) {
      const info = description(module);
      const provisional: number[] = [];
      const bindings = instanceBindings(info, imports, provisional);
      let id: number;
      try { id = info.backend === 'nested' ? nestedExecute(token => native.instantiate(info.id, bindings, token)) : native.instantiate(info.id, bindings); }
      catch (error) {
        releaseCallbacks(info, provisional);
        if (info.backend === 'nested') throw error;
        throw new LinkError(message(error));
      }
      finally { if (info.backend !== 'nested') sync(refreshMemory); }
      const exports: Exports = Object.create(null);
      for (const item of info.exports) installExport(id, exports, item);
      if (info.backend !== 'nested') sync(refreshMemory);
      Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true });
    }
  }
  function retainNestedCallback(entry: Callback) {
    const limit = native.nestedCallbackLimit();
    if (nestedCallbacks.size >= limit) throw new RangeError('Nested callback resource limit');
    const id = freeNestedCallbacks.pop() ?? nextNestedCallback++;
    nestedCallbacks.set(id, entry);
    return id;
  }
  function releaseCallbacks(info: BunWasm.WasmModule, provisional: number[]) {
    for (const id of provisional) {
      if (info.backend !== 'nested') { delete callbacks[id]; continue; }
      if (nestedCallbacks.delete(id)) freeNestedCallbacks.push(id);
    }
  }
  function instanceBindings(info: BunWasm.WasmModule, imports: Imports, provisional: number[]) {
    try { return info.imports.map(item => binding(item, imports[item.module]?.[item.name], provisional, info.backend)); }
    catch (error) { releaseCallbacks(info, provisional); throw error; }
  }
  function binding(item: BunWasm.WasmImport, value: unknown, provisional: number[], backend: 'nested' | undefined): number | bigint | null | BunWasm.WasmReference | { kind: 'callback'; id: number } {
    if (item.kind === 'function' && typeof value === 'function') {
      const existing = functionStates.get(value);
      if (existing) return { kind: 'function', id: existing.id };
      const entry: Callback = { callback: (...args) => value(...args), results: item.results };
      const id = backend === 'nested' ? retainNestedCallback(entry) : callbacks.push(entry) - 1;
      provisional.push(id);
      return { kind: 'callback', id };
    }
    if (item.kind === 'memory' && value instanceof Memory) return memoryState(value).resource;
    if (item.kind === 'table' && value instanceof Table) return tableState(value).id;
    if (item.kind === 'global' && backend === 'nested') return globalImport(item, value);
    throw new LinkError(`Missing or unsupported WebAssembly import ${item.module}.${item.name}`);
  }
  function globalImport(item: Extract<BunWasm.WasmImport, { kind: 'global' }>, value: unknown) {
    if (value instanceof Global) {
      const state = globalStates.get(value);
      if (!state || state.type !== item.type || state.mutable !== item.mutable) throw new LinkError('Incompatible WebAssembly global import');
      return coerce(value.value, item.type);
    }
    const expected = item.type === 'i64' ? 'bigint' : 'number';
    if (typeof value !== expected) throw new LinkError('Invalid WebAssembly global import value');
    return coerce(value, item.type);
  }
  function installExport(id: number, exports: Exports, item: BunWasm.WasmExport) {
    const name = item.name;
    if (item.kind === 'function') { exports[name] = callable(native.functionIdentity(id, name)); return; }
    if (item.kind === 'global') {
      const global: Global = Object.create(Global.prototype);
      globalStates.set(global, { id, name, type: item.type, mutable: item.mutable });
      exports[name] = global;
      return;
    }
    if (item.kind === 'table') {
      const info = native.tableIdentity(id, name);
      let table = tables.get(info.id)?.deref();
      if (!table) {
        const created: Table = Object.create(Table.prototype);
        tableStates.set(created, info);
        tables.set(info.id, new WeakRef(created));
        table = created;
      }
      exports[name] = table;
      return;
    }
    exports[name] = memoryObject(native.memoryIdentity(id, name));
  }
  function memoryObject(resource: number) {
    const known = memories.get(resource)?.deref();
    if (known) return known;
    const created: Memory = Object.create(Memory.prototype);
    rememberMemory(resource, created);
    return created;
  }
  // Workers of one group exchange references to objects its shm service owns. Every member
  // leases the same region and shares the same compiled code; nothing is copied.
  const sharedLength = typeof SharedArrayBuffer === 'function' ? Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength')!.get! : undefined;
  const localMemories = new Map<number, number>();
  const localModules = new Map<number, BunWasm.WasmModule>();
  const moduleTokens = new WeakMap<BunWasm.WasmModule, number>();
  function cloneError(reason: unknown) { return new DOMException(message(reason), 'DataCloneError'); }
  function directoryToken(id: string, kind: string) {
    const [prefix, value] = id.split('/');
    const token = Number(value);
    if (prefix !== kind || !Number.isInteger(token) || token <= 0) throw cloneError('Invalid shared object reference');
    return token;
  }
  function attachedMemory(token: number) {
    let resource = localMemories.get(token);
    if (resource === undefined) {
      try { resource = native.attachSharedMemory(token); }
      catch (error) { throw cloneError(error); }
      localMemories.set(token, resource);
    }
    const state = memoryResourceState(resource);
    state.token = token;
    return state;
  }
  function attachedModule(token: number) {
    let info = localModules.get(token);
    if (!info) {
      try { info = native.attachSharedModule(token); }
      catch (error) { throw cloneError(error); }
      localModules.set(token, info);
      moduleTokens.set(info, token);
    }
    // Structured clone gives each receipt a new Module over the same compiled code.
    const module: Module = Object.create(Module.prototype);
    modules.set(module, info);
    return module;
  }
  function memoryPrefix(state: MemoryState, byteLength: number) {
    if (state.kind !== 'shared') throw cloneError('Expected a shared WebAssembly.Memory');
    refreshMemory(state);
    if (sharedLength!.call(state.buffer) === byteLength) return state.buffer;
    state.prefixes ??= new Map();
    const known = state.prefixes.get(byteLength)?.deref();
    if (known) return known;
    let view: SharedArrayBuffer;
    try { view = internal.native.wasmSharedMemoryBuffer(state.resource, byteLength); }
    catch (error) { throw cloneError(error); }
    state.prefixes.set(byteLength, new WeakRef(view));
    memoryBufferStates.set(view, state);
    memoryBuffers.add(view);
    return view;
  }
  function beginPublication(): BunWasm.SharedPublication {
    const fresh: (() => void)[] = [];
    function withdrawing(token: number, forget: () => void) {
      fresh.push(() => { forget(); native.withdrawShared(token); });
      return token;
    }
    function publishedMemory(state: MemoryState) {
      if (state.kind !== 'shared') throw cloneError('Only shared WebAssembly memories can be sent to a worker');
      if (state.token !== undefined) return state.token;
      let token: number;
      try { token = native.publishSharedMemory(state.resource); }
      catch (error) { throw cloneError(error); }
      state.token = token;
      localMemories.set(token, state.resource);
      return withdrawing(token, () => { state.token = undefined; localMemories.delete(token); });
    }
    function publishedModule(info: BunWasm.WasmModule) {
      if (info.backend !== 'nested') throw cloneError('Only WebAssembly modules with a shared memory can be sent to a worker');
      const known = moduleTokens.get(info);
      if (known !== undefined) return known;
      let token: number;
      try { token = native.publishSharedModule(info.id); }
      catch (error) { throw cloneError(error); }
      moduleTokens.set(info, token);
      localModules.set(token, info);
      return withdrawing(token, () => { moduleTokens.delete(info); localModules.delete(token); });
    }
    function reference(buffer: SharedArrayBuffer): BunWasm.SharedReference {
      const state = memoryBufferStates.get(buffer);
      if (!state) throw cloneError('Only WebAssembly shared memory buffers can be sent to a worker on this host');
      return { id: `buf/${publishedMemory(state)}`, byteLength: sharedLength!.call(buffer) };
    }
    function referenceWasm(value: WebAssembly.Module | WebAssembly.Memory): BunWasm.SharedReference {
      if (value instanceof Module) return { id: `mod/${publishedModule(description(value))}`, byteLength: 0 };
      if (value instanceof Memory) return { id: `mem/${publishedMemory(memoryState(value))}`, byteLength: 0 };
      throw cloneError('Expected a WebAssembly Module or Memory');
    }
    function abort() {
      for (const undo of fresh.splice(0)) {
        // An abort must not mask the clone error that caused it.
        try { undo(); } catch { /* the member is stopping */ }
      }
    }
    return { reference, referenceWasm, publish() { fresh.length = 0; }, abort };
  }
  internal.groupSharedObjects = {
    begin: beginPublication,
    read: reference => memoryPrefix(attachedMemory(directoryToken(reference.id, 'buf')), reference.byteLength),
    readWasm(reference) {
      if (reference.id.startsWith('mod/')) return attachedModule(directoryToken(reference.id, 'mod'));
      return memoryObject(attachedMemory(directoryToken(reference.id, 'mem')).resource);
    },
    // The directory is synchronous: a published reference is readable at once.
    wait: () => null,
  };
  async function compile(source: unknown) { return new Module(source); }
  async function instantiate(source: unknown, imports?: Imports) {
    if (source instanceof Module) return new Instance(source, imports);
    const module = new Module(source);
    return { module, instance: new Instance(module, imports) };
  }
  function validate(source: unknown) { return native.validate(byteView(source)); }
  return { Module, Instance, Memory, Table, Global, CompileError, LinkError, RuntimeError, compile, instantiate, validate,
    compileStreaming: async (response: Response | PromiseLike<Response>) => compile(await (await response).arrayBuffer()),
    instantiateStreaming: async (response: Response | PromiseLike<Response>, imports?: Imports) => instantiate(await (await response).arrayBuffer(), imports),
  };
})
