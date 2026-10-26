(function (internal) {
  'use strict';
  const native = internal.native.wasm;
  const modules = new WeakMap();
  const instances = new WeakMap();
  const memories = new Map();
  const memoryCleanup = new FinalizationRegistry(({ resource, reference }) => {
    if (memories.get(resource) === reference) memories.delete(resource);
  });
  const memoryBuffers = new WeakSet();
  internal.isWasmMemoryBuffer = value => memoryBuffers.has(value);
  class CompileError extends Error { constructor(message) { super(message); this.name = 'CompileError'; } }
  class LinkError extends Error { constructor(message) { super(message); this.name = 'LinkError'; } }
  class RuntimeError extends Error { constructor(message) { super(message); this.name = 'RuntimeError'; } }
  function byteView(source) {
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
    if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    throw new TypeError('Expected a WebAssembly BufferSource');
  }
  class Module {
    constructor(source) {
      const input = byteView(source);
      try { modules.set(this, native.compile(input)); }
      catch (error) { throw new CompileError(error.message); }
    }
    static imports(module) { return modules.get(module).imports.map(({ module, name, kind }) => ({ module, name, kind })); }
    static exports(module) { return modules.get(module).exports.map(({ name, kind }) => ({ name, kind })); }
  }
  class Memory {
    constructor(descriptor) {
      if (!descriptor || (typeof descriptor !== 'object' && typeof descriptor !== 'function')) throw new TypeError('WebAssembly.Memory descriptor must be an object');
      const initial = pages(descriptor.initial);
      if (initial > 65536) throw new RangeError('WebAssembly.Memory exceeds the 32-bit page limit');
      const limit = descriptor.maximum;
      const maximum = limit === undefined ? undefined : pages(limit);
      if (maximum > 65536) throw new RangeError('WebAssembly.Memory exceeds the 32-bit page limit');
      if (maximum !== undefined && maximum < initial) throw new RangeError('WebAssembly.Memory maximum is smaller than initial');
      const shared = !!descriptor.shared;
      if (shared && maximum === undefined) throw new TypeError('Shared WebAssembly memories require a maximum');
      if (shared) throw new LinkError('Shared WebAssembly memories are not supported');
      let resource;
      try { resource = native.createMemory(initial, maximum); }
      catch (error) { throw new RangeError(error.message); }
      const memory = { kind: 'memory', resource, buffer: new ArrayBuffer(0), generation: undefined };
      instances.set(this, memory);
      rememberMemory(resource, this);
      refreshMemory(memory);
    }
    get buffer() {
      const state = memoryState(this);
      if (!state) throw new TypeError('Expected a WebAssembly.Memory');
      return state.buffer;
    }
    grow(delta) {
      const state = memoryState(this);
      if (!state) throw new TypeError('Expected a WebAssembly.Memory');
      const count = pages(delta);
      flushMemory(state);
      let old;
      try { old = native.growMemory(state.resource, count); }
      catch (error) { throw new RangeError(error.message); }
      refreshMemory(state);
      return old;
    }
  }
  class Global {
    constructor() { throw new LinkError('Standalone WebAssembly globals are not supported'); }
    get value() { const state = instances.get(this); return native.global(state.id, state.name); }
    set value(value) {
      const state = instances.get(this);
      if (!state.mutable) throw new TypeError('Immutable WebAssembly global');
      native.global(state.id, state.name, coerce(value, state.type));
    }
    valueOf() { return this.value; }
  }
  function flushMemory(memory) {
    native.writeMemory(memory.resource, byteView(memory.buffer));
  }
  function flush(state) {
    for (const memory of state.memories) flushMemory(memory);
  }
  function rememberMemory(resource, memory) {
    const reference = new WeakRef(memory);
    memories.set(resource, reference);
    memoryCleanup.register(memory, { resource, reference });
  }
  function refresh(state) {
    for (const memory of state.memories) refreshMemory(memory);
  }
  function refreshMemory(memory) {
    const { bytes: data, generation } = native.readMemory(memory.resource);
    if (memory.generation !== generation || memory.buffer.byteLength !== data.byteLength) {
      memory.buffer.transfer(0);
      memory.buffer = new ArrayBuffer(data.byteLength);
      memoryBuffers.add(memory.buffer);
      memory.generation = generation;
    }
    new Uint8Array(memory.buffer).set(data);
  }
  function pages(value) {
    const number = +value;
    if (!Number.isFinite(number) || number < 0 || Math.trunc(number) > 0xffffffff) throw new TypeError('Invalid WebAssembly page count');
    return Math.trunc(number);
  }
  function memoryState(value) {
    const state = instances.get(value);
    return state?.kind === 'memory' ? state : undefined;
  }
  function execute(action) {
    try { return action(); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      throw new RuntimeError(error.message);
    }
  }
  function coerce(value, type) {
    switch (type) {
      case 'i32': return value >> 0;
      case 'i64': return BigInt.asIntN(64, value);
      case 'f32': return Math.fround(+value);
      case 'f64': return +value;
      default: throw new TypeError('WebAssembly reference values are not supported');
    }
  }
  function invoke(state, item, args) {
    const inputs = item.params.map((type, index) => coerce(args[index], type));
    flush(state);
    let result;
    try { result = execute(() => native.call(state.id, item.name, inputs)); }
    finally { refresh(state); }
    while (result.import !== undefined) result = imported(state, result);
    const values = result.values;
    if (values.length === 1) return values[0];
    return values.length === 0 ? undefined : values;
  }
  function imported(state, result) {
    const entry = state.imports[result.import];
    let values;
    try {
      const value = entry.callback(...result.args);
      if (entry.results.length === 0) values = [];
      else if (entry.results.length === 1) values = [coerce(value, entry.results[0])];
      else {
        values = [...value];
        if (values.length !== entry.results.length) throw new TypeError('Invalid WebAssembly result count');
        values = values.map((value, index) => coerce(value, entry.results[index]));
      }
    } catch (error) { native.cancel(state.id, result.call); throw error; }
    flush(state);
    try { return execute(() => native.resume(state.id, result.call, values)); }
    finally { refresh(state); }
  }
  class Instance {
    constructor(module, imports = {}) {
      const description = modules.get(module);
      if (!description) throw new TypeError('Expected a WebAssembly.Module');
      const memoryRecords = [];
      const functions = [];
      const bindings = description.imports.map((item, index) => {
        const value = imports[item.module]?.[item.name];
        if (item.kind === 'function') {
          if (typeof value !== 'function') throw new LinkError(`Missing WebAssembly import ${item.module}.${item.name}`);
          functions[index] = { callback: value, results: item.results };
          return undefined;
        }
        if (item.kind === 'memory') {
          const state = memoryState(value);
          if (!state) throw new LinkError(`Missing WebAssembly import ${item.module}.${item.name}`);
          if (!memoryRecords.includes(state)) memoryRecords.push(state);
          return state.resource;
        }
        throw new LinkError(`Unsupported WebAssembly import ${item.module}.${item.name}`);
      });
      for (const memory of memoryRecords) flushMemory(memory);
      let id;
      try { id = native.instantiate(description.id, bindings); }
      catch (error) { throw new LinkError(error.message); }
      finally { for (const memory of memoryRecords) refreshMemory(memory); }
      const state = { id, imports: functions, memories: memoryRecords };
      const exports = Object.create(null);
      for (const item of description.exports) installExport(state, exports, item);
      refresh(state);
      Object.defineProperty(this, 'exports', { value: Object.freeze(exports), enumerable: true });
    }
  }
  function installExport(state, exports, item) {
    const name = item.name;
    if (item.kind === 'function') { exports[name] = (...args) => invoke(state, item, args); return; }
    if (item.kind === 'global') {
      const global = Object.create(Global.prototype);
      instances.set(global, { id: state.id, name, type: item.type, mutable: item.mutable });
      exports[name] = global;
      return;
    }
    if (item.kind !== 'memory') throw new LinkError(`Unsupported WebAssembly export ${item.kind}`);
    const resource = native.memoryIdentity(state.id, name);
    let memory = memories.get(resource)?.deref();
    if (!memory) {
      memory = Object.create(Memory.prototype);
      const record = { kind: 'memory', resource, buffer: new ArrayBuffer(0), generation: undefined };
      instances.set(memory, record);
      rememberMemory(resource, memory);
    }
    const record = instances.get(memory);
    if (!state.memories.includes(record)) state.memories.push(record);
    exports[name] = memory;
  }
  async function compile(source) { return new Module(source); }
  async function instantiate(source, imports) {
    if (source instanceof Module) return new Instance(source, imports);
    const module = new Module(source);
    return { module, instance: new Instance(module, imports) };
  }
  function validate(source) { return native.validate(byteView(source)); }
  return { Module, Instance, Memory, Global, CompileError, LinkError, RuntimeError, compile, instantiate, validate,
    compileStreaming: async response => compile(await (await response).arrayBuffer()),
    instantiateStreaming: async (response, imports) => instantiate(await (await response).arrayBuffer(), imports),
  };
})
