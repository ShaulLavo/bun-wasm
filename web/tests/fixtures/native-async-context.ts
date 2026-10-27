import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { createScriptEvaluation } from "../../src/script-evaluation.ts";
import { isWasmMemoryBuffer, transferArrayBuffers } from "../../src/buffer-transfer.ts";
import { nextMetadataSources } from "./next-metadata-source.ts";

const native = process.argv[2] === "native";
const frames = new AsyncLocalStorage<unknown>();
const context = createContext({
  TextEncoder, TextDecoder, URL, Blob, setTimeout, clearTimeout, queueMicrotask,
  createScriptEvaluation, isWasmMemoryBuffer, transferArrayBuffers, SLOT_NAMES: [], assert,
  continuation: native ? { get: () => frames.getStore(), set: (value: unknown) => frames.enterWith(value) } : undefined,
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
for (const name of Object.keys(hashes)) {
  assert(name in nextMetadataSources);
  const key = name as keyof typeof nextMetadataSources;
  assert.equal(createHash("sha256").update(nextMetadataSources[key]).digest("hex"), hashes[key]);
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
const observations: unknown = await runInContext("exercise()", context);
console.log(JSON.stringify({ native, observations, status: "pass" }));
