import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium, firefox, webkit } from "playwright";

const directory = new URL("../crates/bunwasm-runtime/src/js/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");
const bootstrap = read("bootstrap.js").split("  // --- async context")[0] + "return internal; })";
const transpiler = new Bun.Transpiler({ loader: "ts" });
function factory(name: string) {
  return transpiler.transformSync(`globalThis.factory = ${read(name)};`).replace("globalThis.factory =", "").trim().replace(/;$/, "")
    .replace(/^(function[^{]*\{)/, '$1"use strict";');
}
const factories = { stack_trace: factory("stack_trace.ts"), stack_capability: factory("stack_capability.ts"), host_call_sites: factory("host_call_sites.ts"), inspect: read("inspect.js") };
const initialize = (engine: string) => `
const nativeError = Error;
const nativeCapture = Error.captureStackTrace;
const nativeStack = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
const factories = Object.fromEntries(Object.entries(${JSON.stringify(factories)}).map(([name, source]) => [name, (0, eval)("(" + source + ")")]));
const runtime = (${bootstrap})({ engine: ${JSON.stringify(engine)}, loadPolyfill: name => factories[name], mapPosition: () => undefined, preparedSourceName: () => undefined });
function restorePrepare(descriptor, prepare) {
  if (descriptor.set) descriptor.set.call(Error, prepare);
  Object.defineProperty(Error, "prepareStackTrace", descriptor);
}
globalThis.stackTest = { nativeError, nativeCapture, nativeStack, runtime, restorePrepare };
`;
const depd = `
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
const savedPrepare = Error.prepareStackTrace;
let result;
try {
  Error.prepareStackTrace = (error, sites) => sites;
  function captureDeprecation() { const holder = {}; Error.captureStackTrace(holder); return holder.stack.slice(1); }
  function deprecatedCaller() { return captureDeprecation(); }
  const sites = deprecatedCaller();
  const site = sites[0];
  result = { methods: [typeof site.getFileName, typeof site.getLineNumber, typeof site.getFunctionName], file: site.getFileName(), line: site.getLineNumber(), name: site.getFunctionName() };
} finally { stackTest.restorePrepare(saved, savedPrepare); }
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
const savedPrepare = Error.prepareStackTrace;
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
  Error.prepareStackTrace = savedPrepare;
  const holder = {}; Error.captureStackTrace(holder);
  result = { nativeError: Error === stackTest.nativeError, nativeCapture: Error.captureStackTrace === stackTest.nativeCapture, nativeSites, structured: stackTest.runtime.hasNativeStackTrace, errorIdentity, receiver, lazy, memoized,
    defaultStack: typeof holder.stack === "string" && typeof originalStack === "string" && original.message === "original failure" && original instanceof TypeError,
    descriptors: descriptor.configurable && !descriptor.enumerable,
    constructorOpt: trimmed[0].getFunctionName(), missingConstructor };
} finally { stackTest.restorePrepare(saved, savedPrepare); }
result.restored = Error.prepareStackTrace === savedPrepare;
return result;
`;

const awaitingCaller = `
const saved = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
const savedPrepare = Error.prepareStackTrace;
Error.prepareStackTrace = (error, sites) => sites;
function capture() { const holder = {}; Error.captureStackTrace(holder, capture); return holder.stack; }
async function resumedLeaf() { await 0; return capture(); }
async function awaitingParent() { return await resumedLeaf(); }
return awaitingParent().then(sites => ({
  leaf: [sites[0].getFunctionName(), sites[0].isAsync()],
  awaiting: sites.filter(site => site.isAsync()).map(site => site.getFunctionName().endsWith("awaitingParent")),
})).finally(() => stackTest.restorePrepare(saved, savedPrepare));
`;

const predicateContracts = `
Error.prepareStackTrace = (error, sites) => sites;
const named = Function('return function sloppyNamed() { return new Error().stack; }')();
const sites = named();
const sloppy = sites.find(site => site.getFunctionName() === "sloppyNamed");
const leaf = Function('return async function resumedLeaf() { await 0; return new Error().stack; }')();
async function awaitingParent() { return await (async function () { return await leaf(); })(); }
const resumed = await awaitingParent();
return {
  sloppy: sloppy.isToplevel(),
  leaf: resumed.find(site => site.getFunctionName() === "resumedLeaf").isToplevel(),
  awaiting: resumed.filter(site => site.isAsync()).map(site => site.getFunctionName()),
  program: sites.filter(site => !site.getFunctionName() && site.getEnclosingLineNumber() === 1 && site.getEnclosingColumnNumber() === 1).map(site => [site.isToplevel(), site.isAsync()]),
};
`;

test("native V8 CallSites preserve anonymous awaiters and distinguish program frames", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: initialize("host") });
    await page.addScriptTag({ content: `globalThis.predicateResult = (async () => {${predicateContracts}})()` });
    const result = await page.evaluate(() => Reflect.get(globalThis, "predicateResult"));
    expect(result.sloppy).toBe(false);
    expect(result.leaf).toBe(false);
    expect(result.awaiting).toEqual([null, "awaitingParent", null]);
    expect(result.program.length).toBeGreaterThan(0);
    expect(result.program.every((frame: boolean[]) => frame[0] && !frame[1])).toBe(true);
  } finally { await browser.close(); }
}, 30_000);

