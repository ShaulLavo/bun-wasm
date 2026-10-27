declare function fixture(name: string): WebAssembly.Module;
declare function check(condition: unknown, message: string): void;
declare const sourceMemory: boolean;
const correctionFailures: unknown[] = [];
function correctionEqual(actual: unknown, expected: unknown, label: string) { check(Object.is(actual, expected), label); }
function correctionProbe(label: string, action: () => void) {
  try { action(); console.log('PASS correction', label); }
  catch (error) { correctionFailures.push(error); console.log('FAIL correction', label, error); }
}
function correctionThrows(action: () => unknown, name: string) {
  try { action(); }
  catch (error) {
    check(error && typeof error === 'object' && 'name' in error && error.name === name, 'expected ' + name);
    return;
  }
  throw new Error('expected ' + name);
}
function correctionCallable(value: unknown): (...args: unknown[]) => unknown {
  if (typeof value !== 'function') throw new Error('Expected callable');
  return (...args) => value(...args);
}
function correctionMemory(instance: WebAssembly.Instance) {
  const value = instance.exports.memory;
  if (!(value instanceof WebAssembly.Memory)) throw new Error('Expected memory');
  return value;
}
async function correctionCollect() {
  for (let i = 0; i < 12; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    const collect = globalThis.gc;
    if (!collect) throw new Error('GC must be enabled');
    collect();
  }
}
correctionProbe('immutable Instance.exports assignment and deletion', () => {
  const instance = new WebAssembly.Instance(fixture('numeric'));
  const exports = instance.exports;
  const descriptor = Object.getOwnPropertyDescriptor(instance, 'exports');
  if (sourceMemory) check(descriptor, 'source own exports descriptor');
  if (descriptor) {
    correctionEqual(descriptor.writable, false, 'exports writable=false');
    correctionEqual(descriptor.configurable, false, 'exports configurable=false');
    correctionEqual(descriptor.enumerable, true, 'exports enumerable=true');
  }
  correctionEqual(Reflect.set(instance, 'exports', {}), false, 'exports replacement rejects');
  const deleted = Reflect.deleteProperty(instance, 'exports');
  if (sourceMemory) correctionEqual(deleted, false, 'own exports deletion rejects');
  correctionEqual(instance.exports, exports, 'exports survives attempted replacement/deletion');
  check(Object.isFrozen(exports), 'exports object remains frozen');
});
correctionProbe('anyfunc omitted set defaults to null', () => {
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1, maximum: 3 });
  const fn = new WebAssembly.Instance(fixture('numeric')).exports.integer;
  table.set(0, fn);
  Reflect.apply(table.set, table, [0]);
  correctionEqual(table.get(0), null, 'omitted set clears function');
});
correctionProbe('anyfunc explicit undefined set/grow rejects without mutation', () => {
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: 1, maximum: 3 });
  const fn = new WebAssembly.Instance(fixture('numeric')).exports.integer;
  table.set(0, fn);
  correctionThrows(() => table.set(0, undefined), 'TypeError');
  correctionEqual(table.get(0), fn, 'failed set preserves callable');
  correctionThrows(() => table.grow(1, undefined), 'TypeError');
  correctionEqual(table.length, 1, 'failed grow preserves length');
  correctionThrows(() => table.grow(0, undefined), 'TypeError');
  correctionEqual(table.grow(1), 1, 'omitted grow previous length');
  correctionEqual(table.get(1), null, 'omitted grow inserts null');
  correctionThrows(() => table.grow(1, () => 1), 'TypeError');
  correctionEqual(table.length, 2, 'invalid callable grow preserves length');
  correctionThrows(() => table.grow(-1), 'TypeError');
  correctionThrows(() => Reflect.apply(table.set, table, []), 'TypeError');
  correctionThrows(() => table.grow(2), 'RangeError');
  correctionEqual(table.length, 2, 'failed maximum growth preserves length');
});
correctionProbe('externref omitted and explicit undefined remain distinct from null', () => {
  const table = new WebAssembly.Table({ element: 'externref', initial: 1, maximum: 4 });
  Reflect.apply(table.set, table, [0]);
  correctionEqual(table.get(0), undefined, 'omitted externref set');
  table.set(0, null);
  table.set(0, undefined);
  correctionEqual(table.get(0), undefined, 'explicit externref set');
  correctionEqual(table.grow(1), 1, 'omitted externref growth');
  correctionEqual(table.get(1), undefined, 'omitted externref growth value');
  correctionEqual(table.grow(1, undefined), 2, 'explicit undefined externref growth');
  correctionEqual(table.get(2), undefined, 'explicit undefined externref growth value');
  correctionEqual(table.grow(1, null), 3, 'null externref growth');
  correctionEqual(table.get(3), null, 'null remains null');
});
correctionProbe('Table element descriptor converts to string once', () => {
  const reads: string[] = [];
  const element = { toString() { reads.push('string'); return 'anyfunc'; } };
  const table = Reflect.construct(WebAssembly.Table, [{
    get element() { reads.push('element'); return element; },
    get initial() { reads.push('initial'); return 1; },
  }]);
  correctionEqual(table.get(0), null, 'string-converted anyfunc');
  correctionEqual(reads.join(','), 'element,string,initial', 'element conversion order/count');
  correctionThrows(() => Reflect.construct(WebAssembly.Table, [{ element: Symbol('anyfunc'), initial: 1 }]), 'TypeError');
});
correctionProbe('Memory.shared getter read once in descriptor order', () => {
  const reads: string[] = [];
  const memory = new WebAssembly.Memory({
    get initial() { reads.push('initial'); return 0; },
    get maximum() { reads.push('maximum'); return 1; },
    get shared() {
      reads.push('shared');
      if (reads.filter(value => value === 'shared').length > 1) throw new Error('shared getter read twice');
      return false;
    },
  });
  correctionEqual(memory.buffer.byteLength, 0, 'valid shared=false descriptor allocates');
  correctionEqual(reads.join(','), 'initial,maximum,shared', 'descriptor getter order/count');
  let sharedReads = 0;
  correctionThrows(() => new WebAssembly.Memory({ initial: 2, maximum: 1, get shared() { sharedReads++; return false; } }), 'RangeError');
  correctionEqual(sharedReads, 0, 'invalid limits do not read shared');
});
async function correctionRetainedBuffer() {
  const retained = (() => {
    const instance = new WebAssembly.Instance(fixture('memory-lifetime'));
    const memory = correctionMemory(instance);
    return { weak: new WeakRef(memory), view: new Uint8Array(memory.buffer),
      read: correctionCallable(instance.exports.read), write: correctionCallable(instance.exports.write), grow: correctionCallable(instance.exports.grow) };
  })();
  await correctionCollect();
  correctionProbe('retained buffer permits source Memory wrapper GC', () => {
    if (sourceMemory) correctionEqual(retained.weak.deref(), undefined, 'source wrapper collected');
  });
  correctionProbe('retained buffer flush after wrapper GC', () => { retained.view[0] = 44; correctionEqual(retained.read(), 44, 'retained buffer flush'); });
  correctionProbe('retained buffer refresh after wrapper GC', () => { retained.write(55); correctionEqual(retained.view[0], 55, 'retained buffer refresh'); });
  correctionProbe('retained buffer grow detaches after wrapper GC', () => {
    correctionEqual(retained.grow(1), 1, 'retained callable grows real memory');
    correctionEqual(retained.view.buffer.byteLength, 0, 'retained old buffer detaches');
  });
}
async function correctionMemoryOwners() {
  const wrapper = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  const buffer = new WeakRef(wrapper.buffer);
  await correctionCollect();
  correctionProbe('wrapper-only retention keeps live buffer', () => {
    correctionEqual(buffer.deref(), wrapper.buffer, 'wrapper retains buffer');
    new Uint8Array(wrapper.buffer)[0] = 71;
  });
  const first = new WebAssembly.Instance(fixture('memory-reexport'), { env: { memory: wrapper } });
  const second = new WebAssembly.Instance(fixture('memory-reexport'), { env: { memory: correctionMemory(first) } });
  correctionProbe('re-export shares live buffer and cross-instance growth', () => {
    correctionEqual(first.exports.alias, wrapper, 'memory export alias');
    correctionEqual(correctionMemory(second), wrapper, 're-export wrapper identity');
    correctionEqual(correctionCallable(second.exports.read)(), 71, 're-export sees JS bytes');
    const old = wrapper.buffer;
    correctionEqual(correctionCallable(second.exports.grow)(1), 1, 'cross-instance growth');
    correctionEqual(old.byteLength, 0, 're-export old buffer detaches');
    correctionEqual(correctionMemory(first).buffer, correctionMemory(second).buffer, 're-export new live view');
    const view = new Uint8Array(correctionMemory(first).buffer);
    view[0] = 73;
    correctionEqual(correctionCallable(second.exports.read)(), 73, 'new live view flush');
    correctionCallable(second.exports.write)(79);
    correctionEqual(view[0], 79, 'new live view refresh');
  });
  const dead = (() => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    return { wrapper: new WeakRef(memory), buffer: new WeakRef(memory.buffer) };
  })();
  const stale = (() => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
    const first = memory.buffer;
    memory.grow(0);
    const second = memory.buffer;
    memory.grow(1);
    return { old: [first, second], wrapper: new WeakRef(memory), current: new WeakRef(memory.buffer) };
  })();
  await correctionCollect();
  correctionProbe('both dead source wrapper and buffer collect', () => {
    if (!sourceMemory) return;
    correctionEqual(dead.wrapper.deref(), undefined, 'dead wrapper collected');
    correctionEqual(dead.buffer.deref(), undefined, 'dead buffer collected');
  });
  correctionProbe('repeated grow removes detached buffer anchors', () => {
    for (const old of stale.old) correctionEqual(old.byteLength, 0, 'old buffer remains detached');
    if (!sourceMemory) return;
    correctionEqual(stale.wrapper.deref(), undefined, 'grown wrapper collected');
    correctionEqual(stale.current.deref(), undefined, 'retained detached buffers do not retain current buffer/state');
  });
}
async function correctionCrossInstanceGc() {
  const retained = (() => {
    const owner = new WebAssembly.Instance(fixture('memory-owner'), { env: { callback: (value: number) => value } });
    const memory = correctionMemory(owner);
    const table = owner.exports.table;
    if (!(table instanceof WebAssembly.Table)) throw new Error('Expected table');
    table.set(1, owner.exports.grow);
    const consumer = new WebAssembly.Instance(fixture('import-table'), { env: { table, callback: () => -1 } });
    return { weak: new WeakRef(memory), view: new Uint8Array(memory.buffer), read: correctionCallable(owner.exports.read), call: correctionCallable(consumer.exports.call) };
  })();
  await correctionCollect();
  correctionProbe('cross-instance retained buffer survives Memory wrapper GC', () => {
    if (sourceMemory) correctionEqual(retained.weak.deref(), undefined, 'cross-instance source wrapper collected');
    retained.view[0] = 81;
    correctionEqual(retained.read(), 81, 'cross-instance retained buffer flush');
    correctionEqual(retained.call(83, 0), 83, 'cross-instance table write');
    correctionEqual(retained.view[0], 83, 'cross-instance retained buffer refresh');
    correctionEqual(retained.call(1, 1), 1, 'cross-instance table growth');
    correctionEqual(retained.view.buffer.byteLength, 0, 'cross-instance retained buffer detaches');
  });
}
async function corrections() {
  await correctionRetainedBuffer();
  await correctionMemoryOwners();
  await correctionCrossInstanceGc();
  if (correctionFailures.length) throw new AggregateError(correctionFailures, 'WebAssembly correction regressions');
  console.log('PASS all review corrections', sourceMemory ? 'real source/native' : 'host oracle');
}
corrections();
