// `bun test` and the `bun:test` module.
//
// The factory returns `{ exports, run }`: `exports` is the module object that
// test files import, `run(args)` is the CLI runner (discovery, execution and
// the report). The report mirrors native Bun 1.4.2 with colors off: per-file
// sections, failures and the summary go to stderr, the version header to
// stdout. Bun's sources for the formats live in vendor/bun/src/runtime/
// cli/test_command.rs and test_runner/ (expect/*.rs, diff/printDiff.rs).
(function (internal) {
  "use strict";

  const native = internal.native;
  const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

  function inspectModule() {
    return internal.require("inspect");
  }

  /** Bun.inspect: the formatter Bun's matcher messages use. */
  function inspect(value) {
    return inspectModule().bunInspect(value);
  }

  function now() {
    return native.now();
  }

  function isThenable(value) {
    return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
  }

  function isObjectLike(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }

  // Bun prints quieter output under AI agents (Claude Code sets CLAUDECODE);
  // `AGENT=0|1` overrides the detection.
  function isAgent() {
    const env = globalThis.process.env;
    if (env.AGENT !== undefined) return env.AGENT === "1";
    return truthyEnv(env.CLAUDECODE) || truthyEnv(env.REPL_ID);
  }

  function truthyEnv(value) {
    return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
  }

  // ───────────────────────────── run state ─────────────────────────────

  // maxConcurrency 0 means no limit, as in Bun.
  const options = { timeout: 5000, namePattern: null, only: false, bail: 0, runTodo: false, agent: false, updateSnapshots: false, concurrent: false, maxConcurrency: 20 };
  const preloads = [];

  const summary = { pass: 0, fail: 0, skip: 0, todo: 0, filtered: 0, files: 0, expectations: 0, errors: 0 };

  // The file whose module is being evaluated (tests register into it).
  let collecting = null;
  // The running test ({ expectCount, assertions }) and its pending invocation, so uncaught
  // errors can fail it. One test runs at a time outside concurrent groups; inside one, each
  // test's slot is the store of a private AsyncLocalStorage, so it travels with the async
  // context its hooks and body run in, alongside the user's own stores.
  const serialSlot = { test: null, invocation: null };
  let concurrentGroups = 0;
  let slotStorage = null;

  function slots() {
    slotStorage ??= new (internal.builtin("node:async_hooks").AsyncLocalStorage)();
    return slotStorage;
  }

  function running() {
    if (concurrentGroups === 0) return serialSlot;
    // Code outside every test of the group, such as a timer the group did not start.
    return slots().getStore() || { test: null, invocation: null };
  }

  function runInSlot(slot, fn) {
    return slots().run(slot, fn);
  }
  // Opaque token for the file being loaded or run; expectations keep it for snapshot guards.
  let activeFile = null;
  let preloadScope = null;
  let preloading = false;
  /** @type {"unattempted" | "loading" | "ready" | "stopped"} */
  let preloadImport = "unattempted";
  /** @type {"pending" | "running" | "ready" | "stopped"} */
  let preloadSetup = "pending";
  let preloadTeardown = false;

  // ───────────────────────────── asymmetric matchers ─────────────────────────────

  class AsymmetricMatcher {
    constructor(sample, inverse) {
      this.sample = sample;
      this.inverse = !!inverse;
      /** @type {"resolves" | "rejects" | undefined} set by expect.resolvesTo and expect.rejectsTo */
      this.promise = undefined;
    }
    // A resolvesTo/rejectsTo matcher compares a real promise's settled value through an
    // intrinsic reaction; thenables never match. A non-promise or the other settlement
    // fails before `not` inverts, as in Bun.
    asymmetricMatch(other) {
      if (this.promise === undefined) return this.matchValue(other);
      if (!internal.isPromise(other)) return this.inverse;
      const resolves = this.promise === "resolves";
      return internal.promiseThen(other, value => resolves ? this.matchValue(value) : this.inverse, error => resolves ? this.inverse : this.matchValue(error));
    }
    matchValue(other) {
      return matcherSupport.settle(this.matches(other), result => this.inverse ? !result : result);
    }
    label(format) {
      if (this.promise === undefined) return this.describe(format);
      return `promise ${this.promise === "resolves" ? "resolved" : "rejected"} to ${this.describe(format)}`;
    }
    // Bun.inspect shows matchers by their pretty description.
    [INSPECT_CUSTOM]() {
      return this.label(inspect);
    }
  }

  class AnyMatcher extends AsymmetricMatcher {
    matches(other) {
      return matchesConstructor(this.sample, other);
    }
    describe() {
      return `${this.inverse ? "NotAny" : "Any"}<${this.sample.name}>`;
    }
  }

  // Bun's expect.any: primitives by type, boxed values and everything else by instanceof,
  // and Object as Jest's `typeof other === "object"`, so null matches and functions do not.
  function matchesConstructor(ctor, value) {
    if (ctor === String && typeof value === "string") return true;
    if (ctor === Number && typeof value === "number") return true;
    if (ctor === Boolean && typeof value === "boolean") return true;
    if (ctor === BigInt && typeof value === "bigint") return true;
    if (ctor === Symbol && typeof value === "symbol") return true;
    if (ctor === Function && typeof value === "function") return true;
    if (ctor === Object) return typeof value === "object";
    return isObjectLike(value) && value instanceof ctor;
  }

  class AnythingMatcher extends AsymmetricMatcher {
    matches(other) {
      return other !== null && other !== undefined;
    }
    describe() {
      return this.inverse ? "NotAnything" : "Anything";
    }
  }

  class StringContainingMatcher extends AsymmetricMatcher {
    matches(other) {
      return typeof other === "string" && other.includes(this.sample);
    }
    describe(format) {
      return `${this.inverse ? "StringNotContaining" : "StringContaining"} ${format(this.sample)}`;
    }
  }

  class StringMatchingMatcher extends AsymmetricMatcher {
    matches(other) {
      // A String object sample is accepted but, as in Bun, matches nothing.
      if (typeof other !== "string" || !(typeof this.sample === "string" || this.sample instanceof RegExp)) return false;
      const re = typeof this.sample === "string" ? new RegExp(this.sample) : this.sample;
      re.lastIndex = 0;
      return re.test(other);
    }
    describe(format) {
      return `${this.inverse ? "StringNotMatching" : "StringMatching"} ${format(this.sample instanceof String ? String(this.sample) : this.sample)}`;
    }
  }

  class ObjectContainingMatcher extends AsymmetricMatcher {
    matches(other) {
      if (!isObjectLike(other)) return false;
      return matcherSupport.every(enumerableOwnKeys(this.sample), key => {
        if (!(key in Object(other))) return false;
        return equals(other[key], this.sample[key], false);
      });
    }
    describe(format) {
      return `${this.inverse ? "ObjectNotContaining" : "ObjectContaining"} ${format(this.sample)}`;
    }
  }

  // objectContaining compares enumerable own symbol keys as well as string keys.
  function enumerableOwnKeys(object) {
    const symbols = Object.getOwnPropertySymbols(object).filter(key => Object.prototype.propertyIsEnumerable.call(object, key));
    return Object.keys(object).concat(symbols);
  }

  class ArrayContainingMatcher extends AsymmetricMatcher {
    matches(other) {
      if (!Array.isArray(other)) return false;
      return matcherSupport.every(this.sample, item => matcherSupport.some(other, value => equals(value, item, false)));
    }
    describe(format) {
      return `${this.inverse ? "ArrayNotContaining" : "ArrayContaining"} ${format(this.sample)}`;
    }
  }

  class CloseToMatcher extends AsymmetricMatcher {
    constructor(sample, precision, inverse) {
      super(sample, inverse);
      this.precision = precision === undefined ? 2 : precision;
    }
    // A non-number never matches, even negated.
    matchValue(other) {
      if (typeof other !== "number") return false;
      return super.matchValue(other);
    }
    matches(other) {
      return closeTo(other, this.sample, this.precision).pass;
    }
    describe() {
      return `${this.inverse ? "NumberNotCloseTo" : "NumberCloseTo"} ${this.sample} (${this.precision} digit${this.precision === 1 ? "" : "s"})`;
    }
  }

  // Matchers registered with expect.extend, usable as expect.name(...).
  class CustomAsymmetricMatcher extends AsymmetricMatcher {
    constructor(name, matcher, args, inverse) {
      super(args, inverse);
      this.name = name;
      this.matcher = matcher;
    }
    matches(other) {
      const result = this.matcher.call(matcherContext(false), other, ...this.sample);
      return extensions.asymmetric(this.name, result, error => writeErr(formatErrorText(error)));
    }
    describe() {
      return `${this.name}(${this.sample.map((v) => inspect(v)).join(", ")})`;
    }
  }

  function isAsymmetric(value) {
    return value instanceof AsymmetricMatcher;
  }

  // ───────────────────────────── equality ─────────────────────────────

  function bunDeepEquals(a, b, strict) {
    return internal.require("util").bunDeepEquals(a, b, strict);
  }

  function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /** toEqual / toStrictEqual semantics, with asymmetric matchers on either side. */
  function equals(received, expected, strict) {
    return internal.require("util").expectEquals(received, expected, strict, compareAsymmetric, isAsymmetric);
  }

  function compareAsymmetric(received, expected) {
    if (isAsymmetric(expected)) return expected.asymmetricMatch(received);
    if (isAsymmetric(received)) return received.asymmetricMatch(expected);
    return undefined;
  }

  /** toMatchObject: every property of `expected` is present and matches in `received`. */
  // Bun__deepMatch matches arrays exactly: the same length and the same number of enumerable
  // keys (symbols included), then every key of the expected array.
  function matchesArray(received, expected, seen) {
    if (!Array.isArray(received) || received.length !== expected.length) return false;
    const keys = enumerableOwnKeys(expected);
    if (enumerableOwnKeys(received).length !== keys.length) return false;
    return matcherSupport.every(keys, key => key in received && matchesObject(received[key], expected[key], seen));
  }

  function matchesObject(received, expected, seen) {
    const asymmetric = compareAsymmetric(received, expected);
    if (asymmetric !== undefined) return asymmetric;
    if (!isObjectLike(expected) || !isObjectLike(received)) return equals(received, expected, false);
    if (Array.isArray(expected)) return matchesArray(received, expected, seen);
    if (!isPlainObject(expected) && !isPlainObject(received)) {
      if (expected instanceof Date || expected instanceof RegExp || expected instanceof Map || expected instanceof Set) {
        return equals(received, expected, false);
      }
    }
    const visited = seen || new Set();
    // Bun__deepMatch reads the expected object's enumerable symbol keys as well as its strings.
    return matcherSupport.ancestors(visited, expected, () => matcherSupport.every(enumerableOwnKeys(expected), key => {
      if (!(key in received)) return false;
      return matchesObject(received[key], expected[key], visited);
    }));
  }

  // ───────────────────────────── Jest pretty format ─────────────────────────────
  // The format Bun's diffs use (test_runner/pretty_format.rs): keys quoted and
  // sorted, one entry per line, trailing commas.

  function prettyFormat(value) {
    return prettyValue(value, "", new Set());
  }

  function prettyValue(value, indent, seen, snapshot) {
    if (value === null) return "null";
    switch (typeof value) {
      case "undefined":
        return "undefined";
      case "string":
        return snapshot ? snapshotString(value) : `"${value}"`;
      case "number":
        return Object.is(value, -0) ? "-0" : String(value);
      case "bigint":
        return `${value}n`;
      case "boolean":
        return String(value);
      case "symbol":
        return value.description ? `Symbol(${value.description})` : "Symbol";
      case "function":
        return prettyFunction(value);
    }
    if (isAsymmetric(value)) return prettyAsymmetric(value, indent, seen, snapshot);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      return prettyObject(value, indent, seen, snapshot);
    } finally {
      seen.delete(value);
    }
  }

  function prettyFunction(fn) {
    const source = Function.prototype.toString.call(fn);
    if (/^class\b/.test(source)) return fn.name ? `[class ${fn.name}]` : "[class (anonymous)]";
    return fn.name ? `[Function: ${fn.name}]` : "[Function]";
  }

  function prettyAsymmetric(matcher, indent, seen, snapshot) {
    // Bun prints arrayContaining through its generic object path.
    if (matcher instanceof ArrayContainingMatcher) return "ExpectArrayContaining {}";
    return matcher.label((sample) => prettyValue(sample, indent, seen, snapshot));
  }

  function prettyObject(value, indent, seen, snapshot) {
    const inner = indent + "  ";
    const block = (open, close, items, collection) => {
      if (items.length === 0) return `${snapshot && collection === "set" ? indent : ""}${open}${close}`;
      const text = `${open}\n${items.map((item) => `${inner}${item},\n`).join("")}${indent}${close}`;
      if (snapshot && collection) return `${collection === "set" ? indent : ""}\n${text}\n`;
      return snapshot && indent === "" ? `\n${text}\n` : text;
    };
    if (snapshot && typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
      return prettyObject({ data: Array.from(value), type: "Buffer" }, indent, seen, true);
    }
    if (snapshot && value instanceof DataView) {
      return block("DataView [", "]", Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), String));
    }
    if (Array.isArray(value)) {
      return block("[", "]", Array.from(value, (item) => prettyValue(item, inner, seen, snapshot)));
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return block(`${value.constructor.name} [`, "]", Array.from(value, (item) => prettyValue(item, inner, seen, snapshot)));
    }
    if (value instanceof ArrayBuffer) {
      return block("ArrayBuffer [", "]", Array.from(new Uint8Array(value), String));
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return snapshot && value.message === "" ? `[${value.name}]` : `[${value.name}: ${value.message}]`;
    if (value instanceof Promise) return "Promise {}";
    if (value instanceof Map) {
      const entries = Array.from(value, ([k, v]) => `${prettyValue(k, inner, seen, snapshot)} => ${prettyValue(v, inner, seen, snapshot)}`);
      return block("Map {", "}", entries, "map");
    }
    if (value instanceof Set) {
      return block("Set {", "}", Array.from(value, (item) => prettyValue(item, inner, seen, snapshot)), "set");
    }
    const name = constructorName(value);
    const prefix = name === "Object" || name === "" ? "{" : `${name} {`;
    const keys = snapshot ? Object.keys(value).concat(Object.getOwnPropertySymbols(value).filter((key) => Object.prototype.propertyIsEnumerable.call(value, key))) : Object.getOwnPropertyNames(value);
    keys.sort((a, b) => compareStrings(typeof a === "symbol" ? a.description || "" : a, typeof b === "symbol" ? b.description || "" : b));
    const items = keys.map((key) => {
      const label = typeof key === "symbol" ? `[${String(key)}]` : snapshot ? JSON.stringify(key) : `"${key}"`;
      return `${label}: ${snapshot ? prettyValue(value[key], inner, seen, snapshot) : prettyProperty(value, key, inner, seen)}`;
    });
    return block(prefix, "}", items);
  }

  // Assertion diagnostics never run accessors; native Bun prints them as [native code].
  function prettyProperty(value, key, indent, seen) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) return "[native code]";
    return prettyValue(value[key], indent, seen, false);
  }

  function constructorName(value) {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return "";
    const ctor = proto.constructor;
    return typeof ctor === "function" ? ctor.name : "";
  }

  // ───────────────────────────── diff ─────────────────────────────
  // A port of the colorless path of Bun's printDiff.rs. Bun's line differ is a
  // tuned Myers; this one trims common lines and runs an LCS on the rest,
  // which agrees on the usual small diffs.

  function diffConfig() {
    return options.agent
      ? { minBytesBeforeChunking: 0, contextLines: 1 }
      : { minBytesBeforeChunking: 2 * 1024, contextLines: 5 };
  }

  /** The text Bun's DiffFormatter prints for `received` vs `expected`. */
  function formatDiff(received, expected, not) {
    const expectedText = prettyFormat(expected);
    if (not) return `Expected: not ${expectedText}`;
    const receivedText = prettyFormat(received);
    if (typeof received !== typeof expected && (isObjectLike(received) || isObjectLike(expected))) {
      return `Expected: ${expectedText}\nReceived: ${receivedText}`;
    }
    return diffStrings(receivedText, expectedText);
  }

  function diffStrings(receivedText, expectedText) {
    if (!receivedText.includes("\n") && !expectedText.includes("\n")) {
      return `Expected: ${expectedText}\nReceived: ${receivedText}`;
    }
    const a = expectedText.split("\n");
    const b = receivedText.split("\n");
    let segments = segmentsFromHunks(a, b, lineHunks(a, b));
    const config = diffConfig();
    if (expectedText.length > config.minBytesBeforeChunking || receivedText.length > config.minBytesBeforeChunking) {
      segments = chunkSegments(segments, config.contextLines);
    }
    return renderSegments(segments);
  }

  // Hunks over line indices: a[aLo..aHi] replaced by b[bLo..bHi].
  function lineHunks(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA--;
      endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) return [];
    if (n === 0 || m === 0 || n * m > 4e6) return [{ aLo: start, aHi: endA, bLo: start, bHi: endB }];
    return lcsHunks(a.slice(start, endA), b.slice(start, endB), start);
  }

  function lcsHunks(a, b, offset) {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    const hunks = [];
    let hunk = null;
    let i = 0;
    let j = 0;
    const open = () => hunk || (hunk = { aLo: i + offset, aHi: i + offset, bLo: j + offset, bHi: j + offset });
    const close = () => {
      if (hunk) hunks.push(hunk);
      hunk = null;
    };
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        close();
        i++;
        j++;
      } else if (j >= m || (i < n && table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        open().aHi = ++i + offset;
      } else {
        open().bHi = ++j + offset;
      }
    }
    close();
    return hunks;
  }

  function segmentsFromHunks(a, b, hunks) {
    const segments = [];
    let prev = 0;
    for (const h of hunks) {
      if (h.aLo > prev) segments.push({ kind: "equal", lines: a.slice(prev, h.aLo) });
      const removed = a.slice(h.aLo, h.aHi);
      const inserted = b.slice(h.bLo, h.bHi);
      if (removed.length > 0 && inserted.length > 0) segments.push({ kind: "modified", removed, inserted });
      else if (removed.length > 0) segments.push({ kind: "removed", lines: removed });
      else segments.push({ kind: "inserted", lines: inserted });
      prev = h.aHi;
    }
    if (prev < a.length) segments.push({ kind: "equal", lines: a.slice(prev) });
    return segments;
  }

  // Keep `context` lines of each unchanged run next to a change; elide the rest.
  function chunkSegments(segments, context) {
    const out = [];
    segments.forEach((seg, i) => {
      if (seg.kind !== "equal") {
        out.push(seg);
        return;
      }
      const head = i > 0 ? context : 0;
      const tail = i + 1 < segments.length ? context : 0;
      if (seg.lines.length <= head + tail) {
        out.push(seg);
        return;
      }
      if (head > 0) out.push({ kind: "equal", lines: seg.lines.slice(0, head) });
      out.push({ kind: "skipped", count: seg.lines.length - head - tail });
      if (tail > 0) out.push({ kind: "equal", lines: seg.lines.slice(seg.lines.length - tail) });
    });
    return out;
  }

  function segmentSizes(seg) {
    if (seg.kind === "equal") return [seg.lines.length, seg.lines.length];
    if (seg.kind === "removed") return [seg.lines.length, 0];
    if (seg.kind === "inserted") return [0, seg.lines.length];
    if (seg.kind === "modified") return [seg.removed.length, seg.inserted.length];
    return [0, 0];
  }

  function hunkHeader(segments, from, removedLine, insertedLine) {
    let original = 0;
    let changed = 0;
    for (let k = from; k < segments.length && segments[k].kind !== "skipped"; k++) {
      const [r, s] = segmentSizes(segments[k]);
      original += r;
      changed += s;
    }
    return `@@ -${removedLine},${original} +${insertedLine},${changed} @@\n`;
  }

  function renderSegments(segments) {
    const rows = (lines, prefix) => lines.map((line) => `${prefix}${line}\n`).join("");
    let out = "";
    let removedLine = 1;
    let insertedLine = 1;
    let removedCount = 0;
    let insertedCount = 0;
    let wasSkipped = segments.some((seg) => seg.kind === "skipped");
    segments.forEach((seg, i) => {
      if (seg.kind === "skipped") {
        wasSkipped = true;
        removedLine += seg.count;
        insertedLine += seg.count;
        return;
      }
      if (wasSkipped) {
        wasSkipped = false;
        out += hunkHeader(segments, i, removedLine, insertedLine);
      }
      const [r, s] = segmentSizes(seg);
      removedLine += r;
      insertedLine += s;
      if (seg.kind !== "equal") {
        removedCount += r;
        insertedCount += s;
      }
      if (seg.kind === "equal") out += rows(seg.lines, "  ");
      else if (seg.kind === "removed") out += rows(seg.lines, "- ");
      else if (seg.kind === "inserted") out += rows(seg.lines, "+ ");
      else out += rows(seg.removed, "- ") + rows(seg.inserted, "+ ");
    });
    return `${out}\n- Expected  - ${removedCount}\n+ Received  + ${insertedCount}`;
  }

  // ───────────────────────────── mocks ─────────────────────────────

  const allMocks = new Set();
  const mockStates = new WeakMap();

  function isMock(value) {
    return typeof value === "function" && mockStates.has(value);
  }

  function createMock(implementation, restore) {
    const state = {
      impl: typeof implementation === "function" || implementation === undefined ? implementation : () => implementation,
      once: [],
      name: mockFunctionName(implementation),
      restore,
      record: newRecord(),
    };
    const fn = function (...args) {
      return callMock(fn, state, this, args, new.target);
    };
    Object.defineProperty(fn, "name", { value: state.name });
    Object.defineProperty(fn, "length", { value: typeof implementation === "function" ? implementation.length : 0 });
    Object.setPrototypeOf(fn, mockPrototype);
    mockStates.set(fn, state);
    allMocks.add(fn);
    return fn;
  }

  function mockFunctionName(implementation) {
    try {
      const name = typeof implementation === "function" && implementation.name;
      if (typeof name === "string" && name) return name;
    } catch {}
    return "mockConstructor";
  }

  const recordPrototype = Object.create(Object.prototype, {
    lastCall: { enumerable: true, get() { return this?.calls?.[this.calls.length - 1]; } },
  });

  function newRecord() {
    return Object.assign(Object.create(recordPrototype), { calls: [], results: [], instances: [], contexts: [], invocationCallOrder: [] });
  }

  let mockCallOrder = 0;

  function callMock(fn, state, self, args, newTarget) {
    const record = state.record;
    record.calls.push(args);
    record.contexts.push(self);
    record.instances.push(newTarget ? undefined : self);
    record.invocationCallOrder.push(++mockCallOrder);
    const result = { type: "incomplete", value: undefined };
    record.results.push(result);
    const impl = state.once.length > 0 ? state.once.shift() : state.impl;
    try {
      let value;
      if (impl) value = newTarget ? Reflect.construct(impl, args, newTarget) : impl.apply(self, args);
      result.type = "return";
      result.value = value;
      return value;
    } catch (err) {
      result.type = "throw";
      result.value = err;
      throw err;
    }
  }

  function mockState(receiver) {
    const state = mockStates.get(receiver);
    if (state) return state;
    const error = new TypeError("Expected this to be instanceof Mock");
    error.code = "ERR_INVALID_THIS";
    throw error;
  }

  function mockMethods() {
    const chain = (action) =>
      function (...args) {
        action(mockState(this), ...args);
        return this;
      };
    return {
      getMockName() { return mockState(this).name; },
      getMockImplementation() { return mockState(this).impl; },
      mockName(name) {
        const state = mockState(this);
        if (name) {
          state.name = String(name);
          Object.defineProperty(this, "name", { value: state.name });
        }
        return this;
      },
      mockClear: chain((state) => (state.record = newRecord())),
      mockReset: chain((state) => {
        state.record = newRecord();
        state.impl = undefined;
        state.once = [];
      }),
      mockRestore: chain((state) => {
        state.record = newRecord();
        state.impl = undefined;
        state.once = [];
        if (state.restore) state.restore();
      }),
      mockImplementation: chain((state, impl) => (state.impl = impl)),
      mockImplementationOnce: chain((state, impl) => state.once.push(impl)),
      mockReturnValue: chain((state, value) => (state.impl = () => value)),
      mockReturnValueOnce: chain((state, value) => state.once.push(() => value)),
      mockResolvedValue: chain((state, value) => {
        const promise = Promise.resolve(value);
        state.impl = () => promise;
      }),
      mockResolvedValueOnce: chain((state, value) => {
        const promise = Promise.resolve(value);
        state.once.push(() => promise);
      }),
      mockRejectedValue: chain((state, value) => (state.impl = () => Promise.reject(value))),
      mockRejectedValueOnce: chain((state, value) => state.once.push(() => Promise.reject(value))),
      mockReturnThis: chain((state) => (state.impl = function () {
        return this;
      })),
      withImplementation(impl, callback) {
        const state = mockState(this);
        const saved = state.impl;
        const savedOnce = state.once;
        state.impl = impl;
        state.once = [];
        const restore = () => { state.impl = saved; state.once = savedOnce; };
        const result = callback();
        if (isThenable(result)) return result.then(restore, (err) => (restore(), Promise.reject(err)));
        restore();
        return result;
      },
    };
  }

  const mockPrototype = Object.create(Function.prototype, {
    mock: { enumerable: true, get() { return mockState(this).record; } },
    _protoImpl: { enumerable: true, get() { return mockState(this).impl; } },
    _isMockFunction: { value: true, enumerable: true, writable: true, configurable: true },
  });
  for (const [name, method] of Object.entries(mockMethods())) {
    Object.defineProperty(mockPrototype, name, { value: method, enumerable: true });
  }
  Object.defineProperty(mockPrototype, Symbol.dispose, { value: mockPrototype.mockRestore, configurable: true });

  function mock(implementation) {
    return createMock(implementation);
  }

  function spyOn(object, method) {
    if (!isObjectLike(object)) throw new TypeError("spyOn(target, prop) expects a target object and a property");
    const key = typeof method === "symbol" ? method : String(method);
    let owner = object;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) owner = Object.getPrototypeOf(owner);
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor && !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new TypeError("spyOn does not support accessor properties");
    const original = object[key];
    if (isMock(original)) return original;
    const callable = typeof original === "function";
    if (typeof object === "function" && key === "prototype" && !callable) {
      throw new TypeError("Cannot spy on the `prototype` property because it is not a function");
    }
    const ownDescriptor = Object.getOwnPropertyDescriptor(object, key);
    const restore = () => {
      if (ownDescriptor) Object.defineProperty(object, key, ownDescriptor);
      else if (callable) delete object[key];
      else Object.defineProperty(object, key, { value: original, writable: true, enumerable: true, configurable: true });
    };
    const spy = createMock(original, restore);
    try {
      if (callable) object[key] = spy;
      else Object.defineProperty(object, key, { get: spy, set: spy, enumerable: true, configurable: true });
    } catch (error) {
      allMocks.delete(spy);
      throw error;
    }
    return spy;
  }

  function forEachMock(method) {
    for (const fn of allMocks) fn[method]();
  }

  mock.restore = () => forEachMock("mockRestore");
  mock.clearAllMocks = () => forEachMock("mockClear");
  mock.module = () => {
    throw new Error("mock.module() is not supported in bun-wasm yet");
  };

  const jest = {
    ...internal.fakeTimers.api,
    fn: mock,
    spyOn,
    restoreAllMocks: () => forEachMock("mockRestore"),
    clearAllMocks: () => forEachMock("mockClear"),
    resetAllMocks: () => forEachMock("mockReset"),
    isMockFunction: isMock,
    setTimeout: setDefaultTimeout,
  };

  // ───────────────────────────── expect ─────────────────────────────

  // Parameter labels for signatures, `expect(received).toBe(expected)`.
  const matcherParams = Object.create(null);

  const expectProto = {
    get not() {
      return makeExpectation(this.received, { not: !this.flags.not, promise: this.flags.promise }, this.label, this.file);
    },
    get resolves() {
      return makeExpectation(this.received, { not: this.flags.not, promise: "resolves" }, this.label, this.file);
    },
    get rejects() {
      return makeExpectation(this.received, { not: this.flags.not, promise: "rejects" }, this.label, this.file);
    },
  };

  function makeExpectation(received, flags, label, file) {
    const expectation = Object.create(expectProto);
    expectation.received = received;
    expectation.flags = flags;
    expectation.label = label;
    expectation.file = file;
    return expectation;
  }

  function signature(name, params, not, promise) {
    const modifiers = (promise ? `${promise}.` : "") + (not ? "not." : "");
    return `expect(received).${modifiers}${name}(${params})`;
  }

  function countExpectation(test = running().test) {
    if (test) test.expectCount++;
    else summary.expectations++;
  }

  /**
   * Define a matcher. `impl(ctx, received, ...args)` returns null on success
   * or `{ params?, body }`; the error message is the signature plus `body`.
   * The Error is created when the matcher is called so its stack points at
   * the `expect(...)` line, even for `.resolves`/`.rejects`.
   */
  const matcherSupport = internal.require("test_matchers");
  const extensions = internal.require("test_extensions");
  const extendedMatchers = matcherSupport.extended(inspect);

  function defineMatcher(name, params, impl) {
    matcherParams[name] = params;
    const snapshot = name === "toMatchSnapshot" || name === "toMatchInlineSnapshot" || name === "toThrowErrorMatchingSnapshot" || name === "toThrowErrorMatchingInlineSnapshot";
    const fileSnapshot = name === "toMatchSnapshot" || name === "toThrowErrorMatchingSnapshot";
    expectProto[name] = function (...args) {
      const error = new Error();
      const slot = running();
      const origin = { invocation: slot.invocation, test: slot.test };
      const context = { not: this.flags.not, promise: this.flags.promise, error, origin, label: this.label };
      if (snapshot && this.flags.not) {
        countExpectation(origin.test);
        error.message = (this.label || signature(name, "", true)) + "\n\nMatcher error: Snapshot matchers cannot be used with not\n";
        throw error;
      }
      if (fileSnapshot && this.file !== activeFile) {
        error.message = (this.label || signature(name, "", false)) + "\n\nMatcher error: Snapshot matchers cannot be used outside of a test\n";
        throw error;
      }
      if (name.endsWith("Snapshot")) context.snapshot = reserveSnapshot(origin, name, args);
      const result = this.flags.promise
        ? matcherSupport.settle(matchPromise(this, name, impl, args, context), () => undefined)
        : matchImmediate(this, name, impl, args, context);
      return origin.invocation ? origin.invocation.track(result) : result;
    };
  }

  function matchImmediate(expectation, name, impl, args, context) {
    countExpectation(context.origin.test);
    return applyMatcher(context, expectation.received, name, impl, args);
  }

  function applyMatcher(context, received, name, impl, args) {
    return matcherSupport.settle(impl(context, received, ...args), (failure) => {
      if (!failure) return;
      const params = failure.params === undefined ? matcherParams[name] : failure.params;
      context.error.message = failure.raw ? failure.body : (context.label || signature(name, params, context.not)) + failure.body;
      throw context.error;
    });
  }

  async function matchPromise(expectation, name, impl, args, context) {
    const { flags, received } = expectation;
    const { error } = context;
    const fail = (body) => {
      error.message = (context.label || signature(name, matcherParams[name], flags.not, flags.promise)) + body;
      throw error;
    };
    if (!isThenable(received)) return fail(`\n\nExpected promise\nReceived: ${inspect(received)}\n`);
    let settled;
    try {
      settled = { ok: true, value: await received };
    } catch (err) {
      settled = { ok: false, value: err };
    }
    if (flags.promise === "rejects" && settled.ok) {
      return fail("\n\nExpected promise that rejects\nReceived promise that resolved: Promise { <resolved> }\n");
    }
    if (flags.promise === "resolves" && !settled.ok) {
      return fail("\n\nExpected promise that resolves\nReceived promise that rejected: Promise { <rejected> }\n");
    }
    if (context.origin.invocation?.settled) return;
    countExpectation(context.origin.test);
    await applyMatcher(context, settled.value, name, impl, args);
    return undefined;
  }

  function expect(value, label) {
    return makeExpectation(value, { not: false, promise: undefined }, typeof label === "string" ? label : undefined, activeFile);
  }

  // expect, expect.not, expect.resolvesTo, expect.not.rejectsTo and so on each create
  // asymmetric matchers with their own flags, like Bun's ExpectStatic. Factories validate
  // their samples when called, with Bun's messages.
  const STATIC_FLAGS = Symbol("expect static flags");
  const statics = new Map();

  function expectStatic(not, promise) {
    const key = `${not}:${promise}`;
    let value = statics.get(key);
    if (!value) statics.set(key, value = new ExpectStatic(not, promise));
    return value;
  }

  // Bun's isString also accepts String objects, derived ones included; they match by value.
  function isStringSample(value) {
    return typeof value === "string" || value instanceof String;
  }

  function factoryError(signature, problem) {
    return new Error(`expect.${signature}\n\n${problem}`);
  }

  function isConstructor(value) {
    try {
      Reflect.construct(String, [], value);
      return true;
    } catch {
      return false;
    }
  }

  class ExpectStatic {
    constructor(not, promise) {
      this[STATIC_FLAGS] = { not, promise };
    }
    get not() {
      const { not, promise } = this[STATIC_FLAGS];
      return expectStatic(!not, promise);
    }
    get resolvesTo() {
      return settledStatic(this, "resolves");
    }
    get rejectsTo() {
      return settledStatic(this, "rejects");
    }
    anything() {
      return flagged(this, new AnythingMatcher());
    }
    any(...args) {
      if (args.length === 0) throw new TypeError("any() expects to be passed a constructor function. Please pass one or use anything() to match any object.");
      if (!isConstructor(args[0])) throw factoryError("any(constructor)", "Expected a constructor\n");
      return flagged(this, new AnyMatcher(args[0]));
    }
    stringContaining(sample) {
      if (!isStringSample(sample)) throw factoryError("stringContaining(string)", "Expected a string\n");
      return flagged(this, new StringContainingMatcher(String(sample)));
    }
    stringMatching(sample) {
      // Bun names stringContaining in this message too.
      if (!isStringSample(sample) && !(sample instanceof RegExp)) throw factoryError("stringContaining(string)", "Expected a string or regular expression\n");
      return flagged(this, new StringMatchingMatcher(sample));
    }
    objectContaining(sample) {
      if (!isObjectLike(sample)) throw factoryError("objectContaining(object)", "Expected an object\n");
      return flagged(this, new ObjectContainingMatcher(sample));
    }
    arrayContaining(sample) {
      if (!Array.isArray(sample)) throw factoryError("arrayContaining(array)", "Expected a array\n");
      return flagged(this, new ArrayContainingMatcher(sample));
    }
    closeTo(...args) {
      if (typeof args[0] !== "number") throw factoryError("closeTo(number, precision?)", "Expected a number value");
      if (args[1] !== undefined && typeof args[1] !== "number") throw factoryError("closeTo(number, precision?)", "Precision must be a number or undefined");
      return flagged(this, new CloseToMatcher(args[0], args[1]));
    }
  }

  const PROMISE_CHAINS = { resolves: "resolvesTo", rejects: "rejectsTo" };

  function settledStatic(chain, promise) {
    const flags = chain[STATIC_FLAGS];
    if (flags.promise) throw new Error(`expect.${PROMISE_CHAINS[promise]}: already called expect.${PROMISE_CHAINS[flags.promise]} on this chain`);
    return expectStatic(flags.not, promise);
  }

  function flagged(chain, matcher) {
    const { not, promise } = chain[STATIC_FLAGS];
    matcher.inverse = not;
    matcher.promise = promise;
    return matcher;
  }

  const rootStatic = expectStatic(false, undefined);
  for (const name of ["anything", "any", "stringContaining", "stringMatching", "objectContaining", "arrayContaining", "closeTo"]) {
    expect[name] = (...args) => rootStatic[name](...args);
  }
  for (const name of ["not", "resolvesTo", "rejectsTo"]) {
    Object.defineProperty(expect, name, { get: () => rootStatic[name], configurable: true });
  }
  expect.assertions = (count) => {
    const test = running().test;
    if (test) test.assertions = { exact: count };
  };
  expect.hasAssertions = () => {
    const test = running().test;
    if (test) test.assertions = { atLeastOne: true };
  };
  expect.unreachable = (message) => {
    throw new Error(message === undefined ? "reached unreachable code" : String(message));
  };
  expect.extend = (matchers) => {
    extensions.register(matchers, defineCustomMatcher);
  };

  function matcherContext(not, promise) {
    return extensions.context(not, promise, (a, b) => equals(a, b, false));
  }

  function defineCustomMatcher(name, matcher) {
    defineMatcher(name, "", (ctx, received, ...args) => {
      const result = matcher.call(matcherContext(ctx.not, ctx.promise), received, ...args);
      return extensions.result(name, result, ctx.not);
    });
    ExpectStatic.prototype[name] = function (...args) {
      return flagged(this, new CustomAsymmetricMatcher(name, matcher, args));
    };
    expect[name] = (...args) => rootStatic[name](...args);
  }

  // Whether a matcher with outcome `pass` fails once `.not` is applied.
  function failed(ctx, pass) {
    return pass === ctx.not;
  }

  // ── equality ──

  defineMatcher("toBe", "expected", (ctx, received, expected) => {
    if (!failed(ctx, Object.is(received, expected))) return null;
    if (ctx.not) return { body: `\n\nExpected: not ${inspect(expected)}\n` };
    if (bunDeepEquals(received, expected, false) || bunDeepEquals(received, expected, true)) {
      return { body: `\n\nExpected: ${inspect(expected)}\nReceived: serializes to the same string\n` };
    }
    if (typeof received === "string" && typeof expected === "string") {
      return { body: `\n\n${formatDiff(received, expected, false)}\n` };
    }
    return { body: `\n\nExpected: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  });

  function defineEqualityMatcher(name, test) {
    defineMatcher(name, "expected", (ctx, received, expected) => {
      return matcherSupport.settle(test(received, expected), pass => {
        if (!failed(ctx, pass)) return null;
        return { body: `\n\n${formatDiff(received, expected, ctx.not)}\n` };
      });
    });
  }

  defineEqualityMatcher("toEqual", (received, expected) => equals(received, expected, false));
  defineEqualityMatcher("toStrictEqual", (received, expected) => equals(received, expected, true));

  defineMatcher("toMatchObject", "expected", (ctx, received, expected) => {
    if (!isObjectLike(received)) return { body: "\n\nMatcher error: received value must be a non-null object\n" };
    if (!isObjectLike(expected)) return { body: "\n\nMatcher error: expected value must be a non-null object\n" };
    return matcherSupport.settle(matchesObject(received, expected), pass => {
      if (!failed(ctx, pass)) return null;
      return { body: `\n\n${formatDiff(received, expected, ctx.not)}\n` };
    });
  });

  // ── simple value checks: `Received: <value>` ──

  function defineValueMatcher(name, test) {
    defineMatcher(name, "", (ctx, received) => {
      if (!failed(ctx, test(received))) return null;
      return { body: `\n\nReceived: ${inspect(received)}\n` };
    });
  }

  defineValueMatcher("toBeTrue", (v) => v === true);
  defineValueMatcher("toBeFalse", (v) => v === false);
  defineValueMatcher("toBeTruthy", (v) => !!v);
  defineValueMatcher("toBeFalsy", (v) => !v);
  defineValueMatcher("toBeNull", (v) => v === null);
  defineValueMatcher("toBeUndefined", (v) => v === undefined);
  defineValueMatcher("toBeDefined", (v) => v !== undefined);
  defineValueMatcher("toBeNaN", (v) => typeof v === "number" && Number.isNaN(v));
  defineValueMatcher("toBeNil", (v) => v === null || v === undefined);
  defineValueMatcher("toBeArray", (v) => Array.isArray(v));
  defineValueMatcher("toBeString", (v) => typeof v === "string" || v instanceof String);
  defineValueMatcher("toBeNumber", (v) => typeof v === "number" || v instanceof Number);
  defineValueMatcher("toBeBoolean", (v) => typeof v === "boolean" || v instanceof Boolean);
  defineValueMatcher("toBeFunction", (v) => typeof v === "function");
  defineValueMatcher("toBeInteger", (v) => Number.isInteger(v));
  defineValueMatcher("toBeFinite", (v) => typeof v === "number" && Number.isFinite(v));
  defineValueMatcher("toBePositive", (v) => typeof v === "number" && v > 0 && Number.isFinite(v));
  defineValueMatcher("toBeNegative", (v) => typeof v === "number" && v < 0 && Number.isFinite(v));
  defineValueMatcher("toBeEven", matcherSupport.even);
  defineValueMatcher("toBeOdd", matcherSupport.odd);
  defineValueMatcher("toBeDate", (v) => v instanceof Date);
  defineValueMatcher("toBeValidDate", (v) => v instanceof Date && !Number.isNaN(v.getTime()));
  // Bun's isObject: functions and classes are objects too.
  defineMatcher("toBeObject", "", (ctx, received) => {
    if (!failed(ctx, isObjectLike(received))) return null;
    return { body: `\n\nExpected value ${ctx.not ? "not " : ""}to be an object\n\nReceived: ${inspect(received)}\n` };
  });
  // Bun's is_object_empty: Map, Set (weak ones included), RegExp and Date are their own kinds,
  // not empty objects.
  defineValueMatcher("toBeEmptyObject", (v) => isObjectLike(v) && !isKeyedKind(v) && Object.keys(v).length === 0);

  function isKeyedKind(value) {
    return value instanceof Map || value instanceof Set || value instanceof WeakMap || value instanceof WeakSet || value instanceof RegExp || value instanceof Date;
  }
  defineValueMatcher("toBeSymbol", (v) => typeof v === "symbol");

  // ── ordering ──

  function defineOrderingMatcher(name, op, compare) {
    defineMatcher(name, "expected", (ctx, received, expected) => {
      if (!failed(ctx, compare(received, expected))) return null;
      const not = ctx.not ? "not " : "";
      return { body: `\n\nExpected: ${not}${op} ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
    });
  }

  defineMatcher("toBeWithin", "start, end", matcherSupport.within);

  defineOrderingMatcher("toBeGreaterThan", ">", (a, b) => a > b);
  defineOrderingMatcher("toBeGreaterThanOrEqual", ">=", (a, b) => a >= b);
  defineOrderingMatcher("toBeLessThan", "<", (a, b) => a < b);
  defineOrderingMatcher("toBeLessThanOrEqual", "<=", (a, b) => a <= b);

  function closeTo(received, expected, precision) {
    const expectedDiff = Math.pow(10, -precision) / 2;
    if (received === Infinity && expected === Infinity) return { pass: true, expectedDiff, receivedDiff: 0 };
    if (received === -Infinity && expected === -Infinity) return { pass: true, expectedDiff, receivedDiff: 0 };
    const receivedDiff = Math.abs(expected - received);
    return { pass: receivedDiff < expectedDiff, expectedDiff, receivedDiff };
  }

  defineMatcher("toBeCloseTo", "expected, precision", (ctx, received, expected, precision = 2) => {
    const result = closeTo(received, expected, precision);
    if (!failed(ctx, result.pass)) return null;
    const not = ctx.not ? "not " : "";
    return {
      body:
        `\n\nExpected: ${not}${inspect(expected)}\nReceived: ${inspect(received)}\n\n` +
        `Expected precision: ${precision}\nExpected difference: ${not}< ${inspect(result.expectedDiff)}\n` +
        `Received difference: ${inspect(result.receivedDiff)}\n`,
    };
  });

  // ── containers ──

  defineMatcher("pass", "", extendedMatchers.pass);
  defineMatcher("fail", "", extendedMatchers.fail);
  defineMatcher("toBeArrayOfSize", "", extendedMatchers.arrayOfSize);
  defineMatcher("toEqualIgnoringWhitespace", "expected", extendedMatchers.ignoringWhitespace);

  function iterableItems(value) {
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== "function") return null;
    return Array.from(value);
  }

  // Bun's contain_matcher. `test` settles to a pass boolean, or to { pass, received } when the
  // failure prints another value in place of the received one.
  function defineContainMatcher(name, test, verb = "contain") {
    defineMatcher(name, "expected", (ctx, received, expected) => {
      return matcherSupport.settle(test(received, expected), outcome => {
        const shown = typeof outcome === "object" && outcome !== null ? outcome : { pass: outcome, received };
        if (!failed(ctx, shown.pass)) return null;
        return { body: `\n\nExpected to ${ctx.not ? "not " : ""}${verb}: ${inspect(expected)}\nReceived: ${inspect(shown.received)}\n` };
      });
    });
  }

  defineContainMatcher("toContain", (received, expected) => {
    if (typeof received === "string") return received.includes(String(expected));
    const items = iterableItems(received);
    return items !== null && items.some((item) => item === expected);
  });

  defineContainMatcher("toContainEqual", (received, expected) => {
    const items = iterableItems(received);
    return items !== null && matcherSupport.some(items, item => equals(item, expected, false));
  });

  defineContainMatcher("toContainKey", (received, key) => {
    if (!isObjectLike(received)) throw new TypeError(`Expected value must be an object\nReceived: ${inspect(received)}`);
    return Object.prototype.hasOwnProperty.call(received, key);
  });

  function requireArray(expected, name) {
    if (!Array.isArray(expected)) throw new TypeError(`Expected expected to be a array for '${name}'.`);
  }

  function containsKeys(received, keys, any, name) {
    requireArray(keys, name);
    if (!isObjectLike(received)) return !any && keys.length === 0;
    for (const key of keys) {
      const own = Object.prototype.hasOwnProperty.call(received, key);
      if (own === any) return any;
    }
    return !any;
  }

  defineContainMatcher("toContainKeys", (received, keys) => containsKeys(received, keys, false, "toContainKeys"));
  defineContainMatcher("toContainAnyKeys", (received, keys) => containsKeys(received, keys, true, "toContainAnyKeys"));

  // The object matchers below follow Bun's expect/toContain*.rs: own enumerable string keys or
  // Object.values, each entry compared with toEqual's equality.
  function containsEvery(values, expected) {
    return matcherSupport.every(expected, item => matcherSupport.some(values, value => equals(value, item, false)));
  }

  defineContainMatcher("toContainAllKeys", (received, expected) => {
    requireArray(expected, "toContainAllKeys");
    // Object.keys throws for null and undefined, as Bun's toObject does.
    const keys = Object.keys(received);
    if (keys.length !== expected.length) return { pass: false, received: keys };
    const pass = matcherSupport.every(keys, key => matcherSupport.some(expected, item => equals(key, item, false)));
    return matcherSupport.settle(pass, matched => ({ pass: matched, received: keys }));
  }, "contain all keys");

  defineContainMatcher("toContainValue", (received, expected) => {
    if (received === null || received === undefined) return false;
    return matcherSupport.some(Object.values(received), value => equals(value, expected, false));
  });

  defineContainMatcher("toContainValues", (received, expected) => {
    requireArray(expected, "toContainValues");
    if (received === null || received === undefined) return true;
    return containsEvery(Object.values(received), expected);
  });

  defineContainMatcher("toContainAllValues", (received, expected) => {
    requireArray(expected, "toContainAllValues");
    if (received === null || received === undefined) return false;
    const values = Object.values(received);
    // Bun requires equal counts and at least one value: an empty expectation never passes.
    if (values.length !== expected.length || expected.length === 0) return false;
    return containsEvery(values, expected);
  }, "contain all values");

  defineContainMatcher("toContainAnyValues", (received, expected) => {
    requireArray(expected, "toContainAnyValues");
    if (received === null || received === undefined) return false;
    const values = Object.values(received);
    return matcherSupport.some(expected, item => matcherSupport.some(values, value => equals(value, item, false)));
  }, "contain any of the following values");

  defineMatcher("toIncludeRepeated", "expected", (ctx, received, ...args) => {
    if (args.length < 2) throw new TypeError("toIncludeRepeated() requires 2 arguments");
    const [substring, count] = args;
    if (typeof substring !== "string") throw new Error("toIncludeRepeated() requires the first argument to be a string");
    if (!Number.isInteger(count) || Object.is(count, -0)) throw new Error("toIncludeRepeated() requires the second argument to be a number");
    if (typeof received !== "string") throw new Error("toIncludeRepeated() requires the expect(value) to be a string");
    if (substring.length === 0) throw new Error("toIncludeRepeated() requires the first argument to be a non-empty string");
    let actual = 0;
    let at = received.indexOf(substring);
    while (at !== -1) {
      actual++;
      at = received.indexOf(substring, at + substring.length);
    }
    const expected = count >>> 0;
    if (!failed(ctx, actual === expected)) return null;
    const prefix = ctx.not ? (expected === 0 ? "Expected to include: " : "Expected not to include: ") : (expected === 0 ? "Expected to not include: " : "Expected to include: ");
    const times = expected > 1 ? ` ${inspect(count)} times ` : ctx.not ? " " : "";
    return { body: `\n\n${prefix}${inspect(substring)}${times}\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toHaveLength", "expected", (ctx, received, expected) => {
    const length = received === null || received === undefined ? undefined : received.length;
    if (!failed(ctx, length === expected)) return null;
    if (ctx.not) return { body: `\n\nExpected length: not ${expected}\n` };
    return { body: `\n\nExpected length: ${expected}\nReceived length: ${length}\n` };
  });

  defineMatcher("toBeEmpty", "", (ctx, received) => {
    if (!failed(ctx, matcherSupport.empty(received))) return null;
    return { body: `\n\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toBeOneOf", "expected", (ctx, received, list) => {
    const items = iterableItems(list) || [];
    return matcherSupport.settle(matcherSupport.some(items, item => equals(received, item, false)), pass => {
      if (!failed(ctx, pass)) return null;
      const not = ctx.not ? "not " : "";
      return { body: `\n\nExpected: ${not}one of ${inspect(list)}\nReceived: ${inspect(received)}\n` };
    });
  });

  const MISSING = { found: false };

  // One step of Bun's path lookup: the value converts to an object (null and undefined throw,
  // as JSC's toObject does) and the key may be inherited.
  function lookupKey(value, key) {
    if (value === null || value === undefined) throw new TypeError(`${value} is not an object`);
    const object = Object(value);
    return key in object ? { found: true, value: object[key] } : MISSING;
  }

  function isPathSeparator(char) {
    return char === "[" || char === "]" || char === ".";
  }

  // Bun's getIfPropertyExistsFromPath (bindings.cpp). As in Jest, brackets are skipped, and a
  // "." at the start or end of the path, or doubled, looks up the empty-string key. An array
  // path names each key: strings and numbers only.
  function lookupPath(object, path) {
    if (Array.isArray(path)) return lookupKeys(object, path);
    const text = String(path);
    if (text === "") return lookupKey(object, "");
    let current = { found: true, value: object };
    if (text[0] === ".") current = lookupKey(object, "");
    let start = 0;
    let named = false;
    while (current.found && start < text.length) {
      const skipped = skipSeparators(text, start, current.value, named);
      if (skipped.done) return skipped.result;
      let end = skipped.next;
      while (end < text.length && !isPathSeparator(text[end])) end++;
      current = lookupKey(skipped.current.value, text.slice(skipped.next, end));
      named = true;
      start = end;
    }
    return current;
  }

  // Skips a run of separators from `start`. Two dots in a row look up the empty-string key;
  // a path that ends in separators ends the lookup, with the empty-string key after a final ".".
  function skipSeparators(text, start, value, named) {
    let index = start;
    let current = { found: true, value };
    while (isPathSeparator(text[index])) {
      const char = text[index++];
      if (index === text.length) {
        if (char === ".") return { done: true, result: lookupKey(current.value, "") };
        return { done: true, result: named ? current : MISSING };
      }
      if (char === "." && text[index] === ".") current = lookupKey(current.value, "");
      if (!current.found) return { done: true, result: current };
    }
    return { done: false, current, next: index };
  }

  function lookupKeys(object, keys) {
    let current = { found: true, value: object };
    for (const key of keys) {
      if (typeof key !== "string" && typeof key !== "number") return MISSING;
      current = lookupKey(current.value, String(key));
      if (!current.found) return current;
    }
    return current;
  }

  defineMatcher("toHaveProperty", "path", (ctx, received, path, ...rest) => {
    const hasValue = rest.length > 0;
    const expectedValue = rest[0];
    const params = hasValue ? "path, value" : "path";
    if (typeof path !== "string" && !Array.isArray(path)) throw new Error("Expected path must be a string or an array");
    const lookup = received === null || received === undefined ? MISSING : lookupPath(received, path);
    const pass = lookup.found && (!hasValue || equals(lookup.value, expectedValue, false));
    return matcherSupport.settle(pass, matched => {
      if (!failed(ctx, matched)) return null;
      const shownPath = inspect(path);
      if (ctx.not && hasValue) return { params, body: `\n\nExpected path: ${shownPath}\n\nExpected value: not ${inspect(expectedValue)}\n` };
      if (ctx.not) return { params, body: `\n\nExpected path: not ${shownPath}\n\nReceived value: ${inspect(lookup.value)}\n` };
      if (hasValue && lookup.found) return { params, body: `\n\n${formatDiff(lookup.value, expectedValue, false)}\n` };
      if (hasValue) return { params, body: `\n\nExpected path: ${shownPath}\n\nExpected value: ${inspect(expectedValue)}\n\nUnable to find property\n` };
      return { params, body: `\n\nExpected path: ${shownPath}\n\nUnable to find property\n` };
    });
  });

  defineMatcher("toMatch", "expected", (ctx, received, expected) => {
    if (typeof received !== "string") {
      return { body: `\n\nMatcher error: received value must be a string\nReceived: ${inspect(received)}\n` };
    }
    let pass;
    if (typeof expected === "string") pass = received.includes(expected);
    else {
      expected.lastIndex = 0;
      pass = expected.test(received);
    }
    if (!failed(ctx, pass)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected substring or pattern: ${not}${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toBeInstanceOf", "expected", (ctx, received, expected) => {
    if (!failed(ctx, isObjectLike(received) && received instanceof expected)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected constructor: ${not}${inspect(expected)}\nReceived value: ${inspect(received)}\n` };
  });

  function typeOfValue(value) {
    if (typeof value === "function") return "function";
    if (value === null || typeof value === "object") return "object";
    return typeof value;
  }

  defineMatcher("toBeTypeOf", "", (ctx, received, expected) => {
    const type = typeOfValue(received);
    if (!failed(ctx, type === expected)) return null;
    if (ctx.not) return { body: `\n\nExpected type: not ${inspect(expected)}\n\nReceived value: ${inspect(received)}\n` };
    return { body: `\n\nExpected type: ${inspect(expected)}\nReceived type: ${inspect(type)}\nReceived value: ${inspect(received)}\n` };
  });

  defineMatcher("toSatisfy", "predicate", (ctx, received, predicate) => {
    if (!failed(ctx, !!predicate(received))) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected: ${not}${inspect(predicate)}\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toStartWith", "expected", (ctx, received, expected) => {
    if (!failed(ctx, typeof received === "string" && received.startsWith(expected))) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected to ${not}start with: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toEndWith", "expected", (ctx, received, expected) => {
    if (!failed(ctx, typeof received === "string" && received.endsWith(expected))) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected to ${not}end with: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toInclude", "expected", (ctx, received, expected) => {
    if (!failed(ctx, typeof received === "string" && received.includes(expected))) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected to ${not}include: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
  });

  // ── toThrow ──

  const throwOutcome = matcherSupport.throwOutcome;

  // Bun reads `.message` from thrown objects and stringifies primitives.
  function thrownMessage(value) {
    return isObjectLike(value) ? value.message : String(value);
  }

  function throwMatches(value, expected) {
    const message = thrownMessage(value);
    if (typeof expected === "string") return message !== undefined && String(message).includes(expected);
    if (expected instanceof RegExp) {
      expected.lastIndex = 0;
      return message !== undefined && expected.test(String(message));
    }
    if (isAsymmetric(expected)) return expected.asymmetricMatch(value);
    if (isObjectLike(expected) && "message" in expected) return Object.is(message, expected.message);
    return isObjectLike(value) && value instanceof expected;
  }

  // Bun treats `toThrow("")` and `toThrow(expect.any(Ctor))`'s constructor specially.
  function normalizeThrowExpectation(expected) {
    if (expected === "") return undefined;
    if (expected instanceof AnyMatcher) return expected.sample;
    return expected;
  }

  function defineThrowMatcher(name) {
    defineMatcher(name, "expected", (ctx, received, rawExpected) => {
      if (rawExpected !== undefined && (rawExpected === null || (!isObjectLike(rawExpected) && typeof rawExpected !== "string"))) {
        throw new Error(`Expected value must be string or Error: ${inspect(rawExpected)}`);
      }
      const expected = normalizeThrowExpectation(rawExpected);
      return matcherSupport.settle(throwOutcome(ctx, received), (outcome) => {
          if (outcome.invalid) throw new Error("Expected value must be a function");
          if (ctx.not) return notThrowFailure(outcome, expected);
          if (!outcome.threw) return didNotThrowFailure(outcome, expected);
          return wrongThrowFailure(outcome.value, expected);
      });
    });
  }

  defineThrowMatcher("toThrow");
  defineThrowMatcher("toThrowError");

  function notThrowFailure(outcome, expected) {
    if (!outcome.threw) return null;
    const value = outcome.value;
    if (expected === undefined) {
      if (value instanceof Error) return { params: "", body: `\n\nError name: ${inspect(value.name)}\nError message: ${inspect(value.message)}\n` };
      return { params: "", body: `\n\nThrown value: ${inspect(value)}\n` };
    }
    return matcherSupport.settle(throwMatches(value, expected), pass => {
      if (!pass) return null;
      const message = inspect(thrownMessage(value));
      if (typeof expected === "string") return { body: `\n\nExpected substring: not ${inspect(expected)}\nReceived message: ${message}\n` };
      if (expected instanceof RegExp) return { body: `\n\nExpected pattern: not ${inspect(expected)}\nReceived message: ${message}\n` };
      if (isObjectLike(expected) && "message" in expected) return { body: `\n\nExpected message: not ${inspect(expected.message)}\n` };
      return { body: `\n\nExpected constructor: not ${expected.name}\n\nReceived message: ${message}\n` };
    });
  }

  function didNotThrowFailure(outcome, expected) {
    const tail = `Received function did not throw\nReceived value: ${inspect(outcome.value)}\n`;
    if (expected === undefined) return { params: "", body: `\n\n${tail}` };
    if (typeof expected === "string") return { body: `\n\nExpected substring: ${inspect(expected)}\n\n${tail}` };
    if (expected instanceof RegExp) return { body: `\n\nExpected pattern: ${inspect(expected)}\n\n${tail}` };
    if (isObjectLike(expected) && "message" in expected) return { body: `\n\nExpected message: ${inspect(expected.message)}\n\n${tail}` };
    return { body: `\n\nExpected constructor: ${expected.name}\n\n${tail}` };
  }

  function wrongThrowFailure(value, expected) {
    if (expected === undefined) return null;
    return matcherSupport.settle(throwMatches(value, expected), pass => {
      if (pass) return null;
      const message = thrownMessage(value);
      const hasMessage = message !== undefined;
      const receivedLine = hasMessage ? `Received message: ${inspect(message)}\n` : `Received value: ${inspect(value)}`;
      if (typeof expected === "string") return { body: `\n\nExpected substring: ${inspect(expected)}\n${receivedLine}` };
      if (expected instanceof RegExp) return { body: `\n\nExpected pattern: ${inspect(expected)}\n${receivedLine}` };
      if (isAsymmetric(expected)) return { body: `\n\nExpected value: ${inspect(expected)}\nReceived value: ${inspect(value)}\n` };
      if (isObjectLike(expected) && "message" in expected) {
        const line = hasMessage ? `Received message: ${inspect(message)}` : `Received value: ${inspect(value)}`;
        return { body: `\n\nExpected message: ${inspect(expected.message)}\n${line}\n` };
      }
      const receivedCtor = isObjectLike(value) && value.constructor ? value.constructor.name : typeof value;
      const last = hasMessage ? `Received message: ${inspect(message)}` : `Received value: ${inspect(value)}`;
      return { body: `\n\nExpected constructor: ${expected.name}\nReceived constructor: ${receivedCtor}\n\n${last}\n` };
    });
  }

  // ── mock matchers ──

  function mockRecord(received, withSignature) {
    if (isMock(received)) return received.mock;
    if (withSignature) {
      return { failure: { body: `\n\nMatcher error: received value must be a mock function\nReceived: ${inspect(received)}` } };
    }
    throw new Error(`Expected value must be a mock function: ${inspect(received)}`);
  }

  function callsEqual(args, expected) {
    return args.length === expected.length && matcherSupport.every(args, (arg, i) => equals(arg, expected[i], false));
  }

  function mockMatcherCount(value, minimum) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
      throw new TypeError(`Expected count must be an integer greater than or equal to ${minimum}`);
    }
  }

  function mockMatcherNoArguments(args) {
    if (args.length) throw new TypeError("This mock matcher does not accept arguments");
  }

  defineMatcher("toHaveBeenCalled", "", (ctx, received, ...args) => {
    mockMatcherNoArguments(args);
    const record = mockRecord(received);
    const count = record.calls.length;
    if (!failed(ctx, count > 0)) return null;
    if (ctx.not) return { body: `\n\nExpected number of calls: 0\nReceived number of calls: ${count}\n` };
    return { body: `\n\nExpected number of calls: >= 1\nReceived number of calls: ${count}\n` };
  });

  defineMatcher("toHaveBeenCalledOnce", "", (ctx, received, ...args) => {
    mockMatcherNoArguments(args);
    const count = mockRecord(received).calls.length;
    if (!failed(ctx, count === 1)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected number of calls: ${not}1\nReceived number of calls: ${count}\n` };
  });

  defineMatcher("toHaveBeenCalledTimes", "expected", (ctx, received, times) => {
    mockMatcherCount(times, 0);
    const count = mockRecord(received).calls.length;
    if (!failed(ctx, count === times)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected number of calls: ${not}${times}\nReceived number of calls: ${count}\n` };
  });

  function allCallsList(calls) {
    return calls.map((args, i) => `              ${i + 1}: ${inspect(args)}`).join("\n");
  }

  defineMatcher("toHaveBeenCalledWith", "...expected", (ctx, received, ...expected) => {
    const record = mockRecord(received, true);
    if (record.failure) return record.failure;
    const calls = record.calls;
    return matcherSupport.settle(matcherSupport.some(calls, args => callsEqual(args, expected)), pass => {
      if (!failed(ctx, pass)) return null;
      if (ctx.not) return { body: `\n\nExpected mock function not to have been called with: ${inspect(expected)}\nBut it was.` };
      if (calls.length === 0) return { body: `\n\nExpected: ${inspect(expected)}\nBut it was not called.` };
      if (calls.length === 1) return { body: `\n\n${formatDiff(calls[0], expected, false)}\n` };
      return { body: `\n\n    Expected: ${inspect(expected)}\n    Received:\n${allCallsList(calls)}\n\n    Number of calls: ${calls.length}\n` };
    });
  });

  defineMatcher("toHaveBeenLastCalledWith", "...expected", (ctx, received, ...expected) => {
    const record = mockRecord(received, true);
    if (record.failure) return record.failure;
    const calls = record.calls;
    const last = calls[calls.length - 1];
    return matcherSupport.settle(last !== undefined && callsEqual(last, expected), pass => {
      if (!failed(ctx, pass)) return null;
      if (ctx.not) return { body: `\n\nExpected last call not to be with: ${inspect(expected)}\nBut it was.` };
      if (calls.length === 0) return { body: `\n\nExpected: ${inspect(expected)}\nBut it was not called.` };
      return { body: `\n\n${formatDiff(last, expected, false)}\n` };
    });
  });

  defineMatcher("toHaveBeenNthCalledWith", "n, ...expected", (ctx, received, n, ...expected) => {
    mockMatcherCount(n, 1);
    const record = mockRecord(received, true);
    if (record.failure) return record.failure;
    const calls = record.calls;
    const call = calls[n - 1];
    return matcherSupport.settle(call !== undefined && callsEqual(call, expected), pass => {
      if (!failed(ctx, pass)) return null;
      if (ctx.not) return { body: `\n\nExpected call #${n} not to be with: ${inspect(expected)}\nBut it was.` };
      if (call === undefined) {
        return { body: `\n\nThe mock function was called ${calls.length} time${calls.length === 1 ? "" : "s"}, but call ${n} was requested.` };
      }
      return { body: `\n\nCall #${n}:\n${formatDiff(call, expected, false)}\n` };
    });
  });

  function returnCounts(record) {
    const returned = [];
    for (const result of record.results) {
      if (!isObjectLike(result)) throw new TypeError("Expected value must be a mock function with returns");
      if (result.type === "return") returned.push(result);
    }
    return { returned, calls: record.results.length };
  }

  defineMatcher("toHaveReturned", "expected", (ctx, received, ...args) => {
    mockMatcherNoArguments(args);
    const { returned, calls } = returnCounts(mockRecord(received));
    if (!failed(ctx, returned.length > 0)) return null;
    if (ctx.not) return { body: `\n\nExpected number of succesful returns: 0\nReceived number of succesful returns: ${returned.length}\n` };
    return { body: `\n\nExpected number of succesful returns: >= 1\nReceived number of succesful returns:    ${returned.length}\nReceived number of calls:                ${calls}\n` };
  });

  defineMatcher("toHaveReturnedTimes", "expected", (ctx, received, times) => {
    mockMatcherCount(times, 0);
    const { returned } = returnCounts(mockRecord(received));
    if (!failed(ctx, returned.length === times)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected number of succesful returns: ${not}${times}\nReceived number of succesful returns: ${returned.length}\n` };
  });

  defineMatcher("toHaveReturnedWith", "expected", (ctx, received, expected) => {
    const record = mockRecord(received);
    const { returned, calls } = returnCounts(record);
    return matcherSupport.settle(matcherSupport.some(returned, r => equals(r.value, expected, false)), pass => {
      if (!failed(ctx, pass)) return null;
      if (ctx.not) return { body: `\n\nExpected mock function not to have returned: ${inspect(expected)}\n` };
      if (calls === 1 && returned.length === 1) {
        const value = returned[0].value;
        if (typeof value === "string" && typeof expected === "string") return { body: `\n\n${formatDiff(value, expected, false)}\n` };
        return { body: `\n\nExpected: ${inspect(expected)}\nReceived: ${inspect(value)}` };
      }
      const list = record.results.map((r, i) => `              ${i + 1}: ${inspect(r.value)}`).join("\n");
      return { body: `\n\n    Expected: ${inspect(expected)}\n    Received:\n${list}\n\n    Number of returns: ${returned.length}\n` };
    });
  });

  defineMatcher("toHaveLastReturnedWith", "expected", (ctx, received, expected) => {
    const results = mockRecord(received).results;
    const last = results[results.length - 1];
    const pass = last !== undefined && last.type === "return" && equals(last.value, expected, false);
    return matcherSupport.settle(pass, matched => {
      if (!failed(ctx, matched)) return null;
      const not = ctx.not ? "not " : "";
      return { body: `\n\nExpected: ${not}${inspect(expected)}\nReceived: ${inspect(last && last.value)}\n` };
    });
  });

  defineMatcher("toHaveNthReturnedWith", "n, expected", (ctx, received, nth, expected) =>
    matcherSupport.nthReturned({ not: ctx.not, results: mockRecord(received).results, nth, expected, equals, inspect, formatDiff }));

  // Jest's aliases.
  for (const [alias, target] of [
    ["toBeCalled", "toHaveBeenCalled"],
    ["toBeCalledTimes", "toHaveBeenCalledTimes"],
    ["toBeCalledWith", "toHaveBeenCalledWith"],
    ["lastCalledWith", "toHaveBeenLastCalledWith"],
    ["toHaveBeenLastCalledWith", "toHaveBeenLastCalledWith"],
    ["nthCalledWith", "toHaveBeenNthCalledWith"],
    ["toReturn", "toHaveReturned"],
    ["toReturnWith", "toHaveReturnedWith"],
    ["nthReturnedWith", "toHaveNthReturnedWith"],
  ]) {
    if (!(alias in expectProto)) expectProto[alias] = expectProto[target];
  }

  // ───────────────────────────── snapshots ─────────────────────────────

  const snapshots = { total: 0, passed: 0, failed: 0, added: 0 };
  const SNAPSHOT_HEADER = "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots\n";

  function snapshotString(value) {
    const text = `"${value.replace(/\r\n?/g, "\n")}"`;
    return text.includes("\n") ? `\n${text}\n` : text;
  }

  function snapshotSummary() {
    if (snapshots.added === 0 && snapshots.failed === 0) return ` ${snapshots.total} snapshots, ${summary.expectations} expect() calls\n`;
    const counts = [];
    if (snapshots.passed) counts.push(`${snapshots.passed} passed`);
    if (snapshots.added) counts.push(`${counts.length ? "" : "+"}${snapshots.added} added`);
    if (snapshots.failed) counts.push(`${snapshots.failed} failed`);
    return `snapshots: ${counts.join(", ")}\n`;
  }

  let snapshotCI;
  function isSnapshotCI() {
    if (snapshotCI !== undefined) return snapshotCI;
    const env = globalThis.process.env;
    if (env.CI !== undefined && ["", "0", "false", "no", "off"].includes(env.CI.toLowerCase())) return (snapshotCI = false);
    const names = "BUILD_ID BUILD_NUMBER CI CI_APP_ID CI_BUILD_ID CI_BUILD_NUMBER CI_NAME CONTINUOUS_INTEGRATION RUN_ID AGOLA_GIT_REF AC_APPCIRCLE APPVEYOR CODEBUILD_BUILD_ARN TF_BUILD bamboo_planKey BITBUCKET_COMMIT BITRISE_IO BUDDY_WORKSPACE_ID BUILDKITE CIRCLECI CIRRUS_CI CF_PAGES WORKERS_CI CF_BUILD_ID CM_BUILD_ID DRONE DSARI EARTHLY_CI EAS_BUILD GERRIT_PROJECT GITEA_ACTIONS GITHUB_ACTIONS GITLAB_CI GO_PIPELINE_LABEL BUILDER_OUTPUT HARNESS_BUILD_ID HUDSON_URL LAYERCI MAGNUM NETLIFY NEVERCODE PROW_JOB_ID RELEASE_BUILD_ID RENDER SAILCI SCREWDRIVER SEMAPHORE STRIDER TEAMCITY_VERSION TRAVIS VELA NOW_BUILDER VERCEL APPCENTER_BUILD_ID CI_XCODE_PROJECT XCS".split(" ");
    snapshotCI = names.some((name) => env[name] !== undefined) || (env.NODE !== undefined && env.NODE.includes("/app/.heroku/node/bin/node"));
    return snapshotCI;
  }

  function snapshotArguments(args, inline) {
    if (args.length === 0) return { properties: undefined, expected: undefined };
    if (args.length === 1 && typeof args[0] === "string") return { properties: undefined, expected: args[0] };
    if (args[0] === null || typeof args[0] !== "object") {
      throw new Error(args.length === 1 ? "\n\nMatcher error: Expected first argument to be a string or object\n" : "\n\nMatcher error: Expected properties must be an object\n");
    }
    if (args.length > 1 && typeof args[1] !== "string" && !inline) throw new Error("\n\nMatcher error: Expected second argument to be a string\n");
    return { properties: args[0], expected: typeof args[1] === "string" ? args[1] : undefined };
  }

  function reserveSnapshot(origin, matcher, args) {
    if (!origin.test) return null;
    const inline = matcher.endsWith("InlineSnapshot");
    const hint = inline ? "" : typeof args[0] === "string" ? args[0] : args[1];
    return { file: origin.test.file, name: nextSnapshotName(origin.test, hint) };
  }

  function prepareSnapshot(ctx, received, args, inline) {
    if (!ctx.origin.test) return { failure: { params: "", body: "\n\nMatcher error: Snapshot matchers cannot be used outside of a test\n" } };
    const parsed = snapshotArguments(args, inline);
    if (parsed.properties !== undefined && !isObjectLike(received)) {
      return { failure: { params: "properties, hint", body: "\n\nMatcher error: received values must be an object when the matcher has properties\n" } };
    }
    const comparison = parsed.properties === undefined || matchesObject(received, parsed.properties);
    return matcherSupport.settle(comparison, pass => {
        if (ctx.origin.invocation?.settled) return { cancelled: true };
        if (!pass) return { failure: { params: "propertyMatchers", body: `\n\nExpected propertyMatchers to match properties from received object\n\nReceived: ${inspect(received)}\n` } };
        if (parsed.properties !== undefined) replaceSnapshotProperties(received, parsed.properties, new Set());
        return Object.assign(parsed, { text: prettyValue(received, "", new Set(), true) });
    });
  }

  function replaceSnapshotProperties(received, properties, seen) {
    if (!isObjectLike(received) || !isObjectLike(properties) || seen.has(properties)) return;
    seen.add(properties);
    for (const key of Object.keys(properties)) {
      if (isAsymmetric(properties[key])) received[key] = properties[key];
      else replaceSnapshotProperties(received[key], properties[key], seen);
    }
  }

  function nextSnapshotName(origin, hint) {
    const { test, file } = origin;
    const name = displayNames(test).concat([test.name || "(unnamed)"]).join(" ") + (hint ? `: ${hint}` : "");
    const count = (file.snapshotCounts.get(name) || 0) + 1;
    file.snapshotCounts.set(name, count);
    return `${name} ${count}`;
  }

  function snapshotFS() {
    return internal.require("node_fs").fs;
  }

  function fileSnapshots(file) {
    if (file.snapshots) return file.snapshots;
    const path = internal.require("path");
    const name = path.join(path.dirname(file.path), "__snapshots__", path.basename(file.path) + ".snap");
    const state = { path: name, values: new Map(), text: SNAPSHOT_HEADER, dirty: false };
    file.snapshots = state;
    if (options.updateSnapshots || !snapshotFS().existsSync(name)) return state;
    state.text = snapshotFS().readFileSync(name, "utf8");
    try {
      parseSnapshotFile(state);
    } catch {
      throw new Error(`Failed to parse snapshot file for: ${file.path}`);
    }
    return state;
  }

  function parseSnapshotFile(state) {
    const tokens = snapshotTokens(state.text);
    for (let i = 0; i < tokens.length;) {
      if (tokens[i].text === ";") { i++; continue; }
      const entry = tokens.slice(i, i + 6);
      if (entry.length !== 6 || entry[0].text !== "exports" || entry[1].text !== "[" || entry[3].text !== "]" || entry[4].text !== "=") throw new Error("Invalid snapshot entry");
      state.values.set(snapshotLiteral(entry[2].text), snapshotLiteral(entry[5].text));
      i += 6;
    }
  }

  function escapeSnapshot(text) {
    return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")
      // oxlint-disable-next-line no-control-regex -- Protocol parsing intentionally matches control bytes.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (ch) => ({ "\b": "\\b", "\v": "\\v", "\f": "\\f" })[ch] || `\\x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  }

  function addFileSnapshot(state, name, text) {
    state.values.set(name, text);
    state.text += `\nexports[\`${escapeSnapshot(name)}\`] = \`${escapeSnapshot(text)}\`;\n`;
    state.dirty = true;
    snapshots.added++;
  }

  function matchFileSnapshot(ctx, received, ...args) {
    return matcherSupport.settle(prepareSnapshot(ctx, received, args, false), prepared => {
      if (prepared.cancelled) return null;
      if (prepared.failure) return prepared.failure;
      const state = fileSnapshots(ctx.snapshot.file);
      const name = ctx.snapshot.name;
      snapshots.total++;
      if (state.values.has(name)) return compareSnapshot(prepared.text, state.values.get(name));
      if (isSnapshotCI() && !options.updateSnapshots) {
        throw new Error(`Snapshot creation is disabled in CI environments unless --update-snapshots is used\nTo override, set the environment variable CI=false.\n\nSnapshot name: "${name}"\nReceived: ${prepared.text}`);
      }
      addFileSnapshot(state, name, prepared.text);
      return null;
    });
  }

  defineMatcher("toMatchSnapshot", "expected", matchFileSnapshot);

  function compareSnapshot(received, expected) {
    if (received === expected) { snapshots.passed++; return null; }
    snapshots.failed++;
    return { body: `\n\n${diffStrings(received, expected)}\n` };
  }

  function trimInlineSnapshot(text) {
    const lines = text.split("\n");
    if (lines.length < 3 || !/^[\t ]*$/.test(lines[0]) || !/^[\t ]*$/.test(lines[lines.length - 1])) return text;
    const indent = /^[\t ]*/.exec(lines[1])[0];
    if (!indent.length) return text;
    const middle = lines.slice(1, -1);
    if (middle.some((line) => line.trim() !== "" && !line.startsWith(indent))) return text;
    return "\n" + middle.map((line) => line.startsWith(indent) ? line.slice(indent.length) : "").join("\n") + "\n";
  }

  function matchInlineSnapshot(ctx, received, ...args) {
    return matcherSupport.settle(prepareSnapshot(ctx, received, args, true), prepared => {
      if (prepared.cancelled) return null;
      if (prepared.failure) return prepared.failure;
      snapshots.total++;
      const expected = prepared.expected === undefined ? undefined : trimInlineSnapshot(prepared.expected);
      if (expected === prepared.text) { snapshots.passed++; return null; }
      if (expected !== undefined && !options.updateSnapshots) return compareSnapshot(prepared.text, expected);
      if (isSnapshotCI() && !options.updateSnapshots) {
        return { params: "", body: `\n\nMatcher error: Inline snapshot creation is disabled in CI environments unless --update-snapshots is used.\nTo override, set the environment variable CI=false.\n\nReceived: ${prepared.text}` };
      }
      queueInlineSnapshot(ctx.snapshot.file, ctx.error, prepared);
      if (expected === undefined) snapshots.added++;
      else snapshots.passed++;
      return null;
    });
  }

  defineMatcher("toMatchInlineSnapshot", "expected", matchInlineSnapshot);

  function defineErrorSnapshotMatcher(name, inline) {
    defineMatcher(name, "expected", (ctx, received, ...args) => {
      if (args.length > 1) throw new Error("\n\nMatcher error: Expected zero or one arguments\n");
      if (args.length === 1 && typeof args[0] !== "string") throw new Error("\n\nMatcher error: Expected first argument to be a string\n");
      return matcherSupport.settle(typeof received === "function" ? throwOutcome({}, received) : throwOutcome(ctx, received), (outcome) => {
          if (outcome.invalid) throw new Error("Expected value must be a function");
          const threw = outcome.threw || outcome.value instanceof Error || (ctx.promise && typeof received !== "function");
          if (!threw) return { params: "", body: "\n\nMatcher error: Received function did not throw\n" };
          const message = outcome.value instanceof Error ? outcome.value.message || undefined : undefined;
          return inline ? matchInlineSnapshot(ctx, message, ...args) : matchFileSnapshot(ctx, message, ...args);
      });
    });
  }

  defineErrorSnapshotMatcher("toThrowErrorMatchingInlineSnapshot", true);
  defineErrorSnapshotMatcher("toThrowErrorMatchingSnapshot", false);

  function inlineCaller(error) {
    for (const raw of String(error.stack || "").split("\n")) {
      const frame = inlineCallerFrame(raw.trim());
      if (frame && !frame.file.startsWith("bun-wasm:")) return frame;
    }
    throw new Error("Failed to update inline snapshot: caller source location is unavailable");
  }

  function inlineCallerFrame(line) {
    let match;
    if (line.startsWith("at ")) {
      const body = line.slice(3);
      const named = /^.*? \((.*)\)$/.exec(body);
      match = /^(.*):(\d+):(\d+)$/.exec(named ? named[1] : body);
      return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : null;
    }
    match = /^.*?@(.*):(\d+):(\d+)$/.exec(line);
    if (!match) return null;
    const file = internal.displayName ? internal.displayName(match[1]) : match[1];
    const mapped = internal.mapPosition && internal.mapPosition(file, Number(match[2]), Number(match[3]));
    return { file, line: mapped ? mapped[0] : Number(match[2]), column: mapped ? mapped[1] : Number(match[3]) };
  }

  function queueInlineSnapshot(file, error, prepared) {
    const caller = inlineCaller(error);
    if (caller.file !== file.path) throw new Error(`Inline snapshot matchers must be called from the test file: ${file.path}\nCalled from file: ${caller.file}`);
    if (file.source === undefined) file.source = snapshotFS().readFileSync(file.path, "utf8");
    if (!file.inlineSites) file.inlineSites = inlineSnapshotSites(file.source);
    const start = file.source.split("\n").slice(0, caller.line - 1).reduce((sum, line) => sum + line.length + 1, 0);
    const offset = start + caller.column - 1;
    const lineEnd = file.source.indexOf("\n", start);
    const sites = file.inlineSites.filter((site) => site.name >= start && site.name <= (lineEnd < 0 ? file.source.length : lineEnd));
    sites.sort((a, b) => inlineSiteDistance(a, offset) - inlineSiteDistance(b, offset));
    const site = sites[0];
    if (!site) throw new Error(`Failed to update inline snapshot: no matcher at ${caller.file}:${caller.line}:${caller.column}`);
    const previous = file.inlineWrites.get(site.name);
    if (previous && previous.text !== prepared.text) throw new Error("Failed to update inline snapshot: Multiple inline snapshots at the same call must all have the same value");
    file.inlineWrites.set(site.name, { site, text: prepared.text, properties: prepared.properties !== undefined });
  }

  function inlineSiteDistance(site, offset) {
    if (offset < site.name) return site.name - offset;
    return Math.max(0, offset - site.close - 1);
  }

  function inlineSnapshotSites(source) {
    const tokens = snapshotTokens(source);
    const sites = [];
    for (let i = 1; i < tokens.length - 1; i++) {
      if ((tokens[i].text !== "toMatchInlineSnapshot" && tokens[i].text !== "toThrowErrorMatchingInlineSnapshot") || tokens[i - 1].text !== "." || tokens[i + 1].text !== "(") continue;
      const site = inlineSiteArguments(tokens, i);
      if (site) sites.push(site);
    }
    return sites;
  }

  function inlineSiteArguments(tokens, index) {
    const site = { name: tokens[index].start, open: tokens[index + 1].end, close: 0, commas: [], arguments: [] };
    let depth = 0;
    let argument = index + 2;
    for (let i = argument; i < tokens.length; i++) {
      const text = tokens[i].text;
      if (depth === 0 && (text === ")" || text === ",")) {
        captureInlineArgument(site, tokens, argument, i);
        if (text === ")") return site;
        argument = i + 1;
      }
      if (text === "(" || text === "[" || text === "{") depth++;
      if (text === ")" || text === "]" || text === "}") depth--;
    }
    return null;
  }

  function captureInlineArgument(site, tokens, start, end) {
    if (end > start) site.arguments.push({ start: tokens[start].start, end: tokens[end - 1].end });
    if (tokens[end].text === ")") site.close = tokens[end].start;
    else site.commas.push(tokens[end].start);
  }

  function inlineReplacement(source, write) {
    const { site, text, properties } = write;
    const lineStart = source.lastIndexOf("\n", site.name) + 1;
    const indent = /^[\t ]*/.exec(source.slice(lineStart))[0];
    const escaped = escapeSnapshot(text);
    const value = text.includes("\n") ? "`" + escaped.split("\n").map((line, i, lines) => i === 0 ? line : (i === lines.length - 1 ? indent : indent + "  ") + line).join("\n") + "`" : "`" + escaped + "`";
    const target = site.arguments[properties ? 1 : 0];
    if (target) {
      const tokens = snapshotTokens(source.slice(target.start, target.end));
      if (tokens.length !== 1 || !/^["'`]/.test(tokens[0].text)) throw new Error("Failed to update inline snapshot: Argument must be a string literal");
      return { start: target.start, end: target.end, value };
    }
    const trailingComma = site.commas.length > 0 && site.commas.length === site.arguments.length;
    return { start: site.close, end: site.close, value: (properties ? (trailingComma ? " " : ", ") : "") + value };
  }

  function flushSnapshots(file) {
    if (file.snapshots && file.snapshots.dirty) {
      snapshotFS().mkdirSync(internal.require("path").dirname(file.snapshots.path), { recursive: true });
      snapshotFS().writeFileSync(file.snapshots.path, file.snapshots.text);
    }
    if (!file.inlineWrites.size) return;
    const edits = Array.from(file.inlineWrites.values(), (write) => inlineReplacement(file.source, write));
    edits.sort((a, b) => b.start - a.start);
    let source = file.source;
    for (const edit of edits) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    snapshotFS().writeFileSync(file.path, source);
  }

  function snapshotTokens(source) {
    const tokens = [];
    for (let i = 0; i < source.length;) {
      const start = i;
      const ch = source[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (source.startsWith("//", i)) { const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end; continue; }
      if (source.startsWith("/*", i)) { const end = source.indexOf("*/", i + 2); if (end < 0) throw new Error("Unterminated comment"); i = end + 2; continue; }
      if (ch === '"' || ch === "'" || ch === "`") i = snapshotQuotedEnd(source, i);
      else if (ch === "/" && snapshotRegexAllowed(tokens)) i = snapshotRegexEnd(source, i);
      else if (/[\w$]/.test(ch)) { i++; while (i < source.length && /[\w$]/.test(source[i])) i++; }
      else i++;
      tokens.push({ text: source.slice(start, i), start, end: i });
    }
    return tokens;
  }

  function snapshotQuotedEnd(source, start) {
    const quote = source[start];
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === quote) return i + 1;
    }
    throw new Error("Unterminated string");
  }

  function snapshotRegexAllowed(tokens) {
    const last = tokens[tokens.length - 1];
    return !last || /^(?:[({[=:,;!?&|]|return|throw|case|yield|=>)$/.test(last.text);
  }

  function snapshotRegexEnd(source, start) {
    let bracket = false;
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === "[") bracket = true;
      if (source[i] === "]") bracket = false;
      if (source[i] !== "/" || bracket) continue;
      i++;
      while (i < source.length && /[a-z]/i.test(source[i])) i++;
      return i;
    }
    return start + 1;
  }

  function snapshotLiteral(text) {
    const quote = text[0];
    if (quote !== "`" && quote !== '"' && quote !== "'") throw new Error("Snapshot values must be string literals");
    let result = "";
    for (let i = 1; i < text.length - 1; i++) {
      if (quote === "`" && text[i] === "$" && text[i + 1] === "{") throw new Error("Snapshot values must be string literals");
      if (text[i] !== "\\") { result += text[i]; continue; }
      const escape = snapshotEscape(text, i + 1);
      result += escape.text;
      i = escape.end;
    }
    return result.replace(/\r\n?/g, "\n");
  }

  function snapshotEscape(text, index) {
    const escapes = { n: "\n", r: "\r", t: "\t", v: "\v", b: "\b", f: "\f", "0": "\0", "\n": "" };
    const ch = text[index];
    if (Object.prototype.hasOwnProperty.call(escapes, ch)) return { text: escapes[ch], end: index };
    if (ch === "\r") return { text: "", end: text[index + 1] === "\n" ? index + 1 : index };
    if (ch !== "x" && ch !== "u") return { text: ch, end: index };
    const brace = ch === "u" && text[index + 1] === "{";
    const start = index + (brace ? 2 : 1);
    const end = brace ? text.indexOf("}", start) : start + (ch === "x" ? 2 : 4);
    const hex = text.slice(start, end);
    if (end < start || !/^[a-f\d]+$/i.test(hex)) throw new Error("Invalid string escape");
    return { text: String.fromCodePoint(parseInt(hex, 16)), end: brace ? end : end - 1 };
  }

  // ───────────────────────────── collection ─────────────────────────────

  function createScope(name, parent, mode, only, concurrent = false) {
    return { kind: "scope", name, parent, mode, only, concurrent, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  }

  // test.concurrent and describe.concurrent opt in, test.serial and describe.serial opt out,
  // and everything else inherits from its describe block (the file root follows --concurrent).
  function effectiveConcurrent(scope, modifiers) {
    return modifiers.concurrent === undefined ? scope.concurrent : modifiers.concurrent;
  }

  function currentScope(kind) {
    if (!collecting) throw new Error(`Cannot use ${kind} outside of the test runner. Run "bun test" to run tests.`);
    return collecting.scope;
  }

  // A scope's mode wins over its children's ("skip" and "todo" propagate).
  function effectiveMode(scope, mode) {
    return scope.mode === "run" ? mode : scope.mode;
  }

  function readTimeout(options) {
    if (typeof options === "number") return options;
    if (!options || typeof options !== "object") return undefined;
    const timeout = options.timeout;
    return typeof timeout === "number" ? timeout : undefined;
  }

  function guardRegistration(kind) {
    if (preloading) throw new Error(`Cannot use ${kind} during preload.`);
  }

  function registerTest(modifiers, name, fn, timeoutOrOptions) {
    guardRegistration("test");
    const hasFn = typeof fn === "function";
    const mode = modifiers.mode || "run";
    const signature = modifiers.failing ? "test.failing" : "test";
    if (!hasFn && mode === "run") throw new Error(`${signature} expects a function as the second argument`);
    const timeout = readTimeout(timeoutOrOptions);
    const repeat = internal.require("test_lifecycle").repeatOptions(timeoutOrOptions, signature);
    const scope = currentScope("test");
    const test = {
      kind: "test",
      name: name === undefined ? "" : String(name),
      fn: hasFn ? fn : null,
      parent: scope,
      mode: effectiveMode(scope, mode),
      only: !!modifiers.only,
      failing: !!modifiers.failing,
      concurrent: effectiveConcurrent(scope, modifiers),
      timeout,
      retry: repeat.retry,
      repeats: repeat.repeats,
      usesDone: modifiers.usesDone !== undefined ? modifiers.usesDone : hasFn && fn.length > 0,
      // Bun calls a test in the async context it was registered in.
      context: native.getAsyncContext(),
    };
    if (test.only) collecting.hasOnly = true;
    scope.children.push(test);
  }

  // Bun's ScopeFunctions.rs parse_arguments: a sole function is the callback, a function
  // followed by a non-function is the callback and its options, and otherwise the first
  // argument is the description and a function second or third is the callback.
  function describeArguments([first, second, third]) {
    const present = (value) => value !== undefined && value !== null;
    if (present(third)) return { description: first, callback: typeof second === "function" ? second : third };
    if (present(second)) return typeof first === "function" && typeof second !== "function" ? { callback: first } : { description: first, callback: second };
    if (present(first)) return typeof first === "function" ? { callback: first } : { description: first };
    return {};
  }

  // Bun's get_description: a class's name (empty for an anonymous class), a named function's
  // name, or a number or string. Anything else, such as an anonymous arrow function, throws.
  function describeLabel(description) {
    if (description === undefined || description === null) return "";
    if (typeof description === "function" && (description.name || /^class\b/.test(Function.prototype.toString.call(description)))) return description.name;
    if (typeof description === "number" || typeof description === "string") return String(description);
    throw new Error("describe() expects first argument to be a named class, named function, number, or string");
  }

  function registerDescribe(modifiers, ...args) {
    guardRegistration("describe");
    const parent = currentScope("describe");
    const { description, callback: fn } = describeArguments(args);
    const label = describeLabel(description);
    const scope = createScope(label, parent, effectiveMode(parent, modifiers.mode || "run"), !!modifiers.only, effectiveConcurrent(parent, modifiers));
    if (scope.only) collecting.hasOnly = true;
    parent.children.push(scope);
    if (typeof fn !== "function") return;
    collecting.scope = scope;
    try {
      // In the caller's context, so an enterWith() inside the callback stays inside it: Bun runs
      // describe callbacks after the file loads, and later registrations must not see it.
      internal.runInContext(native.getAsyncContext(), fn, undefined, []);
    } finally {
      collecting.scope = parent;
    }
  }

  // printf-style labels for .each (jest.rs format_label).
  function formatLabel(label, args, index) {
    let out = "";
    let argIndex = 0;
    for (let i = 0; i < label.length; i++) {
      const ch = label[i];
      if (ch === "$" && i + 1 < label.length && args.length > 0 && isObjectLike(args[0])) {
        const variable = formatVariable(label.slice(i + 1), args[0]);
        out += variable ? variable.text : ch;
        if (variable) i += variable.length;
        continue;
      }
      if (ch !== "%" || i + 1 >= label.length || argIndex >= args.length) {
        out += ch;
        continue;
      }
      const spec = label[i + 1];
      const arg = args[argIndex];
      const formatted = formatSpecifier(spec, arg, index);
      if (formatted === null) {
        out += ch;
        continue;
      }
      out += formatted.text;
      if (formatted.consumes) argIndex++;
      i++;
    }
    return out;
  }

  // `$name` / `$a.b` in an .each label: the row object's property, if set.
  function formatVariable(rest, row) {
    const match = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$\d][\w$]*)*/.exec(rest);
    if (!match) return null;
    let value = row;
    for (const key of match[0].split(".")) {
      if (value === null || value === undefined || !(key in Object(value))) return null;
      value = value[key];
    }
    if (value === undefined || value === null) return null;
    const text = typeof value === "string" ? value : inspect(value);
    return { text, length: match[0].length };
  }

  function formatSpecifier(spec, arg, index) {
    const typed = (ok) => ({ text: ok ? String(arg) : `%${spec}`, consumes: true });
    switch (spec) {
      case "s":
        return typed(typeof arg === "string");
      case "i":
        return typed(typeof arg === "number" && Number.isInteger(arg));
      case "d":
      case "f":
        return typed(typeof arg === "number");
      case "j":
      case "o":
        return { text: String(JSON.stringify(arg)), consumes: true };
      case "p":
        return { text: inspect(arg), consumes: true };
      case "#":
        return { text: String(index), consumes: false };
      case "%":
        return { text: "%", consumes: false };
      default:
        return { text: "", consumes: false };
    }
  }

  function eachRows(table) {
    return Array.from(table, (row) => (Array.isArray(row) ? row : [row]));
  }

  const VARIANTS = { skip: { mode: "skip" }, todo: { mode: "todo" }, only: { only: true }, failing: { failing: true }, concurrent: { concurrent: true }, serial: { concurrent: false } };

  // Modifiers chain in any order, as in Bun: test.concurrent.each, test.concurrent.failing, ...
  // Each variant is made on first use and then kept, so test.failing === test.failing.
  function addVariants(fn, modifiers, make, names) {
    for (const name of names) {
      const get = () => {
        const variant = make(Object.assign({}, modifiers, VARIANTS[name]));
        Object.defineProperty(fn, name, { configurable: true, enumerable: true, writable: true, value: variant });
        return variant;
      };
      Object.defineProperty(fn, name, { configurable: true, enumerable: true, get });
    }
  }

  // Every variant has its own if, skipIf, todoIf and failingIf, as in Bun:
  // test.concurrent.skipIf(c) picks test.concurrent.skip or test.concurrent.
  function addConditionals(fn, failingIf) {
    fn.if = (condition) => (condition ? fn : fn.skip);
    fn.skipIf = (condition) => (condition ? fn.skip : fn);
    fn.todoIf = (condition) => (condition ? fn.todo : fn);
    fn.failingIf = failingIf;
  }

  function makeTest(modifiers) {
    const fn = (name, callback, timeout) => registerTest(modifiers, name, callback, timeout);
    addVariants(fn, modifiers, makeTest, ["skip", "todo", "only", "failing", "concurrent", "serial"]);
    addConditionals(fn, (condition) => (condition ? fn.failing : fn));
    fn.each = (table) => (name, callback, timeout) => {
      guardRegistration("test");
      eachRows(table).forEach((args, index) => {
        const label = formatLabel(String(name), args, index);
        const usesDone = typeof callback === "function" && callback.length > args.length;
        const body = typeof callback === "function" ? (...extra) => callback(...args.concat(extra)) : callback;
        registerTest(Object.assign({}, modifiers, { usesDone }), label, body, timeout);
      });
    };
    return fn;
  }

  function makeDescribe(modifiers) {
    const fn = (...args) => registerDescribe(modifiers, ...args);
    addVariants(fn, modifiers, makeDescribe, ["skip", "todo", "only", "concurrent", "serial"]);
    addConditionals(fn, (condition) => {
      if (condition) throw new Error("Cannot call .failingIf() on describe");
      return fn;
    });
    fn.each = (table) => (name, callback) => {
      guardRegistration("describe");
      eachRows(table).forEach((args, index) => {
        registerDescribe(modifiers, formatLabel(String(name), args, index), () => callback(...args));
      });
    };
    return fn;
  }

  const test = makeTest({});
  const describe = makeDescribe({});

  function hookRegistrar(kind) {
    return (fn, timeout) => {
      if (typeof fn !== "function") throw new TypeError(`${kind}() expects a function as the first argument`);
      const test = running().test;
      const hooks = kind === "afterAll" && test ? test.afterAll : currentScope(`${kind}()`)[kind];
      hooks.push({ fn, timeout: readTimeout(timeout), context: native.getAsyncContext() });
    };
  }

  function onTestFinished(fn, timeout) {
    if (typeof fn !== "function") throw new Error("onTestFinished() expects a function as the first argument");
    const test = running().test;
    if (!test) throw new Error("Cannot call onTestFinished() outside of a test. It can only be called inside a test.");
    test.finished.push({ fn, timeout: readTimeout(timeout), context: native.getAsyncContext() });
  }

  function setDefaultTimeout(ms) {
    if (typeof ms !== "number") throw new Error("setTimeout() expects a number (milliseconds)");
    options.timeout = ms;
  }

  // ───────────────────────────── execution ─────────────────────────────

  /**
   * Calls a test or hook body. Resolves to { ok } or { error } or
   * { timeout, done }, never rejects. Uses a done callback when the function
   * declares one.
   */
  function invoke(fn, args, usesDone, timeout, slot = running(), context = undefined) {
    return new Promise((resolve) => {
      let timer = null;
      const invocation = matcherSupport.pending();
      const finish = (result) => invocation.complete(result, finalize, usesDone);
      const finalize = (result) => {
        if (invocation.settled) return;
        invocation.settled = true;
        if (timer !== null) internal.realTimers.clearTimeout(timer);
        if (slot.invocation === invocation) slot.invocation = null;
        resolve(result);
      };
      invocation.fail = (error) => finish({ error });
      slot.invocation = invocation;
      const startTimer = () => {
        timer = internal.realTimers.setTimeout(() => finish({ timeout: true, done: usesDone }), timeout);
      };
      startTimer();
      const body = () => internal.require("test_lifecycle").body(fn, args, usesDone, finish);
      // The callback runs in the async context it was registered in, as in Bun, so stores
      // entered before it are visible. A lane's slot goes on top, entered again for each call:
      // runtime JS awaits between a test's hooks and body, and a Browser host does not carry
      // the frame across those.
      const call = "blocked" in slot ? () => runInSlot(slot, body) : body;
      internal.runInContext(context, call, undefined, []);
      // In a concurrent group, the next test starts only once this one really waits, as in Bun.
      if (slot.blocked && !invocation.settled) whenStillPending(invocation, slot.blocked);
    });
  }

  // Bun drains the microtask queue after calling a callback and only then reads its promise:
  // one that awaited only settled values has finished by then. QuickJS, JSC and the other
  // in-guest engines own their job queue, so they drain it here the same way. The Browser
  // host cannot run its native jobs synchronously or see an async function's promise state,
  // so there a callback still unsettled after three microtask turns counts as waiting: a
  // finished one settles within two (its promise reaction, then completion), and no timer
  // can have run yet.
  function whenStillPending(invocation, blocked) {
    if (native.engine !== "host") {
      native.runMicrotasks();
      if (!invocation.settled) blocked();
      return;
    }
    let turns = 3;
    const check = () => {
      if (invocation.settled) return;
      if (turns-- === 0) return blocked();
      internal.promiseThen(Promise.resolve(), check);
    };
    check();
  }

  function invokeHook(hook, slot) {
    const timeout = hook.timeout === undefined ? options.timeout : hook.timeout;
    return invoke(hook.fn, [], hook.fn.length > 0, timeout, slot, hook.context);
  }

  async function runHooks(hooks, slot) {
    for (const hook of hooks) {
      const result = await invokeHook(hook, slot);
      if (!result.ok) return result;
    }
    return { ok: true };
  }

  function scopeChain(scope) {
    const chain = [];
    for (let s = scope; s; s = s.parent) chain.push(s);
    return chain.reverse();
  }

  function displayNames(node) {
    return scopeChain(node.kind === "scope" ? node : node.parent)
      .map((s) => s.name)
      .filter((name) => name !== "");
  }

  function isSelected(node, file) {
    if (!file.hasOnly && !options.only) return true;
    for (let n = node; n; n = n.parent) if (n.only) return true;
    return false;
  }

  function labelMatches(test) {
    if (!options.namePattern) return true;
    const full = displayNames(test).concat([test.name]).join(" ");
    options.namePattern.lastIndex = 0;
    return options.namePattern.test(full);
  }

  function willRun(node, file) {
    if (node.kind === "test") return node.mode === "run" && isSelected(node, file) && labelMatches(node);
    return node.children.some((child) => willRun(child, file));
  }

  // Bun's Order.rs: a file runs as a flat list of steps. Consecutive concurrent tests form one
  // group, even across describe blocks; beforeAll and afterAll hooks always run on their own,
  // so they end a group. A failed beforeAll skips its scope's tests and, as before this runner
  // had groups, its afterAll too; Bun's set_failure_skip_to still runs that afterAll.
  function planScope(scope, file, steps) {
    const active = willRun(scope, file);
    const before = active && scope.beforeAll.length ? { kind: "beforeAll", scope, skipTo: 0 } : null;
    if (before) steps.push(before);
    for (const child of scope.children) {
      if (child.kind === "scope") planScope(child, file, steps);
      else steps.push({ kind: "test", test: child });
    }
    if (active && scope.afterAll.length) steps.push({ kind: "afterAll", scope });
    if (before) before.skipTo = steps.length;
    return steps;
  }

  function concurrentAt(steps, index) {
    const step = steps[index];
    return step !== undefined && step.kind === "test" && step.test.concurrent;
  }

  async function runScope(scope, file) {
    const steps = planScope(scope, file, []);
    let index = 0;
    while (index < steps.length) {
      const step = steps[index];
      if (step.kind !== "test") {
        index = await runScopeHooks(step, index);
        continue;
      }
      let end = index + 1;
      while (step.test.concurrent && concurrentAt(steps, end)) end++;
      if (end - index === 1) await runTestNode(step.test, file);
      else await runConcurrentGroup(steps.slice(index, end).map(entry => entry.test), file);
      index = end;
    }
  }

  async function runScopeHooks(step, index) {
    const result = await runHooks(step.scope[step.kind]);
    if (result.ok) return index + 1;
    reportHookFailure(step.scope, result);
    return step.kind === "beforeAll" ? step.skipTo : index + 1;
  }

  // Bun's Execution.rs steps each test of a group until a hook or body really waits, then
  // starts the next one. Here a lane takes tests in order; whenever a lane's callback is still
  // pending after it returns, another lane starts, up to --max-concurrency lanes. Tests that
  // never wait therefore run one after another, in order.
  function runConcurrentGroup(tests, file) {
    const limit = options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, tests.length) : tests.length;
    let next = 0;
    let lanes = 0;
    let active = 0;
    const lane = async (slot) => {
      while (next < tests.length) await runTestNode(tests[next++], file);
      slot.blocked = null;
    };
    concurrentGroups++;
    return new Promise((resolve, reject) => {
      const startLane = () => {
        if (lanes >= limit || next >= tests.length) return;
        lanes++;
        active++;
        const slot = { test: null, invocation: null, blocked: startLane };
        runInSlot(slot, () => lane(slot)).then(() => {
          if (--active === 0) resolve();
        }, reject);
      };
      startLane();
    }).finally(() => {
      concurrentGroups--;
    });
  }

  // A failing beforeAll/afterAll is reported as an unnamed test of its scope.
  function reportHookFailure(scope, result) {
    const fake = { name: "(unnamed)", parent: scope, timeout: options.timeout };
    reportResult(fake, failureFromResult(result, fake), 0);
  }

  async function runTestNode(test, file) {
    if (!isSelected(test, file)) return;
    if (!labelMatches(test)) {
      summary.filtered++;
      return;
    }
    if (test.mode === "skip") return reportResult(test, { status: "skip" }, 0);
    if (test.mode === "todo" && !(options.runTodo && test.fn)) return reportResult(test, { status: "todo" }, 0);
    const outcome = await internal.require("test_lifecycle").attempts(test, () => executeTest(test, file), (failed) => {
      printFileHeaderIfNeeded();
      printFailure(failed.result);
      writeErr(resultNote(failed.result));
    });
    reportResult(test, outcome.result, outcome.elapsed, outcome.expectCount, outcome.label);
  }

  function* cleanupHooks(record, afterEach) {
    let afterIndex = 0;
    let finishedIndex = 0;
    while (record.afterAll.length || afterIndex < afterEach.length || finishedIndex < record.finished.length) {
      if (record.afterAll.length) { yield record.afterAll.pop(); continue; }
      if (afterIndex < afterEach.length) { yield afterEach[afterIndex++]; continue; }
      const callback = record.finished[finishedIndex];
      delete record.finished[finishedIndex++];
      yield callback;
    }
  }

  async function executeTest(test, file) {
    const chain = scopeChain(test.parent);
    const record = { expectCount: 0, assertions: null, test, file, afterAll: [], finished: [] };
    const slot = running();
    slot.test = record;
    const start = now();
    // Without beforeEach hooks the body starts synchronously, so a concurrent group's tests
    // each reach their first callback in order before the next one starts.
    const beforeEach = chain.flatMap((s) => s.beforeEach);
    let result = beforeEach.length ? await runHooks(beforeEach, slot) : { ok: true };
    if (result.ok) {
      const timeout = test.timeout === undefined ? options.timeout : test.timeout;
      result = await invoke(test.fn, [], test.usesDone, timeout, slot, test.context);
      if (result.timeout) result.timeoutMs = timeout;
    }
    const after = await runHooks(cleanupHooks(record, chain.reverse().flatMap((s) => s.afterEach)), slot);
    if (!result.ok && !after.ok) {
      printFileHeaderIfNeeded();
      const failure = failureFromResult(test.failing ? after : result, test);
      printFailure(failure);
      writeErr(resultNote(failure));
    }
    if (!after.ok && !test.failing) result = after;
    const elapsed = now() - start;
    slot.test = null;
    const classified = test.failing && !after.ok && result.ok ? failureFromResult(after, test) : classify(test, result, record);
    return { result: classified, elapsed, expectCount: record.expectCount };
  }

  function classify(test, result, record) {
    if (test.mode === "todo") return result.ok ? { status: "fail", note: "todoPassed" } : { status: "todo" };
    if (test.failing && !result.timeout) return result.ok ? { status: "fail", note: "failingPassed" } : { status: "pass" };
    if (!result.ok) return failureFromResult(result, test);
    const assertions = record.assertions;
    if (assertions && assertions.exact !== undefined && assertions.exact !== record.expectCount) {
      return { status: "fail", assertion: assertionCountMessage(assertions.exact, record.expectCount) };
    }
    if (assertions && assertions.atLeastOne && record.expectCount === 0) {
      return { status: "fail", assertion: "received 0 assertions, but expected at least one assertion to be called" };
    }
    return { status: "pass" };
  }

  function assertionCountMessage(expected, actual) {
    return `expected ${expected} assertion${expected === 1 ? "" : "s"}, but test ended with ${actual} assertion${actual === 1 ? "" : "s"}`;
  }

  function failureFromResult(result, test) {
    if (result.timeout) return { status: "fail", timeout: result.timeoutMs || test.timeout || options.timeout, done: result.done };
    return { status: "fail", error: result.error };
  }

  // ───────────────────────────── reporting ─────────────────────────────

  function writeErr(text) {
    native.writeStderr(text);
  }

  function formatErrorText(error) {
    let text;
    try {
      text = inspectModule().formatError(error);
    } catch {
      text = `error: ${String(error && error.message !== undefined ? error.message : error)}\n`;
    }
    return text.endsWith("\n") ? text : text + "\n";
  }

  function formatElapsed(ms) {
    return `[${ms.toFixed(2)}ms]`;
  }

  // Native Bun shows a test's duration when it exceeds 10µs: thrown errors
  // and timeouts take that long, a trivial passing test under JSC rarely
  // does. QuickJS in wasm is ~50x slower, so other results use a 1ms
  // threshold to keep reports alike.
  function showsElapsed(result, ms) {
    if (result.status === "skip" || result.status === "todo") return false;
    if (result.status === "fail" && (result.error !== undefined || result.timeout !== undefined)) return true;
    return ms > 1;
  }

  function reportResult(test, result, elapsed, expectCount, label = "") {
    summary.expectations += expectCount || 0;
    summary[result.status]++;
    // Agents only see failures.
    const quiet = options.agent && result.status !== "fail";
    if (!quiet) printResult(test, result, elapsed, label);
    if (result.status === "fail" && options.bail > 0 && summary.fail === options.bail) bailOut();
  }

  function printFailure(result) {
    if (result.error !== undefined) writeErr(formatErrorText(result.error));
    if (result.assertion) writeErr(`AssertionError: ${result.assertion}\n`);
  }

  function printResult(test, result, elapsed, label) {
    printFileHeaderIfNeeded();
    printFailure(result);
    const names = displayNames(test).map((name) => ` ${name} >`).join("");
    const time = showsElapsed(result, elapsed) ? ` ${formatElapsed(elapsed)}` : "";
    const line = `(${result.status})${names} ${test.name}${label}${time}\n${resultNote(result)}`;
    writeErr(line);
    if (result.status in repeated) repeated[result.status] += line;
  }

  // Status lines repeated after a long run (more than 20 passes).
  const repeated = { skip: "", todo: "", fail: "" };

  function printRepeatedLines() {
    if (summary.pass <= 20 || options.agent) return;
    if (summary.skip > 0) writeErr(`\n${summary.skip} tests skipped:\n${repeated.skip}`);
    if (summary.todo > 0) writeErr(`${summary.skip > 0 ? "\n" : ""}\n${summary.todo} tests todo:\n${repeated.todo}`);
    if (summary.fail > 0) {
      writeErr(`${summary.skip > 0 || summary.todo > 0 ? "\n" : ""}\n${summary.fail} tests failed:\n${repeated.fail}`);
    }
  }

  function resultNote(result) {
    if (result.timeout !== undefined && result.done) {
      return `  ^ this test timed out after ${result.timeout}ms, before its done callback was called. If a done callback was not intended, remove the last parameter from the test callback function\n`;
    }
    if (result.timeout !== undefined) return `  ^ this test timed out after ${result.timeout}ms.\n`;
    if (result.note === "failingPassed") {
      return "  ^ this test is marked as failing but it passed. Remove `.failing` if tested behavior now works\n";
    }
    if (result.note === "todoPassed") {
      return "  ^ this test is marked as todo but passes. Remove `.todo` if tested behavior now works\n";
    }
    return "";
  }

  // The current file's `\n<path>:` header. Agents only see it before output.
  let pendingHeader = null;

  function startFileHeader(relPath) {
    pendingHeader = `\n${relPath}:\n`;
    if (!options.agent) printFileHeaderIfNeeded();
  }

  function printFileHeaderIfNeeded() {
    if (pendingHeader === null) return;
    writeErr(pendingHeader);
    pendingHeader = null;
  }

  function reportUnhandledError(error) {
    summary.errors++;
    globalThis.process.exitCode = 1;
    printFileHeaderIfNeeded();
    writeErr("\n# Unhandled error between tests\n-------------------------------\n");
    writeErr(formatErrorText(error));
    writeErr("-------------------------------\n\n");
  }

  let startTime = 0;

  function ranLine() {
    const tests = summary.pass + summary.fail + summary.skip + summary.todo;
    const files = summary.files;
    return `Ran ${tests} test${tests === 1 ? "" : "s"} across ${files} file${files === 1 ? "" : "s"}. ${formatElapsed(now() - startTime)}`;
  }

  function bailOut() {
    writeErr(ranLine());
    writeErr(`\nBailed out after ${options.bail} failure${options.bail === 1 ? "" : "s"}\n`);
    globalThis.process.exit(1);
  }

  function printSummary() {
    printRepeatedLines();
    writeErr("\n");
    const tests = summary.pass + summary.fail + summary.skip + summary.todo;
    if (tests === 0 && summary.filtered > 0 && summary.errors === 0) {
      const files = summary.files;
      const pattern = options.namePatternSource;
      writeErr(
        `error: regex ${JSON.stringify(pattern)} matched 0 tests. Searched ${files} file${files === 1 ? "" : "s"} ` +
          `(skipping ${summary.filtered} test${summary.filtered === 1 ? "" : "s"}) ${formatElapsed(now() - startTime)}\n`,
      );
      return true;
    }
    let out = ` ${summary.pass} pass\n`;
    if (summary.skip > 0) out += ` ${summary.skip} skip\n`;
    else if (summary.filtered > 0) out += ` ${summary.filtered} filtered out\n`;
    if (summary.todo > 0) out += ` ${summary.todo} todo\n`;
    out += ` ${summary.fail} fail\n`;
    if (summary.errors > 0) out += ` ${summary.errors} error${summary.errors > 1 ? "s" : ""}\n`;
    if (snapshots.total > 0) out += snapshotSummary();
    if (summary.expectations > 0 && !(snapshots.total > 0 && snapshots.added === 0 && snapshots.failed === 0)) out += ` ${summary.expectations} expect() calls\n`;
    writeErr(out + ranLine() + "\n");
    return false;
  }

  // ───────────────────────────── discovery ─────────────────────────────

  const JS_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
  const TEST_SUFFIXES = [".test", "_test", ".spec", "_spec"];

  function extensionOf(name) {
    const dot = name.lastIndexOf(".");
    return dot <= 0 ? "" : name.slice(dot);
  }

  function isJsLike(name) {
    return JS_EXTENSIONS.has(extensionOf(name));
  }

  function isTestFileName(name) {
    const lower = name.toLowerCase();
    if (!isJsLike(lower)) return false;
    const stem = lower.slice(0, lower.length - extensionOf(lower).length);
    return TEST_SUFFIXES.some((suffix) => stem.endsWith(suffix));
  }

  function joinPath(dir, name) {
    return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
  }

  function relativePath(cwd, abs) {
    const base = cwd.endsWith("/") ? cwd : cwd + "/";
    return abs.startsWith(base) ? abs.slice(base.length) : abs;
  }

  // Follows symlinks; "other" for anything unreadable.
  function entryKind(abs, kind) {
    if (kind !== "symlink") return kind;
    try {
      return native.stat(abs).mode & 0o040000 ? "dir" : "file";
    } catch {
      return "other";
    }
  }

  /**
   * Breadth-first walk like Bun's Scanner: the starting directory sorted by
   * lowercased name, deeper directories in host order. Counts every file and
   * directory visited for the "files were searched" line.
   */
  function scanDirectory(root, accept, state) {
    const queue = [root];
    let first = true;
    while (queue.length > 0) {
      const dir = queue.shift();
      let entries;
      try {
        entries = native.readdir(dir);
      } catch {
        continue;
      }
      if (first) {
        entries = entries.toSorted((a, b) => compareStrings(a[0].toLowerCase(), b[0].toLowerCase()));
        first = false;
      }
      for (const [name, rawKind] of entries) scanEntry(dir, name, rawKind, accept, state, queue);
    }
  }

  function scanEntry(dir, name, rawKind, accept, state, queue) {
    const abs = joinPath(dir, name);
    const kind = entryKind(abs, rawKind);
    const lower = name.toLowerCase();
    if (kind === "dir") {
      if (lower.startsWith(".") || lower === "node_modules") return;
      state.searched++;
      queue.push(abs);
      return;
    }
    if (kind !== "file") return;
    state.searched++;
    if (!isTestFileName(name) || !accept(abs)) return;
    state.files.push(abs);
  }

  function compareStrings(a, b) {
    if (a < b) return -1;
    return a > b ? 1 : 0;
  }

  function isPathArgument(arg) {
    return arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../");
  }

  function resolveArgument(cwd, arg) {
    const path = internal.require("path");
    return path.resolve(cwd, arg);
  }

  function discover(cwd, filters) {
    const state = { files: [], searched: 0 };
    if (!filters.some(isPathArgument)) {
      const accept = (abs) => filters.length === 0 || filters.some((f) => abs.startsWith(f) || relativePath(cwd, abs).includes(f));
      scanDirectory(cwd, accept, state);
      return state;
    }
    // Path arguments name files or directories to run instead of filters.
    state.missing = [];
    for (const arg of filters) {
      const abs = resolveArgument(cwd, arg);
      let stat;
      try {
        stat = native.stat(abs);
      } catch {
        state.missing.push(arg);
        continue;
      }
      if (stat.mode & 0o040000) scanDirectory(abs, () => true, state);
      else if (isJsLike(abs)) state.files.push(abs);
    }
    return state;
  }

  function printNoTestsFound(filters, state) {
    const learnMore = "\nLearn more about bun test: https://bun.com/docs/cli/test\n";
    const note = 'Tests need ".test", "_test_", ".spec" or "_spec_" in the filename (ex: "MyApp.test.ts")';
    if (filters.length === 0) {
      writeErr(`No tests found!\n\n${note}\n${learnMore}`);
      return;
    }
    if (state.missing && state.missing.length === 1 && filters.length === 1) {
      writeErr(`Test filter ${JSON.stringify(filters[0])} had no matches\n`);
      return;
    }
    let out = "The following filters did not match any test files:\n";
    out += filters.map((f) => ` ${f}`).join("");
    if (state.searched > 0) out += `\n${state.searched} files were searched ${formatElapsed(now() - startTime)}`;
    out += `\n\nnote: ${note}\n`;
    const fileLike = filters.find((f) => /\.(ts|tsx|js|jsx)$/.test(f));
    if (fileLike !== undefined) out += `note: To treat the "${fileLike}" filter as a path, run "bun test ./${fileLike}"\n`;
    writeErr(out + learnMore);
  }

  // ───────────────────────────── CLI ─────────────────────────────

  function parseArgs(args) {
    const filters = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const [flag, inline] = splitFlag(arg);
      const value = () => (inline !== undefined ? inline : args[++i]);
      if (flag === "--timeout") options.timeout = Number(value());
      else if (flag === "--preload") preloads.push(value());
      else if (flag === "-t" || flag === "--test-name-pattern") setNamePattern(value());
      else if (flag === "--bail") options.bail = inline === undefined ? 1 : Number(inline);
      else if (flag === "--only") options.only = true;
      else if (flag === "--concurrent") options.concurrent = true;
      else if (flag === "--max-concurrency") options.maxConcurrency = Number(value());
      else if (flag === "--todo") options.runTodo = true;
      else if (flag === "--update-snapshots" || flag === "-u") options.updateSnapshots = true;
      else if (arg.startsWith("-")) continue;
      else filters.push(arg);
    }
    return filters;
  }

  function splitFlag(arg) {
    if (!arg.startsWith("--")) return [arg, undefined];
    const eq = arg.indexOf("=");
    return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
  }

  function setNamePattern(source) {
    options.namePatternSource = source;
    options.namePattern = new RegExp(source);
  }

  // Errors thrown outside any awaited test code (timers, stray promises).
  function installErrorHandlers() {
    const process = globalThis.process;
    const onError = (error) => {
      const invocation = running().invocation;
      if (invocation) invocation.fail(error);
      else reportUnhandledError(error);
    };
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", (error, promise) => {
      const invocation = running().invocation;
      if (invocation) invocation.unhandled(error, promise);
      onError(error);
    });
  }

  async function runFile(abs, cwd, last) {
    const previousFile = activeFile;
    activeFile = {};
    try {
      await runActiveFile(abs, cwd, last);
    } finally {
      activeFile = previousFile;
    }
  }

  async function importPreloads(file, cwd) {
    if (preloads.length === 0 || preloadImport === "ready") return true;
    if (preloadImport !== "unattempted") return false;
    preloadImport = "loading";
    preloadScope = createScope("", null, "run", false);
    const previousScope = file.scope;
    const previousCollecting = collecting;
    file.scope = preloadScope;
    preloading = true;
    try {
      for (const preload of preloads) await internal.importModule(resolveArgument(cwd, preload));
      preloadImport = "ready";
      return true;
    } catch (error) {
      preloadImport = "stopped";
      preloadSetup = "stopped";
      throw error;
    } finally {
      preloading = false;
      file.scope = previousScope;
      collecting = previousCollecting;
    }
  }

  async function collectFile(file, cwd) {
    if (preloadImport === "stopped") return false;
    collecting = file;
    try {
      if (!await importPreloads(file, cwd)) return false;
      file.root.parent = preloadScope;
      await internal.importModule(file.path);
      return true;
    } catch (error) {
      reportUnhandledError(error);
      summary.fail++;
      return false;
    } finally {
      collecting = null;
    }
  }

  async function setupPreloads() {
    if (!preloadScope || preloadImport !== "ready" || preloadSetup !== "pending") return;
    preloadSetup = "running";
    try {
      const result = await runHooks(preloadScope.beforeAll);
      preloadSetup = result.ok ? "ready" : "stopped";
      if (!result.ok) reportHookFailure(preloadScope, result);
    } catch (error) {
      preloadSetup = "stopped";
      reportHookFailure(preloadScope, { error });
    }
  }

  async function finishPreloads() {
    if (!preloadScope || preloadImport !== "ready" || preloadTeardown) return;
    preloadTeardown = true;
    try {
      const result = await runHooks(preloadScope.afterAll);
      if (!result.ok) reportHookFailure(preloadScope, result);
    } catch (error) {
      reportHookFailure(preloadScope, { error });
    }
  }

  function flushFileSnapshots(file) {
    try {
      flushSnapshots(file);
    } catch (error) {
      reportUnhandledError(error);
    }
  }

  async function runActiveFile(abs, cwd, last) {
    summary.files++;
    const file = { root: createScope("", null, "run", false, options.concurrent), hasOnly: false, path: abs, snapshotCounts: new Map(), inlineWrites: new Map() };
    file.scope = file.root;
    startFileHeader(relativePath(cwd, abs));
    const collected = await collectFile(file, cwd);
    await setupPreloads();
    try {
      if (collected && preloadSetup !== "stopped") await runScope(file.root, file);
    } finally {
      if (last) await finishPreloads();
      flushFileSnapshots(file);
    }
  }

  async function run(args) {
    startTime = now();
    options.agent = isAgent();
    const bun = globalThis.Bun;
    native.writeStdout(`bun test v${bun.version} (${String(bun.revision).slice(0, 9)})\n`);
    const filters = parseArgs(Array.from(args || []));
    const cwd = native.cwd();
    const state = discover(cwd, filters);
    if (state.files.length === 0) {
      printNoTestsFound(filters, state);
      globalThis.process.exitCode = 1;
      return;
    }
    installErrorHandlers();
    Object.assign(globalThis, exports);
    for (let index = 0; index < state.files.length; index++) await runFile(state.files[index], cwd, index === state.files.length - 1);
    const filteredAll = printSummary();
    if (filteredAll || summary.fail > 0 || summary.errors > 0) globalThis.process.exitCode = 1;
  }

  const exports = {
    test,
    it: test,
    describe,
    expect,
    beforeAll: hookRegistrar("beforeAll"),
    afterAll: hookRegistrar("afterAll"),
    beforeEach: hookRegistrar("beforeEach"),
    afterEach: hookRegistrar("afterEach"),
    onTestFinished,
    mock,
    spyOn,
    jest,
    vi: jest,
    setSystemTime: internal.fakeTimers.api.setSystemTime,
    setDefaultTimeout,
  };

  return { exports, run };
})