test("Node preserves a null-name anonymous awaiter whose enclosing position is 1:1", async () => {
  const script = `import { runInNewContext } from "node:vm";
    const context = {};
    runInNewContext(${JSON.stringify(`(${factories.host_call_sites})({}); Error.prepareStackTrace = (_, sites) => sites;
      globalThis.leaf = async function leaf() { await 0; return new Error().stack; };`)}, context);
    const awaiter = runInNewContext("async () => await leaf()", context, { filename: "anonymous-await.js" });
    const sites = await awaiter();
    const caller = sites.find(site => site.getFileName() === "anonymous-await.js");
    console.log(JSON.stringify([caller.getFunctionName(), caller.getEnclosingLineNumber(), caller.getEnclosingColumnNumber(), caller.isAsync()]));`;
  const child = Bun.spawn(["node", "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual([null, 1, 1, true]);
});

test("Chromium preserves a renamed anonymous awaiting function at 1:1", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: initialize("host") });
    await page.addScriptTag({ content: `async function awaiter() { return await leaf(); }
      Object.defineProperty(awaiter, "name", { value: "" });
//# sourceURL=anonymous-script.js` });
    const result = await page.evaluate(`(async () => {
      Error.prepareStackTrace = (_, sites) => sites;
      globalThis.leaf = async function leaf() { await 0; return new Error().stack; };
      const sites = await awaiter();
      const caller = sites.find(site => site.getScriptNameOrSourceURL() === "anonymous-script.js");
      return [caller.getFunctionName(), caller.getEnclosingLineNumber(), caller.getEnclosingColumnNumber(), caller.isAsync()];
    })()`);
    expect(result).toEqual([null, 1, 1, true]);
  } finally { await browser.close(); }
}, 30_000);

test("only the loader-registered module hash identifies a suspended program", async () => {
  const source = "void 0; globalThis.programSites = await leaf();";
  const hash = createHash("sha256").update(source).digest("hex");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: initialize("host") });
    await page.addScriptTag({ content: `stackTest.runtime.isProgramScriptHash = hash => hash === ${JSON.stringify(hash)};
      Error.prepareStackTrace = (_, sites) => sites;
      globalThis.leaf = async function leaf() { await 0; return new Error().stack; };` });
    await page.route("http://stack.test/program.js", route => route.fulfill({ contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: source }));
    await page.evaluate(`import("http://stack.test/program.js")`);
    const program = await page.evaluate(`programSites.filter(site => site.getScriptHash() === ${JSON.stringify(hash)}).map(site => [site.getFunctionName(), site.isAsync()])`);
    expect(program).toEqual([[null, false]]);
    await page.addScriptTag({ content: `async function awaiter() { return await leaf(); }
      Object.defineProperty(awaiter, "name", { value: "" });
//# sourceURL=http://stack.test/program.js` });
    const anonymous = await page.evaluate(`(async () => {
      const sites = await awaiter();
      return sites.filter(site => site.getScriptNameOrSourceURL() === "http://stack.test/program.js").map(site => [site.getFunctionName(), site.isAsync()]);
    })()`);
    expect(anonymous).toEqual([[null, true]]);
  } finally { await browser.close(); }
}, 30_000);

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
      expect(result).toEqual({ methods: ["function", "function", "function"], file: "http://stack.test/depd-capture.js", line: 8, name: "deprecatedCaller" });
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
