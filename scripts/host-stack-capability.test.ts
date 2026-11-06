import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");
const bootstrap = read("bootstrap.js").split("  // --- async context")[0] + "return internal; })";
const transpiler = new Bun.Transpiler({ loader: "ts" });
function factory(name: string) {
  return transpiler.transformSync(`globalThis.factory = ${read(name)};`).replace("globalThis.factory =", "").trim().replace(/;$/, "");
}
const factories = { stack_trace: factory("stack_trace.ts"), stack_capability: factory("stack_capability.ts"), inspect: read("inspect.js") };
const initialize = `
const nativeError = Error;
const nativeCapture = Error.captureStackTrace;
const factories = Object.fromEntries(Object.entries(${JSON.stringify(factories)}).map(([name, source]) => [name, (0, eval)("(" + source + ")")]));
const runtime = (${bootstrap})({ engine: "host", loadPolyfill: name => factories[name], mapPosition: () => undefined, preparedSourceName: () => undefined });
globalThis.stackTest = { nativeError, nativeCapture, runtime };
`;
const depd = `
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
let result;
try {
  Error.prepareStackTrace = (error, sites) => sites;
  function captureDeprecation() { const holder = {}; Error.captureStackTrace(holder); return holder.stack.slice(1); }
  function deprecatedCaller() { return captureDeprecation(); }
  const sites = deprecatedCaller();
  const site = sites[0];
  result = { methods: [typeof site.getFileName, typeof site.getLineNumber, typeof site.getFunctionName], file: site.getFileName(), line: site.getLineNumber(), name: site.getFunctionName() };
} finally { Object.defineProperty(Error, "prepareStackTrace", saved); }
return result;
`;

const probeContracts = `
const probe = (${factories.stack_capability});
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
function checkHook(kind) {
  Reflect.deleteProperty(Error, "prepareStackTrace");
  const previous = () => "previous";
  let current = previous;
  if (kind === "data") Object.defineProperty(Error, "prepareStackTrace", { value: previous, writable: true, configurable: true, enumerable: true });
  if (kind === "accessor") Object.defineProperty(Error, "prepareStackTrace", { configurable: true, enumerable: false, get() { return current; }, set(value) { current = value; } });
  const before = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const supported = probe();
  const after = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  const restored = before === undefined ? after === undefined : Object.keys(before).every(key => before[key] === after[key]);
  return { supported, restored, hook: Error.prepareStackTrace === (kind === "absent" ? undefined : previous) };
}
try { return ["absent", "data", "accessor"].map(checkHook); }
finally { if (saved) Object.defineProperty(Error, "prepareStackTrace", saved); else Reflect.deleteProperty(Error, "prepareStackTrace"); }
`;

const captureContracts = `
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
const original = new TypeError("original failure");
const originalStack = original.stack;
let calls = 0, errorIdentity = false, receiver = false;
let result;
try {
  Error.prepareStackTrace = function (error, sites) { calls++; errorIdentity ||= error === original; receiver = this === Error; return sites; };
  Error.captureStackTrace(original);
  const lazy = calls === 0;
  const sites = original.stack;
  const memoized = original.stack === sites && calls === 1;
  const nativeSites = !stackTest.runtime.mappedCallSites.has(sites[0]);
  const descriptor = Object.getOwnPropertyDescriptor(original, "stack");
  function skip() { const holder = {}; Error.captureStackTrace(holder, skip); return holder; }
  function caller() { return skip(); }
  const trimmed = caller().stack;
  const missing = {}; Error.captureStackTrace(missing, function absent() {});
  const missingConstructor = missing.stack.length;
  Error.prepareStackTrace = saved.value;
  const holder = {}; Error.captureStackTrace(holder);
  result = { nativeError: Error === stackTest.nativeError, nativeCapture: Error.captureStackTrace === stackTest.nativeCapture, nativeSites, structured: stackTest.runtime.hasNativeStackTrace, errorIdentity, receiver, lazy, memoized,
    defaultStack: typeof holder.stack === "string" && typeof originalStack === "string" && original.message === "original failure" && original instanceof TypeError,
    descriptors: descriptor.configurable && !descriptor.enumerable,
    constructorOpt: trimmed[0].getFunctionName(), missingConstructor };
} finally { Object.defineProperty(Error, "prepareStackTrace", saved); }
result.restored = Error.prepareStackTrace === saved.value;
return result;
`;

for (const [name, engine] of [["webkit", webkit], ["chromium", chromium]] as const) {
  test(`${name} host supports the depd capture and structured formatter contract`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addScriptTag({ content: `globalThis.probeContracts = (function () {${probeContracts}\n})()` });
      const probes = await page.evaluate(() => Reflect.get(globalThis, "probeContracts"));
      expect(probes).toEqual(Array.from({ length: 3 }, () => ({ supported: name === "chromium", restored: true, hook: true })));
      await page.addScriptTag({ content: initialize });
      await page.route("http://stack.test/depd-capture.js", route => route.fulfill({ contentType: "text/javascript", body: `globalThis.stackResult = (function () {${depd}\n})()` }));
      await page.addScriptTag({ url: "http://stack.test/depd-capture.js" });
      const result = await page.evaluate(() => Reflect.get(globalThis, "stackResult"));
      expect(errors).toEqual([]);
      expect(result).toEqual({ methods: ["function", "function", "function"], file: "http://stack.test/depd-capture.js", line: 7, name: "deprecatedCaller" });
      await page.route("http://stack.test/contracts.js", route => route.fulfill({ contentType: "text/javascript", body: `globalThis.stackContracts = (function () {${captureContracts}\n})()` }));
      await page.addScriptTag({ url: "http://stack.test/contracts.js" });
      expect(errors).toEqual([]);
      const contracts = await page.evaluate(() => Reflect.get(globalThis, "stackContracts"));
      expect(contracts).toEqual({ nativeError: true, nativeCapture: name === "chromium", nativeSites: name === "chromium", structured: name === "chromium", errorIdentity: true, receiver: true, lazy: true, memoized: true, defaultStack: true, descriptors: true, constructorOpt: "caller", missingConstructor: 0, restored: true });
    } finally { await browser.close(); }
  }, 30_000);
}
