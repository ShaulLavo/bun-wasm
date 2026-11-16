type GlobalAPI = typeof WebAssembly;
type Check = (condition: unknown, label: string) => void;
type Fixture = (name: string) => WebAssembly.Module;
function same(check: Check, actual: unknown, expected: unknown, label: string) { check(Object.is(actual, expected), label); }
function rejects(check: Check, action: () => unknown, name: string) {
  try { action(); }
  catch (error) { check(error !== null && typeof error === 'object' && 'name' in error && error.name === name, `Expected ${name}, got ${String(error)}`); return; }
  throw new Error(`Expected ${name}`);
}
function global(api: GlobalAPI, instance: WebAssembly.Instance, name: string) {
  const value = instance.exports[name];
  if (!(value instanceof api.Global)) throw new Error(`Expected Global ${name}`);
  return value;
}
function call(instance: WebAssembly.Instance, name: string, ...args: (number | bigint)[]) {
  const value = instance.exports[name];
  if (typeof value !== 'function') throw new Error(`Expected function ${name}`);
  return value(...args);
}
function numericCase(api: GlobalAPI, check: Check, type: WebAssembly.ValueType, value: number | bigint) {
  for (const mutable of [false, true]) {
    const item = new api.Global({ value: type, mutable }, value);
    same(check, item.value, value, `${type} initial`);
    same(check, item.valueOf(), value, `${type} valueOf`);
    const zero = type === 'i64' ? 0n : 0;
    same(check, new api.Global({ value: type }).value, zero, `${type} omitted default`);
    same(check, new api.Global({ value: type }, undefined).value, zero, `${type} undefined default`);
    if (mutable) {
      item.value = zero;
      same(check, item.value, zero, `${type} set`);
      continue;
    }
    rejects(check, () => { item.value = zero; }, 'TypeError');
  }
}
function numericControls(api: GlobalAPI, fixture: Fixture, check: Check) {
  const cases = [['i32', 42], ['i64', 42n], ['f32', Math.fround(1.1)], ['f64', 1.1]] satisfies [WebAssembly.ValueType, number | bigint][];
  for (const [type, value] of cases) {
    numericCase(api, check, type, value);
    const g = new api.Global({ value: type, mutable: true }, value);
    const module = fixture(`numeric-${type}`);
    const first = new api.Instance(module, { e: { g } });
    const second = new api.Instance(module, { e: { g } });
    same(check, first.exports.g, g, `${type} mutable import identity`);
    same(check, second.exports.g, g, `${type} second mutable import identity`);
    const zero = type === 'i64' ? 0n : 0;
    call(first, 'set', zero);
    same(check, g.value, zero, `${type} Wasm writes reach JS`);
    g.value = value;
    same(check, call(second, 'get'), value, `${type} JS writes reach Wasm`);
  }
  same(check, new api.Global({ value: 'i32' }, 4294967297).value, 1, 'i32 wrap');
  same(check, new api.Global({ value: 'i32' }, Infinity).value, 0, 'i32 infinity');
  same(check, new api.Global({ value: 'i64' }, (1n << 64n) + 3n).value, 3n, 'i64 wrap');
  same(check, Reflect.construct(api.Global, [{ value: 'i64' }, true]).value, 1n, 'i64 boolean');
  same(check, Reflect.construct(api.Global, [{ value: 'i64' }, '12']).value, 12n, 'i64 string');
  for (const value of [0, 2, undefined, null, Symbol('i64')]) {
    if (value !== undefined) rejects(check, () => Reflect.construct(api.Global, [{ value: 'i64' }, value]), 'TypeError');
  }
  rejects(check, () => new api.Global({ value: 'i32' }, 1n), 'TypeError');
  for (const type of ['f32', 'f64'] satisfies WebAssembly.ValueType[]) {
    for (const value of [-0, NaN, Infinity, -Infinity]) same(check, new api.Global({ value: type }, value).value, value, `${type} special`);
  }
}
function coercionControls(api: GlobalAPI, check: Check) {
  const order: string[] = [];
  const descriptor = {
    get mutable() { order.push('mutable'); return true; },
    get value() { order.push('value'); return { [Symbol.toPrimitive](hint: string) { order.push(`type:${hint}`); return 'i32'; } }; },
  };
  const initial = { [Symbol.toPrimitive](hint: string) { order.push(`initial:${hint}`); return 9; } };
  const item = Reflect.construct(api.Global, [descriptor, initial]);
  same(check, order.join(','), 'mutable,value,type:string,initial:number', 'descriptor and conversion order');
  same(check, item.value, 9, 'converted initial');
  for (const descriptor of [undefined, null, 0, 'i32']) rejects(check, () => Reflect.construct(api.Global, [descriptor]), 'TypeError');
  let converted = false;
  const immutable = new api.Global({ value: 'i32' });
  const value = { valueOf() { converted = true; return 1; } };
  rejects(check, () => Reflect.set(immutable, 'value', value), 'TypeError');
  same(check, converted, false, 'immutable setter rejects before conversion');
  const bad = { valueOf() { throw new RangeError('initial sentinel'); } };
  rejects(check, () => Reflect.construct(api.Global, [{ value: 'i32' }, bad]), 'RangeError');
  const rejected = { mutable: false, value: 'invalid' };
  rejects(check, () => Reflect.construct(api.Global, [rejected, value]), 'TypeError');
  same(check, converted, false, 'invalid type rejects before initial conversion');
}
function brandControls(api: GlobalAPI, check: Check) {
  const descriptor = Object.getOwnPropertyDescriptor(api.Global.prototype, 'value');
  if (!descriptor?.get || !descriptor.set) throw new Error('Global accessors');
  const getter = descriptor.get;
  const setter = descriptor.set;
  const valueOf = api.Global.prototype.valueOf;
  same(check, descriptor.enumerable, true, 'Global value is enumerable');
  same(check, api.Global.length, 1, 'Global constructor arity');
  same(check, Object.prototype.toString.call(new api.Global({ value: 'i32' })), '[object WebAssembly.Global]', 'Global toStringTag');
  const item = new api.Global({ value: 'i32', mutable: true }, 5);
  for (const receiver of [{}, Object.create(api.Global.prototype), new Proxy(item, {}), null, 5]) {
    rejects(check, () => getter.call(receiver), 'TypeError');
    rejects(check, () => setter.call(receiver, 1), 'TypeError');
    rejects(check, () => valueOf.call(receiver), 'TypeError');
  }
  Object.setPrototypeOf(item, null);
  same(check, getter.call(item), 5, 'changed prototype retains brand');
  setter.call(item, 8);
  same(check, valueOf.call(item), 8, 'borrowed methods use private brand');
}
function aliasControls(api: GlobalAPI, fixture: Fixture, check: Check) {
  const source = new api.Instance(fixture('provider'));
  const g = global(api, source, 'g');
  same(check, g, source.exports.alias, 'duplicate defined export');
  check(g !== source.exports.equal, 'distinct equal-valued global declarations');
  const other = new api.Instance(fixture('provider'));
  check(g !== other.exports.g, 'distinct instances');
  const memory = new api.Memory({ initial: 1 });
  const env = { g, memory, callback() {} };
  const first = new api.Instance(fixture('consumer'), { e: env });
  const second = new api.Instance(fixture('consumer'), { e: env });
  const third = new api.Instance(fixture('consumer'), { e: { ...env, g: first.exports.alias } });
  for (const instance of [first, second, third]) {
    same(check, instance.exports.g, g, 'import originating handle');
    same(check, instance.exports.alias, g, 'global ordinal with interleaved imports');
    check(instance.exports.defined !== g, 'defined after imported globals');
  }
  call(first, 'set', 11);
  same(check, g.value, 11, 'Wasm to JS');
  same(check, call(second, 'get'), 11, 'Wasm to second consumer');
  g.value = 17;
  same(check, call(third, 'get'), 17, 'JS to transitive consumer');
  same(check, call(source, 'get'), 17, 'JS to original source');
  const fresh = new api.Global({ value: 'i32', mutable: true }, 3);
  const one = new api.Instance(fixture('consumer'), { e: { ...env, g: fresh } });
  const two = new api.Instance(fixture('consumer'), { e: { ...env, g: fresh } });
  call(one, 'set', 19);
  same(check, fresh.value, 19, 'constructor backing sees Wasm write');
  fresh.value = 20;
  same(check, call(two, 'get'), 20, 'constructor backing sees JS write');
  const reentrant = new api.Instance(fixture('consumer'), { e: { g: fresh, memory, callback() {
    same(check, fresh.value, 29, 'callback observes Wasm write');
    fresh.value = 30;
    same(check, call(two, 'get'), 30, 'callback reenters another consumer');
    call(one, 'set', 32);
  } } });
  same(check, call(reentrant, 'reenter', 29), 32, 'resumed Wasm observes reentrant write');
  Object.setPrototypeOf(fresh, null);
  const changed = new api.Instance(fixture('consumer'), { e: { ...env, g: fresh } });
  same(check, changed.exports.g, fresh, 'changed-prototype import retains brand');
  for (const input of [3, {}, new Proxy(g, {}), new api.Global({ value: 'i64', mutable: true }), new api.Global({ value: 'i32' })]) {
    rejects(check, () => new api.Instance(fixture('consumer'), { e: { ...env, g: input } }), 'LinkError');
  }
}
function startControls(api: GlobalAPI, fixture: Fixture, check: Check) {
  const item = new api.Global({ value: 'i32', mutable: true }, 0);
  const start = new api.Instance(fixture('start'), { e: { g: item } });
  same(check, start.exports.g, item, 'start export identity');
  same(check, item.value, 23, 'start writes');
  let trapped = false;
  try { new api.Instance(fixture('trap'), { e: { g: item } }); }
  catch { trapped = true; }
  check(trapped, 'start trap must throw');
  same(check, item.value, 31, 'writes before start trap persist');
  const immutable = new api.Global({ value: 'i32' }, 7);
  const imported = new api.Instance(fixture('immutable'), { e: { g: immutable } });
  same(check, imported.exports.g, immutable, 'immutable constructor alias');
  const memory = new api.Memory({ initial: 1 });
  const scalar = new api.Instance(fixture('scalars'), { e: { callback() {}, memory, a: 7, b: 7 } });
  same(check, scalar.exports.a, scalar.exports.alias, 'scalar duplicate export identity');
  check(scalar.exports.a !== scalar.exports.b, 'equal scalars retain distinct import declarations');
  check(scalar.exports.a !== scalar.exports.defined, 'initializer from import defines distinct storage');
}
export function runGlobalControls(api: GlobalAPI, fixture: Fixture, check: Check) {
  numericControls(api, fixture, check);
  coercionControls(api, check);
  brandControls(api, check);
  aliasControls(api, fixture, check);
  startControls(api, fixture, check);
  console.log('PASS numeric Global constructors, conversions, brands, live aliases, imports and start effects');
}
