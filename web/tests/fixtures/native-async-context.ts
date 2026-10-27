import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { nextMetadataSources } from "./next-metadata-source.ts";
import { createNodeAsyncContext } from "../../scripts/async-context.ts";

const native = process.argv[2] === "native";
const context = createContext({
  TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask,
  createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [], assert,
  continuation: native ? createNodeAsyncContext() : undefined,
});
const hostSource = readFileSync(new URL("../../src/engine-host.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "")
  .replace("export function startEngineHost", "function startEngineHost");
const bootstrap = readFileSync(new URL("../../../crates/bunwasm-runtime/src/js/bootstrap.js", import.meta.url), "utf8");
const start = bootstrap.indexOf("  function runInContext(context, fn, thisArg, args) {");
const end = bootstrap.indexOf("  internal.runInContext = runInContext;", start);
assert(start >= 0 && end > start);
runInContext(`${hostSource}
  const host = Object.assign(Object.create(EngineHost.prototype), {
    o: { asyncContext: continuation }, internal: {}, promiseStates: new WeakMap(), tickQueued: false,
    asyncContext: undefined,
  });
  const native = host.valueNatives();
  host.native = native;
  const internal = { native, builtinFactories: {}, require: () => ({}) };
  ${bootstrap.slice(start, end)}
  internal.runInContext = runInContext;
`, context);
runInContext(readFileSync(new URL("../../../crates/bunwasm-runtime/src/js/builtins.js", import.meta.url), "utf8") + "(internal);", context);
runInContext(`
  const storage = new (internal.builtinFactories['node:async_hooks']().AsyncLocalStorage)();
  host.installGlobals();
  host.wrapPromiseJobs();
`, context);

const hashes = {
  resolveMetadataItemsImpl: "88c4906f565522456ef120151a66f2a97dd40b1e3c51ac8b0382f9a25bfe34c8",
  collectMetadata: "6ed25c6323c9116128f800fa00e62bbe6424bfabe928d8242f41f971654e0c1e",
  getLayoutOrPageModule: "666350fcb3ea0a4e92c8e50634960b6bb1023538ddff0bfab6730130b1256e7f",
  createServerParamsForServerSegment: "b321ef39804c1c1844715a41e98e69536af4bfe9df030f3adf63cd5fea29713d",
};
for (const [key, source] of Object.entries(nextMetadataSources)) {
  assert.equal(createHash("sha256").update(source).digest("hex"), Reflect.get(hashes, key));
}
runInContext(`
  const observations = [];
  const _segment = { PAGE_SEGMENT_KEY: '__PAGE__', DEFAULT_SEGMENT_KEY: '__DEFAULT__' };
  const _workunitasyncstorageexternal = { workUnitAsyncStorage: storage, throwInvariantForMissingStore() {
    throw Object.assign(new Error('Invariant: Expected workUnitAsyncStorage to have a store. This is a bug in Next.js.'), { name: 'InvariantError', __NEXT_ERROR_CODE: 'E696' });
  } };
  const createRenderParamsInDev = value => Promise.resolve(value);
  const resolveStaticMetadata = () => Promise.resolve(null);
  const getDefinedMetadata = mod => mod.metadata;
  ${Object.values(nextMetadataSources).join("\n")}
  const _appdirmodule = { getLayoutOrPageModule };
  const _params = { createServerParamsForMetadata: createServerParamsForServerSegment };
  assert.equal(_workunitasyncstorageexternal.workUnitAsyncStorage, storage);
  assert.equal(_params.createServerParamsForMetadata, createServerParamsForServerSegment);
  globalThis.liveMetadataSources = Object.fromEntries(Object.entries({
    resolveMetadataItemsImpl, collectMetadata, getLayoutOrPageModule, createServerParamsForServerSegment,
  }).map(([key, fn]) => [key, Function.prototype.toString.call(fn)]));
  function tuple(kind) {
    return [() => {
      observations.push([kind + '.loader', storage.getStore()?.id]);
      return Promise.resolve({ metadata: { title: kind + '-title' } });
    }, { toString() { return kind; } }];
  }
  function tree(withPage) {
    const layout = tuple('layout');
    Object.defineProperty(layout, 1, { get() { observations.push(['layout.path', storage.getStore()?.id]); return '/layout.tsx'; } });
    return ['', withPage ? { children: ['__PAGE__', {}, { page: tuple('page') }] } : {}, { layout }];
  }
  function metadata(withPage) {
    return storage.run({ type: 'request', id: 'request' }, resolveMetadataItemsImpl,
      [], tree(withPage), [], {}, Promise.resolve({}), undefined, [], () => null, { route: '/' });
  }
  globalThis.exercise = async () => {
    const layout = await metadata(false);
    assert.equal(layout.length, 1);
    assert.equal(storage.getStore(), undefined);
    try {
      const items = await metadata(true);
      assert.equal(${native}, true);
      assert.deepEqual(Array.from(items, item => item[0].title), ['layout-title', 'page-title']);
    } catch (error) {
      if (${native}) throw error;
      assert.equal(error.__NEXT_ERROR_CODE, 'E696');
      assert.match(error.stack, /createServerParamsForServerSegment/);
    }
    assert.equal(storage.getStore(), undefined);
    assert.equal(observations.some(([site]) => site === 'page.loader'), ${native});
    for (const [site, store] of observations) assert.equal(store, ${native} || site.endsWith('.loader') ? 'request' : undefined, site);
    return observations;
  };
`, context);
const liveSources: unknown = runInContext("liveMetadataSources", context);
assert(typeof liveSources === "object" && liveSources !== null);
for (const [key, source] of Object.entries(nextMetadataSources)) assert.equal(Reflect.get(liveSources, key), source);
const observations: unknown = await runInContext("exercise()", context);
if (native) await runInContext(`(async () => {
  const value = {}, reason = {};
  const raw = new (Object.getPrototypeOf(async function() {}).constructor)('storage', 'expected',
    'await 0; assert.equal(storage.getStore(), expected); return expected;');
  const first = storage.run('one', () => raw(storage, 'one'));
  const second = storage.run('two', () => raw(storage, 'two'));
  assert.equal(storage.getStore(), undefined);
  assert.deepEqual(Array.from(await Promise.all([first, second])), ['one', 'two']);
  assert.equal(storage.getStore(), undefined);

  await storage.run('getter', async () => {
    const promise = Promise.resolve(value);
    let reads = 0;
    Object.defineProperty(promise, 'then', { get() { throw Error('native await read then'); } });
    Object.defineProperty(promise, 'constructor', { get() {
      reads++; storage.enterWith('changed'); return Promise;
    } });
    assert.equal(__bunwasm_resume(__bunwasm_capture(), await promise), value);
    assert.equal(reads, 1);
    assert.equal(storage.getStore(), 'changed');
  });
  assert.equal(storage.getStore(), undefined);

  const reaction = storage.run('reaction', () => {
    const promise = Promise.resolve(value);
    Object.defineProperty(promise, 'constructor', { get() {
      storage.enterWith('species');
      return Promise;
    } });
    return promise.then(result => {
      assert.equal(storage.getStore(), 'species');
      storage.enterWith('callback');
      return result;
    });
  });
  assert.equal(storage.getStore(), undefined);
  assert.equal(await reaction, value);
  assert.equal(storage.getStore(), undefined);

  await storage.run('thenable', async () => {
    const thenable = { get then() {
      storage.enterWith('thenable.getter');
      return function(resolve) {
        assert.equal(this, thenable);
        assert.equal(storage.getStore(), 'thenable.getter');
        storage.enterWith('thenable.job');
        resolve(value);
      };
    } };
    assert.equal(await thenable, value);
    assert.equal(storage.getStore(), 'thenable.getter');
  });
  assert.equal(storage.getStore(), undefined);

  for (const failure of [undefined, null, false, 0, -0, NaN, '', 0n, reason]) {
    await storage.run('reject', async () => {
      try { await Promise.reject(failure); assert.fail('did not reject'); }
      catch (caught) { assert(Object.is(caught, failure)); assert.equal(storage.getStore(), 'reject'); }
      finally { assert.equal(storage.getStore(), 'reject'); }
    });
    assert.equal(storage.getStore(), undefined);
  }

  const closure = 42;
  const direct = eval('(async () => { await 0; return [closure, storage.getStore()]; })');
  assert.deepEqual(Array.from(await storage.run('eval', direct)), [42, 'eval']);
  const input = '(async () => { await 0; })()';
  let reads = 0;
  const receiver = {};
  Object.defineProperty(receiver, 'eval', { get() {
    reads++;
    return function(source) { assert.equal(this, receiver); assert.equal(source, input); return value; };
  } });
  const custom = new Function('receiver', 'source', 'with (receiver) { return eval(source); }');
  assert.equal(custom(receiver, input), value);
  assert.equal(reads, 1);
  const parameter = new Function('eval', 'source', 'return eval(source);');
  assert.equal(parameter(source => { assert.equal(source, input); return value; }, input), value);
  assert.equal(storage.getStore(), undefined);
})()`, context);
console.log(JSON.stringify({ native, observations, status: "pass" }));
