import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, firefox, webkit } from "playwright";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");
const bootstrap = read("bootstrap.js").split("  // --- async context")[0] + "return internal; })";
const transpiler = new Bun.Transpiler({ loader: "ts" });
function factory(name: string) {
  return transpiler.transformSync(`globalThis.factory = ${read(name)};`).replace("globalThis.factory =", "").trim().replace(/;$/, "")
    .replace(/^(function[^\{]*\{)/, '$1"use strict";');
}
const factories = { stack_trace: factory("stack_trace.ts"), stack_capability: factory("stack_capability.ts"), inspect: read("inspect.js") };
const initialize = (engine: string) => `
const nativeError = Error;
const nativeCapture = Error.captureStackTrace;
const nativeStack = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
const factories = Object.fromEntries(Object.entries(${JSON.stringify(factories)}).map(([name, source]) => [name, (0, eval)("(" + source + ")")]));
const runtime = (${bootstrap})({ engine: ${JSON.stringify(engine)}, loadPolyfill: name => factories[name], mapPosition: () => undefined, preparedSourceName: () => undefined });
globalThis.stackTest = { nativeError, nativeCapture, nativeStack, runtime };
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

const awaitingCaller = `
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
Error.prepareStackTrace = (error, sites) => sites;
function capture() { const holder = {}; Error.captureStackTrace(holder, capture); return holder.stack; }
async function resumedLeaf() { await 0; return capture(); }
async function awaitingParent() { return await resumedLeaf(); }
return awaitingParent().then(sites => ({
  leaf: [sites[0].getFunctionName(), sites[0].isAsync()],
  awaiting: sites.filter(site => site.isAsync()).map(site => site.getFunctionName().endsWith("awaitingParent")),
})).finally(() => Object.defineProperty(Error, "prepareStackTrace", saved));
`;

// Firefox is SpiderMonkey. Under the guest's engine name it runs the adapter against the
// native text capture the SpiderMonkey guest has, which ignores the formatter.
const engines = [["webkit", webkit, "host"], ["chromium", chromium, "host"], ["firefox", firefox, "host"], ["firefox", firefox, "spidermonkey"]] as const;
test("SpiderMonkey ordinary errors format lazily and preserve the native accessor contract", async () => {
  const browser = await firefox.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: initialize("spidermonkey") });
    const result = await page.evaluate(`(() => {
      const { nativeError, nativeStack } = stackTest;
      const descriptor = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
      const error = new Error("ordinary");
      const raw = nativeStack.get.call(error);
      let calls = 0;
      let identity = false;
      let receiver = false;
      Error.prepareStackTrace = function (target, sites) { calls++; identity = target === error; receiver = this === Error; return sites; };
      const lazy = calls === 0;
      const sites = error.stack;
      const memoized = error.stack === sites && descriptor.get.call(error) === sites && calls === 1;
      const ordinary = {};
      const empty = descriptor.get.call(ordinary) === nativeStack.get.call(ordinary) && calls === 1;
      let invalid = false;
      try { descriptor.get.call(null); } catch (error) { invalid = error instanceof TypeError; }
      descriptor.set.call(ordinary, "assigned");
      const assigned = Object.getOwnPropertyDescriptor(ordinary, "stack");
      Error.prepareStackTrace = undefined;
      const fallback = new Error("default");
      const defaultStack = fallback.stack === nativeStack.get.call(fallback);
      return { constructor: Error === nativeError, lazy, identity, receiver, memoized, empty, invalid,
        structured: Array.isArray(sites) && sites.every(site => typeof site.isAsync === "function"),
        raw: typeof raw === "string", defaultStack, setter: descriptor.set === nativeStack.set,
        attributes: descriptor.configurable === nativeStack.configurable && descriptor.enumerable === nativeStack.enumerable,
        assigned };
    })()`);
    expect(result).toEqual({ constructor: true, lazy: true, identity: true, receiver: true, memoized: true,
      empty: true, invalid: true, structured: true, raw: true, defaultStack: true, setter: true, attributes: true,
      assigned: { value: "assigned", writable: true, enumerable: true, configurable: true } });
  } finally { await browser.close(); }
}, 30_000);

for (const [name, launcher, engine] of engines) {
  test(`${name} ${engine} supports the depd capture and structured formatter contract`, async () => {
    const browser = await launcher.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addScriptTag({ content: `globalThis.probeContracts = (function () {${probeContracts}\n})()` });
      const probes = await page.evaluate(() => Reflect.get(globalThis, "probeContracts"));
      expect(probes).toEqual(Array.from({ length: 3 }, () => ({ supported: name === "chromium", restored: true, hook: true })));
      await page.addScriptTag({ content: initialize(engine) });
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
      await page.route("http://stack.test/awaiting.js", route => route.fulfill({ contentType: "text/javascript", body: `globalThis.stackAwaiting = (function () {${awaitingCaller}\n})()` }));
      await page.addScriptTag({ url: "http://stack.test/awaiting.js" });
      expect(await page.evaluate(() => Reflect.get(globalThis, "stackAwaiting"))).toEqual({ leaf: ["resumedLeaf", false], awaiting: [true] });
      expect(errors).toEqual([]);
    } finally { await browser.close(); }
  }, 30_000);
}
