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
    return performance.now();
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

  const options = { timeout: 5000, namePattern: null, only: false, bail: 0, runTodo: false, agent: false };
  const preloads = [];

  const summary = { pass: 0, fail: 0, skip: 0, todo: 0, filtered: 0, files: 0, expectations: 0, errors: 0 };

  // The file whose module is being evaluated (tests register into it).
  let collecting = null;
  // The test whose body or hooks are running: { expectCount, assertions }.
  let currentTest = null;
  // The pending invocation, so uncaught errors can fail it.
  let activeInvocation = null;

  // ───────────────────────────── asymmetric matchers ─────────────────────────────

  class AsymmetricMatcher {
    constructor(sample, inverse) {
      this.sample = sample;
      this.inverse = !!inverse;
    }
    asymmetricMatch(other) {
      const result = this.matches(other);
      return this.inverse ? !result : result;
    }
    // Bun.inspect shows matchers by their pretty description.
    [INSPECT_CUSTOM]() {
      return this.describe(inspect);
    }
  }

  class AnyMatcher extends AsymmetricMatcher {
    matches(other) {
      return matchesConstructor(this.sample, other);
    }
    describe() {
      return `Any<${this.sample.name}>`;
    }
  }

  function matchesConstructor(ctor, value) {
    if (ctor === String) return typeof value === "string" || value instanceof String;
    if (ctor === Number) return typeof value === "number" || value instanceof Number;
    if (ctor === Boolean) return typeof value === "boolean" || value instanceof Boolean;
    if (ctor === BigInt) return typeof value === "bigint";
    if (ctor === Symbol) return typeof value === "symbol";
    if (ctor === Function) return typeof value === "function";
    if (ctor === Object) return typeof value === "object" && value !== null;
    return isObjectLike(value) && value instanceof ctor;
  }

  class AnythingMatcher extends AsymmetricMatcher {
    matches(other) {
      return other !== null && other !== undefined;
    }
    describe() {
      return "Anything";
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
      if (typeof other !== "string") return false;
      const re = typeof this.sample === "string" ? new RegExp(this.sample) : this.sample;
      re.lastIndex = 0;
      return re.test(other);
    }
    describe(format) {
      return `${this.inverse ? "StringNotMatching" : "StringMatching"} ${format(this.sample)}`;
    }
  }

  class ObjectContainingMatcher extends AsymmetricMatcher {
    matches(other) {
      if (!isObjectLike(other)) return false;
      for (const key of Object.keys(this.sample)) {
        if (!(key in Object(other))) return false;
        if (!equals(other[key], this.sample[key], false)) return false;
      }
      return true;
    }
    describe(format) {
      return `${this.inverse ? "ObjectNotContaining" : "ObjectContaining"} ${format(this.sample)}`;
    }
  }

  class ArrayContainingMatcher extends AsymmetricMatcher {
    matches(other) {
      if (!Array.isArray(other)) return false;
      return this.sample.every((item) => other.some((value) => equals(value, item, false)));
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
    matches(other) {
      if (typeof other !== "number") return false;
      return closeTo(other, this.sample, this.precision).pass;
    }
    describe() {
      return `NumberCloseTo ${this.sample} (${this.precision} digits)`;
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
      return !!(result && result.pass);
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

  /** Whether `value` holds an asymmetric matcher anywhere in arrays/plain objects. */
  function containsAsymmetric(value, seen) {
    if (isAsymmetric(value)) return true;
    if (!isObjectLike(value) || typeof value === "function") return false;
    const visited = seen || new Set();
    if (visited.has(value)) return false;
    visited.add(value);
    if (Array.isArray(value)) return value.some((item) => containsAsymmetric(item, visited));
    if (!isPlainObject(value)) return false;
    return Object.keys(value).some((key) => containsAsymmetric(value[key], visited));
  }

  function isPlainObject(value) {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  /** toEqual / toStrictEqual semantics, with asymmetric matchers on either side. */
  function equals(received, expected, strict) {
    if (isAsymmetric(expected)) return expected.asymmetricMatch(received);
    if (isAsymmetric(received)) return received.asymmetricMatch(expected);
    if (!containsAsymmetric(expected) && !containsAsymmetric(received)) return bunDeepEquals(received, expected, strict);
    if (Array.isArray(received) && Array.isArray(expected)) return arraysEqual(received, expected, strict);
    if (isObjectLike(received) && isObjectLike(expected)) return objectsEqual(received, expected, strict);
    return false;
  }

  function arraysEqual(received, expected, strict) {
    if (received.length !== expected.length) return false;
    return received.every((item, i) => equals(item, expected[i], strict));
  }

  function objectsEqual(received, expected, strict) {
    if (strict && Object.getPrototypeOf(received) !== Object.getPrototypeOf(expected)) return false;
    const keysOf = (obj) => Object.keys(obj).filter((key) => strict || obj[key] !== undefined);
    const receivedKeys = keysOf(received);
    const expectedKeys = keysOf(expected);
    if (receivedKeys.length !== expectedKeys.length) return false;
    return expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(received, key) && equals(received[key], expected[key], strict));
  }

  /** toMatchObject: every property of `expected` is present and matches in `received`. */
  function matchesObject(received, expected, seen) {
    if (isAsymmetric(expected)) return expected.asymmetricMatch(received);
    if (!isObjectLike(expected) || !isObjectLike(received)) return equals(received, expected, false);
    if (Array.isArray(expected)) {
      if (!Array.isArray(received) || received.length !== expected.length) return false;
      return expected.every((item, i) => matchesObject(received[i], item, seen));
    }
    if (!isPlainObject(expected) && !isPlainObject(received)) {
      if (expected instanceof Date || expected instanceof RegExp || expected instanceof Map || expected instanceof Set) {
        return equals(received, expected, false);
      }
    }
    const visited = seen || new Set();
    if (visited.has(expected)) return true;
    visited.add(expected);
    for (const key of Object.keys(expected)) {
      if (!(key in received)) return false;
      if (!matchesObject(received[key], expected[key], visited)) return false;
    }
    return true;
  }

  // ───────────────────────────── Jest pretty format ─────────────────────────────
  // The format Bun's diffs use (test_runner/pretty_format.rs): keys quoted and
  // sorted, one entry per line, trailing commas.

  function prettyFormat(value) {
    return prettyValue(value, "", new Set());
  }

  function prettyValue(value, indent, seen) {
    if (value === null) return "null";
    switch (typeof value) {
      case "undefined":
        return "undefined";
      case "string":
        return `"${value}"`;
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
    if (isAsymmetric(value)) return prettyAsymmetric(value, indent, seen);
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      return prettyObject(value, indent, seen);
    } finally {
      seen.delete(value);
    }
  }

  function prettyFunction(fn) {
    const source = Function.prototype.toString.call(fn);
    if (/^class\b/.test(source)) return fn.name ? `[class ${fn.name}]` : "[class (anonymous)]";
    return fn.name ? `[Function: ${fn.name}]` : "[Function]";
  }

  function prettyAsymmetric(matcher, indent, seen) {
    // Bun prints arrayContaining through its generic object path.
    if (matcher instanceof ArrayContainingMatcher) return "ExpectArrayContaining {}";
    return matcher.describe((sample) => prettyValue(sample, indent, seen));
  }

  function prettyObject(value, indent, seen) {
    const inner = indent + "  ";
    const block = (open, close, items) => (items.length === 0 ? `${open}${close}` : `${open}\n${items.map((item) => `${inner}${item},\n`).join("")}${indent}${close}`);
    if (Array.isArray(value)) {
      return block("[", "]", Array.from(value, (item) => prettyValue(item, inner, seen)));
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      return block(`${value.constructor.name} [`, "]", Array.from(value, (item) => prettyValue(item, inner, seen)));
    }
    if (value instanceof ArrayBuffer) {
      return block("ArrayBuffer [", "]", Array.from(new Uint8Array(value), String));
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return `[${value.name}: ${value.message}]`;
    if (value instanceof Promise) return "Promise {}";
    if (value instanceof Map) {
      const entries = Array.from(value, ([k, v]) => `${prettyValue(k, inner, seen)} => ${prettyValue(v, inner, seen)}`);
      return block("Map {", "}", entries);
    }
    if (value instanceof Set) {
      return block("Set {", "}", Array.from(value, (item) => prettyValue(item, inner, seen)));
    }
    const name = constructorName(value);
    const prefix = name === "Object" || name === "" ? "{" : `${name} {`;
    const keys = Object.keys(value).sort();
    return block(prefix, "}", keys.map((key) => `"${key}": ${prettyValue(value[key], inner, seen)}`));
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
    return diffStrings(prettyFormat(received), expectedText);
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
      impl: implementation,
      once: [],
      name: undefined,
      restore,
      record: newRecord(),
    };
    const fn = function (...args) {
      return callMock(fn, state, this, args, new.target);
    };
    Object.defineProperty(fn, "name", { value: (implementation && implementation.name) || "mockConstructor" });
    Object.defineProperty(fn, "length", { value: implementation ? implementation.length : 0 });
    Object.defineProperty(fn, "mock", { get: () => state.record, enumerable: false });
    Object.defineProperty(fn, "_isMockFunction", { value: true });
    mockStates.set(fn, state);
    allMocks.add(fn);
    Object.assign(fn, mockMethods(fn, state));
    return fn;
  }

  function newRecord() {
    return { calls: [], results: [], instances: [], contexts: [], invocationCallOrder: [], lastCall: undefined };
  }

  let mockCallOrder = 0;

  function callMock(fn, state, self, args, newTarget) {
    const record = state.record;
    record.calls.push(args);
    record.contexts.push(self);
    record.instances.push(newTarget ? undefined : self);
    record.invocationCallOrder.push(++mockCallOrder);
    record.lastCall = args;
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

  function mockMethods(fn, state) {
    const chain = (action) =>
      function (...args) {
        action(...args);
        return fn;
      };
    return {
      getMockName: () => state.name || "mock",
      getMockImplementation: () => state.impl,
      mockName: chain((name) => (state.name = name)),
      mockClear: chain(() => (state.record = newRecord())),
      mockReset: chain(() => {
        state.record = newRecord();
        state.impl = undefined;
        state.once = [];
      }),
      mockRestore: chain(() => {
        state.record = newRecord();
        state.impl = undefined;
        state.once = [];
        if (state.restore) state.restore();
      }),
      mockImplementation: chain((impl) => (state.impl = impl)),
      mockImplementationOnce: chain((impl) => state.once.push(impl)),
      mockReturnValue: chain((value) => (state.impl = () => value)),
      mockReturnValueOnce: chain((value) => state.once.push(() => value)),
      mockResolvedValue: chain((value) => (state.impl = () => Promise.resolve(value))),
      mockResolvedValueOnce: chain((value) => state.once.push(() => Promise.resolve(value))),
      mockRejectedValue: chain((value) => (state.impl = () => Promise.reject(value))),
      mockRejectedValueOnce: chain((value) => state.once.push(() => Promise.reject(value))),
      mockReturnThis: chain(() => (state.impl = function () {
        return this;
      })),
      withImplementation(impl, callback) {
        const saved = state.impl;
        state.impl = impl;
        const restore = () => (state.impl = saved);
        const result = callback();
        if (isThenable(result)) return result.then(restore, (err) => (restore(), Promise.reject(err)));
        restore();
        return result;
      },
    };
  }

  function mock(implementation) {
    return createMock(implementation);
  }

  function spyOn(object, method) {
    if (!isObjectLike(object)) throw new TypeError("spyOn(target, prop) expects a target object and a property");
    const original = object[method];
    if (isMock(original)) return original;
    const hadOwn = Object.prototype.hasOwnProperty.call(object, method);
    const restore = () => {
      if (hadOwn) object[method] = original;
      else delete object[method];
    };
    const spy = createMock(typeof original === "function" ? original : undefined, restore);
    object[method] = spy;
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
    fn: mock,
    spyOn,
    restoreAllMocks: () => forEachMock("mockRestore"),
    clearAllMocks: () => forEachMock("mockClear"),
    resetAllMocks: () => forEachMock("mockReset"),
    isMockFunction: isMock,
  };

  // ───────────────────────────── expect ─────────────────────────────

  // Parameter labels for signatures, `expect(received).toBe(expected)`.
  const matcherParams = Object.create(null);

  const expectProto = {
    get not() {
      return makeExpectation(this.received, { not: !this.flags.not, promise: this.flags.promise });
    },
    get resolves() {
      return makeExpectation(this.received, { not: this.flags.not, promise: "resolves" });
    },
    get rejects() {
      return makeExpectation(this.received, { not: this.flags.not, promise: "rejects" });
    },
  };

  function makeExpectation(received, flags) {
    const expectation = Object.create(expectProto);
    expectation.received = received;
    expectation.flags = flags;
    return expectation;
  }

  function signature(name, params, not, promise) {
    const modifiers = (promise ? `${promise}.` : "") + (not ? "not." : "");
    return `expect(received).${modifiers}${name}(${params})`;
  }

  function countExpectation() {
    if (currentTest) currentTest.expectCount++;
    else summary.expectations++;
  }

  /**
   * Define a matcher. `impl(ctx, received, ...args)` returns null on success
   * or `{ params?, body }`; the error message is the signature plus `body`.
   * The Error is created when the matcher is called so its stack points at
   * the `expect(...)` line, even for `.resolves`/`.rejects`.
   */
  function defineMatcher(name, params, impl) {
    matcherParams[name] = params;
    expectProto[name] = function (...args) {
      const error = new Error();
      if (this.flags.promise) return matchPromise(this, name, impl, args, error);
      countExpectation();
      applyMatcher(this.flags, this.received, name, impl, args, error);
      return undefined;
    };
  }

  function applyMatcher(flags, received, name, impl, args, error) {
    const failure = impl({ not: flags.not, promise: flags.promise }, received, ...args);
    if (!failure) return;
    const params = failure.params === undefined ? matcherParams[name] : failure.params;
    error.message = failure.raw ? failure.body : signature(name, params, flags.not) + failure.body;
    throw error;
  }

  async function matchPromise(expectation, name, impl, args, error) {
    const { flags, received } = expectation;
    const fail = (body) => {
      error.message = signature(name, matcherParams[name], flags.not, flags.promise) + body;
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
    countExpectation();
    applyMatcher({ not: flags.not, promise: flags.promise }, settled.value, name, impl, args, error);
    return undefined;
  }

  function expect(value) {
    return makeExpectation(value, { not: false, promise: undefined });
  }

  expect.any = (ctor) => {
    if (typeof ctor !== "function") throw new TypeError("any() expects to be passed a constructor function. Please pass one or use anything() to match any object.");
    return new AnyMatcher(ctor);
  };
  expect.anything = () => new AnythingMatcher();
  expect.stringContaining = (s) => new StringContainingMatcher(s);
  expect.stringMatching = (re) => new StringMatchingMatcher(re);
  expect.objectContaining = (obj) => new ObjectContainingMatcher(obj);
  expect.arrayContaining = (arr) => new ArrayContainingMatcher(arr);
  expect.closeTo = (n, precision) => new CloseToMatcher(n, precision);
  expect.not = {
    stringContaining: (s) => new StringContainingMatcher(s, true),
    stringMatching: (re) => new StringMatchingMatcher(re, true),
    objectContaining: (obj) => new ObjectContainingMatcher(obj, true),
    arrayContaining: (arr) => new ArrayContainingMatcher(arr, true),
  };
  expect.assertions = (count) => {
    if (currentTest) currentTest.assertions = { exact: count };
  };
  expect.hasAssertions = () => {
    if (currentTest) currentTest.assertions = { atLeastOne: true };
  };
  expect.unreachable = (message) => {
    throw new Error(message === undefined ? "reached unreachable code" : String(message));
  };
  expect.extend = (matchers) => {
    for (const name of Object.keys(matchers)) defineCustomMatcher(name, matchers[name]);
  };

  function matcherContext(not, promise) {
    return {
      isNot: not,
      promise: promise || "",
      equals: (a, b) => equals(a, b, false),
      utils: {
        printReceived: (v) => inspect(v),
        printExpected: (v) => inspect(v),
        stringify: (v) => inspect(v),
        matcherHint: (name, received = "received", expected = "expected") => `expect(${received}).${name}(${expected})`,
      },
    };
  }

  function defineCustomMatcher(name, matcher) {
    defineMatcher(name, "", (ctx, received, ...args) => {
      const result = matcher.call(matcherContext(ctx.not, ctx.promise), received, ...args);
      if (!result || typeof result.pass !== "boolean") {
        throw new Error(`Unexpected return from matcher function \`${name}\`.\nMatcher functions should return an object in the following format:\n  {message?: string | function, pass: boolean}`);
      }
      if (result.pass !== ctx.not) return null;
      const message = typeof result.message === "function" ? result.message() : result.message;
      return { raw: true, body: message === undefined ? "No message was specified for this matcher." : String(message) };
    });
    expect[name] = (...args) => new CustomAsymmetricMatcher(name, matcher, args);
    expect.not[name] = (...args) => new CustomAsymmetricMatcher(name, matcher, args, true);
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
      if (!failed(ctx, test(received, expected))) return null;
      return { body: `\n\n${formatDiff(received, expected, ctx.not)}\n` };
    });
  }

  defineEqualityMatcher("toEqual", (received, expected) => equals(received, expected, false));
  defineEqualityMatcher("toStrictEqual", (received, expected) => equals(received, expected, true));

  defineMatcher("toMatchObject", "expected", (ctx, received, expected) => {
    if (!isObjectLike(received)) return { body: "\n\nMatcher error: received value must be a non-null object\n" };
    if (!isObjectLike(expected)) return { body: "\n\nMatcher error: expected value must be a non-null object\n" };
    if (!failed(ctx, matchesObject(received, expected))) return null;
    return { body: `\n\n${formatDiff(received, expected, ctx.not)}\n` };
  });

  // ── simple value checks: `Received: <value>` ──

  function defineValueMatcher(name, test) {
    defineMatcher(name, "", (ctx, received) => {
      if (!failed(ctx, test(received))) return null;
      return { body: `\n\nReceived: ${inspect(received)}\n` };
    });
  }

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
  defineValueMatcher("toBeEven", (v) => Number.isInteger(v) && v % 2 === 0);
  defineValueMatcher("toBeOdd", (v) => Number.isInteger(v) && Math.abs(v % 2) === 1);
  defineValueMatcher("toBeDate", (v) => v instanceof Date);
  defineValueMatcher("toBeValidDate", (v) => v instanceof Date && !Number.isNaN(v.getTime()));
  defineValueMatcher("toBeObject", (v) => typeof v === "object" && v !== null);
  defineValueMatcher("toBeSymbol", (v) => typeof v === "symbol");

  // ── ordering ──

  function defineOrderingMatcher(name, op, compare) {
    defineMatcher(name, "expected", (ctx, received, expected) => {
      if (!failed(ctx, compare(received, expected))) return null;
      const not = ctx.not ? "not " : "";
      return { body: `\n\nExpected: ${not}${op} ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
    });
  }

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

  function iterableItems(value) {
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== "function") return null;
    return Array.from(value);
  }

  function defineContainMatcher(name, test) {
    defineMatcher(name, "expected", (ctx, received, expected) => {
      if (!failed(ctx, test(received, expected))) return null;
      if (ctx.not) return { body: `\n\nExpected to not contain: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
      return { body: `\n\nExpected to contain: ${inspect(expected)}\nReceived: ${inspect(received)}\n` };
    });
  }

  defineContainMatcher("toContain", (received, expected) => {
    if (typeof received === "string") return received.includes(String(expected));
    const items = iterableItems(received);
    return items !== null && items.some((item) => item === expected);
  });

  defineContainMatcher("toContainEqual", (received, expected) => {
    const items = iterableItems(received);
    return items !== null && items.some((item) => equals(item, expected, false));
  });

  defineMatcher("toHaveLength", "expected", (ctx, received, expected) => {
    const length = received === null || received === undefined ? undefined : received.length;
    if (!failed(ctx, length === expected)) return null;
    if (ctx.not) return { body: `\n\nExpected length: not ${expected}\n` };
    return { body: `\n\nExpected length: ${expected}\nReceived length: ${length}\n` };
  });

  defineMatcher("toBeEmpty", "", (ctx, received) => {
    let empty = false;
    if (typeof received === "string" || Array.isArray(received)) empty = received.length === 0;
    else if (received instanceof Map || received instanceof Set) empty = received.size === 0;
    else if (isObjectLike(received)) empty = Object.keys(received).length === 0;
    if (!failed(ctx, empty)) return null;
    return { body: `\n\nReceived: ${inspect(received)}\n` };
  });

  defineMatcher("toBeOneOf", "expected", (ctx, received, list) => {
    const items = iterableItems(list) || [];
    if (!failed(ctx, items.some((item) => equals(received, item, false)))) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected: ${not}one of ${inspect(list)}\nReceived: ${inspect(received)}\n` };
  });

  function propertyPath(path) {
    if (Array.isArray(path)) return path;
    return String(path)
      .replace(/\[(\w+)\]/g, ".$1")
      .split(".")
      .filter((part) => part !== "");
  }

  function lookupPath(object, path) {
    let value = object;
    for (const key of propertyPath(path)) {
      if (value === null || value === undefined || !(key in Object(value))) return { found: false };
      value = value[key];
    }
    return { found: true, value };
  }

  defineMatcher("toHaveProperty", "path", (ctx, received, path, ...rest) => {
    const hasValue = rest.length > 0;
    const expectedValue = rest[0];
    const params = hasValue ? "path, value" : "path";
    const lookup = lookupPath(received, path);
    const pass = lookup.found && (!hasValue || equals(lookup.value, expectedValue, false));
    if (!failed(ctx, pass)) return null;
    const shownPath = inspect(path);
    if (ctx.not && hasValue) return { params, body: `\n\nExpected path: ${shownPath}\n\nExpected value: not ${inspect(expectedValue)}\n` };
    if (ctx.not) return { params, body: `\n\nExpected path: not ${shownPath}\n\nReceived value: ${inspect(lookup.value)}\n` };
    if (hasValue && lookup.found) return { params, body: `\n\n${formatDiff(lookup.value, expectedValue, false)}\n` };
    if (hasValue) return { params, body: `\n\nExpected path: ${shownPath}\n\nExpected value: ${inspect(expectedValue)}\n\nUnable to find property\n` };
    return { params, body: `\n\nExpected path: ${shownPath}\n\nUnable to find property\n` };
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

  function throwOutcome(ctx, received) {
    // With .rejects the rejection value is the thrown value.
    if (ctx.promise) return { threw: ctx.promise === "rejects", value: received };
    if (typeof received !== "function") return { invalid: true };
    try {
      return { threw: false, value: received() };
    } catch (err) {
      return { threw: true, value: err };
    }
  }

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
      const outcome = throwOutcome(ctx, received);
      if (outcome.invalid) throw new Error("Expected value must be a function");
      if (ctx.not) return notThrowFailure(outcome, expected);
      if (!outcome.threw) return didNotThrowFailure(outcome, expected);
      return wrongThrowFailure(outcome.value, expected);
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
    if (!throwMatches(value, expected)) return null;
    const message = inspect(thrownMessage(value));
    if (typeof expected === "string") return { body: `\n\nExpected substring: not ${inspect(expected)}\nReceived message: ${message}\n` };
    if (expected instanceof RegExp) return { body: `\n\nExpected pattern: not ${inspect(expected)}\nReceived message: ${message}\n` };
    if (isObjectLike(expected) && "message" in expected) return { body: `\n\nExpected message: not ${inspect(expected.message)}\n` };
    return { body: `\n\nExpected constructor: not ${expected.name}\n\nReceived message: ${message}\n` };
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
    if (expected === undefined || throwMatches(value, expected)) return null;
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
    return args.length === expected.length && args.every((arg, i) => equals(arg, expected[i], false));
  }

  defineMatcher("toHaveBeenCalled", "", (ctx, received) => {
    const record = mockRecord(received);
    const count = record.calls.length;
    if (!failed(ctx, count > 0)) return null;
    if (ctx.not) return { body: `\n\nExpected number of calls: 0\nReceived number of calls: ${count}\n` };
    return { body: `\n\nExpected number of calls: >= 1\nReceived number of calls: ${count}\n` };
  });

  defineMatcher("toHaveBeenCalledOnce", "", (ctx, received) => {
    const count = mockRecord(received).calls.length;
    if (!failed(ctx, count === 1)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected number of calls: ${not}1\nReceived number of calls: ${count}\n` };
  });

  defineMatcher("toHaveBeenCalledTimes", "expected", (ctx, received, times) => {
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
    if (!failed(ctx, calls.some((args) => callsEqual(args, expected)))) return null;
    if (ctx.not) return { body: `\n\nExpected mock function not to have been called with: ${inspect(expected)}\nBut it was.` };
    if (calls.length === 0) return { body: `\n\nExpected: ${inspect(expected)}\nBut it was not called.` };
    if (calls.length === 1) return { body: `\n\n${formatDiff(calls[0], expected, false)}\n` };
    return { body: `\n\n    Expected: ${inspect(expected)}\n    Received:\n${allCallsList(calls)}\n\n    Number of calls: ${calls.length}\n` };
  });

  defineMatcher("toHaveBeenLastCalledWith", "...expected", (ctx, received, ...expected) => {
    const record = mockRecord(received, true);
    if (record.failure) return record.failure;
    const calls = record.calls;
    const last = calls[calls.length - 1];
    if (!failed(ctx, last !== undefined && callsEqual(last, expected))) return null;
    if (ctx.not) return { body: `\n\nExpected last call not to be with: ${inspect(expected)}\nBut it was.` };
    if (calls.length === 0) return { body: `\n\nExpected: ${inspect(expected)}\nBut it was not called.` };
    return { body: `\n\n${formatDiff(last, expected, false)}\n` };
  });

  defineMatcher("toHaveBeenNthCalledWith", "n, ...expected", (ctx, received, n, ...expected) => {
    const record = mockRecord(received, true);
    if (record.failure) return record.failure;
    const calls = record.calls;
    const call = calls[n - 1];
    if (!failed(ctx, call !== undefined && callsEqual(call, expected))) return null;
    if (ctx.not) return { body: `\n\nExpected call #${n} not to be with: ${inspect(expected)}\nBut it was.` };
    if (call === undefined) {
      return { body: `\n\nThe mock function was called ${calls.length} time${calls.length === 1 ? "" : "s"}, but call ${n} was requested.` };
    }
    return { body: `\n\nCall #${n}:\n${formatDiff(call, expected, false)}\n` };
  });

  function returnCounts(record) {
    const returned = record.results.filter((r) => r.type === "return");
    return { returned, calls: record.results.length };
  }

  defineMatcher("toHaveReturned", "", (ctx, received) => {
    const { returned } = returnCounts(mockRecord(received));
    if (!failed(ctx, returned.length > 0)) return null;
    if (ctx.not) return { body: `\n\nExpected number of succesful returns: 0\nReceived number of succesful returns: ${returned.length}\n` };
    return { body: `\n\nExpected number of succesful returns: >= 1\nReceived number of succesful returns: ${returned.length}\n` };
  });

  defineMatcher("toHaveReturnedTimes", "expected", (ctx, received, times) => {
    const { returned } = returnCounts(mockRecord(received));
    if (!failed(ctx, returned.length === times)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected number of succesful returns: ${not}${times}\nReceived number of succesful returns: ${returned.length}\n` };
  });

  defineMatcher("toHaveReturnedWith", "expected", (ctx, received, expected) => {
    const record = mockRecord(received);
    const { returned, calls } = returnCounts(record);
    if (!failed(ctx, returned.some((r) => equals(r.value, expected, false)))) return null;
    if (ctx.not) return { body: `\n\nExpected mock function not to have returned: ${inspect(expected)}\n` };
    if (calls === 1 && returned.length === 1) {
      const value = returned[0].value;
      if (typeof value === "string" && typeof expected === "string") return { body: `\n\n${formatDiff(value, expected, false)}\n` };
      return { body: `\n\nExpected: ${inspect(expected)}\nReceived: ${inspect(value)}` };
    }
    const list = record.results.map((r, i) => `              ${i + 1}: ${inspect(r.value)}`).join("\n");
    return { body: `\n\n    Expected: ${inspect(expected)}\n    Received:\n${list}\n\n    Number of returns: ${returned.length}\n` };
  });

  defineMatcher("toHaveLastReturnedWith", "expected", (ctx, received, expected) => {
    const results = mockRecord(received).results;
    const last = results[results.length - 1];
    const pass = last !== undefined && last.type === "return" && equals(last.value, expected, false);
    if (!failed(ctx, pass)) return null;
    const not = ctx.not ? "not " : "";
    return { body: `\n\nExpected: ${not}${inspect(expected)}\nReceived: ${inspect(last && last.value)}\n` };
  });

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
  ]) {
    if (!(alias in expectProto)) expectProto[alias] = expectProto[target];
  }

  // ───────────────────────────── collection ─────────────────────────────

  function createScope(name, parent, mode, only) {
    return { kind: "scope", name, parent, mode, only, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  }

  function currentScope() {
    if (!collecting) throw new Error("Cannot call test() or describe() outside of a test file");
    return collecting.scope;
  }

  // A scope's mode wins over its children's ("skip" and "todo" propagate).
  function effectiveMode(scope, mode) {
    return scope.mode === "run" ? mode : scope.mode;
  }

  function readTimeout(options) {
    if (typeof options === "number") return options;
    if (options && typeof options === "object" && typeof options.timeout === "number") return options.timeout;
    return undefined;
  }

  function registerTest(modifiers, name, fn, timeoutOrOptions) {
    const scope = currentScope();
    const hasFn = typeof fn === "function";
    const mode = modifiers.mode || "run";
    if (!hasFn && mode === "run") throw new Error("test expects a function as the second argument");
    const test = {
      kind: "test",
      name: name === undefined ? "" : String(name),
      fn: hasFn ? fn : null,
      parent: scope,
      mode: effectiveMode(scope, mode),
      only: !!modifiers.only,
      failing: !!modifiers.failing,
      timeout: readTimeout(timeoutOrOptions),
      usesDone: modifiers.usesDone !== undefined ? modifiers.usesDone : hasFn && fn.length > 0,
    };
    if (test.only) collecting.hasOnly = true;
    scope.children.push(test);
  }

  function registerDescribe(modifiers, name, fn) {
    const parent = currentScope();
    const label = typeof name === "function" ? name.name : String(name);
    const scope = createScope(label, parent, effectiveMode(parent, modifiers.mode || "run"), !!modifiers.only);
    if (scope.only) collecting.hasOnly = true;
    parent.children.push(scope);
    if (typeof fn !== "function") return;
    collecting.scope = scope;
    try {
      fn();
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
    const lookup = lookupPath(row, match[0]);
    if (!lookup.found || lookup.value === undefined || lookup.value === null) return null;
    const text = typeof lookup.value === "string" ? lookup.value : inspect(lookup.value);
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

  function makeTest(modifiers) {
    const fn = (name, callback, timeout) => registerTest(modifiers, name, callback, timeout);
    fn.concurrent = fn;
    fn.serial = fn;
    fn.each = (table) => (name, callback, timeout) => {
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
    const fn = (name, callback) => registerDescribe(modifiers, name, callback);
    fn.concurrent = fn;
    fn.serial = fn;
    fn.each = (table) => (name, callback) => {
      eachRows(table).forEach((args, index) => {
        registerDescribe(modifiers, formatLabel(String(name), args, index), () => callback(...args));
      });
    };
    return fn;
  }

  const test = makeTest({});
  test.skip = makeTest({ mode: "skip" });
  test.todo = makeTest({ mode: "todo" });
  test.only = makeTest({ only: true });
  test.failing = makeTest({ failing: true });
  test.if = (condition) => (condition ? test : test.skip);
  test.skipIf = (condition) => (condition ? test.skip : test);
  test.todoIf = (condition) => (condition ? test.todo : test);
  test.failingIf = (condition) => (condition ? test.failing : test);

  const describe = makeDescribe({});
  describe.skip = makeDescribe({ mode: "skip" });
  describe.todo = makeDescribe({ mode: "todo" });
  describe.only = makeDescribe({ only: true });
  describe.if = (condition) => (condition ? describe : describe.skip);
  describe.skipIf = (condition) => (condition ? describe.skip : describe);
  describe.todoIf = (condition) => (condition ? describe.todo : describe);

  function hookRegistrar(kind) {
    return (fn, timeout) => {
      if (typeof fn !== "function") throw new TypeError(`${kind}() expects a function as the first argument`);
      currentScope()[kind].push({ fn, timeout: readTimeout(timeout) });
    };
  }

  // ───────────────────────────── execution ─────────────────────────────

  /**
   * Calls a test or hook body. Resolves to { ok } or { error } or
   * { timeout, done }, never rejects. Uses a done callback when the function
   * declares one.
   */
  function invoke(fn, args, usesDone, timeout) {
    return new Promise((resolve) => {
      let timer = null;
      const invocation = {};
      const finish = (result) => {
        if (invocation.settled) return;
        invocation.settled = true;
        if (timer !== null) clearTimeout(timer);
        if (activeInvocation === invocation) activeInvocation = null;
        resolve(result);
      };
      invocation.fail = (error) => finish({ error });
      activeInvocation = invocation;
      const startTimer = () => {
        timer = setTimeout(() => finish({ timeout: true, done: usesDone }), timeout);
      };
      try {
        if (usesDone) {
          const done = (err) => finish(err === undefined || err === null ? { ok: true } : { error: err });
          startTimer();
          const result = fn(...args.concat([done]));
          if (isThenable(result)) result.then(null, (err) => finish({ error: err }));
          return;
        }
        const result = fn(...args);
        if (!isThenable(result)) return finish({ ok: true });
        startTimer();
        result.then(() => finish({ ok: true }), (err) => finish({ error: err }));
      } catch (err) {
        finish({ error: err });
      }
    });
  }

  function invokeHook(hook) {
    const timeout = hook.timeout === undefined ? options.timeout : hook.timeout;
    return invoke(hook.fn, [], hook.fn.length > 0, timeout);
  }

  async function runHooks(hooks) {
    for (const hook of hooks) {
      const result = await invokeHook(hook);
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

  async function runScope(scope, file) {
    const active = willRun(scope, file);
    if (active) {
      const before = await runHooks(scope.beforeAll);
      if (!before.ok) {
        reportHookFailure(scope, before);
        return;
      }
    }
    for (const child of scope.children) {
      if (child.kind === "scope") await runScope(child, file);
      else await runTestNode(child, file);
    }
    if (!active) return;
    const after = await runHooks(scope.afterAll);
    if (!after.ok) reportHookFailure(scope, after);
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
    const outcome = await executeTest(test);
    reportResult(test, outcome.result, outcome.elapsed, outcome.expectCount);
  }

  async function executeTest(test) {
    const chain = scopeChain(test.parent);
    const record = { expectCount: 0, assertions: null };
    currentTest = record;
    const start = now();
    let result = await runHooks(chain.flatMap((s) => s.beforeEach));
    if (result.ok) {
      const timeout = test.timeout === undefined ? options.timeout : test.timeout;
      result = await invoke(test.fn, [], test.usesDone, timeout);
      if (result.timeout) result.timeoutMs = timeout;
    }
    const after = await runHooks(chain.toReversed().flatMap((s) => s.afterEach));
    if (result.ok && !after.ok) result = after;
    const elapsed = now() - start;
    currentTest = null;
    return { result: classify(test, result, record), elapsed, expectCount: record.expectCount };
  }

  function classify(test, result, record) {
    if (test.mode === "todo") return result.ok ? { status: "fail", note: "todoPassed" } : { status: "todo" };
    if (test.failing) return result.ok ? { status: "fail", note: "failingPassed" } : { status: "pass" };
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

  function reportResult(test, result, elapsed, expectCount) {
    summary.expectations += expectCount || 0;
    summary[result.status]++;
    // Agents only see failures.
    const quiet = options.agent && result.status !== "fail";
    if (!quiet) printResult(test, result, elapsed);
    if (result.status === "fail" && options.bail > 0 && summary.fail === options.bail) bailOut();
  }

  function printResult(test, result, elapsed) {
    printFileHeaderIfNeeded();
    if (result.error !== undefined) writeErr(formatErrorText(result.error));
    if (result.assertion) writeErr(`AssertionError: ${result.assertion}\n`);
    const names = displayNames(test).map((name) => ` ${name} >`).join("");
    const time = showsElapsed(result, elapsed) ? ` ${formatElapsed(elapsed)}` : "";
    const line = `(${result.status})${names} ${test.name}${time}\n${resultNote(result)}`;
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
    if (summary.expectations > 0) out += ` ${summary.expectations} expect() calls\n`;
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
      else if (flag === "--todo") options.runTodo = true;
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
      if (activeInvocation) activeInvocation.fail(error);
      else reportUnhandledError(error);
    };
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
  }

  async function runFile(abs, cwd) {
    summary.files++;
    const file = { root: createScope("", null, "run", false), hasOnly: false };
    file.scope = file.root;
    startFileHeader(relativePath(cwd, abs));
    collecting = file;
    try {
      for (const preload of preloads) await internal.importModule(resolveArgument(cwd, preload));
      await internal.importModule(abs);
    } catch (error) {
      // A file that fails to load counts as one failed test.
      reportUnhandledError(error);
      summary.fail++;
      return;
    } finally {
      collecting = null;
    }
    await runScope(file.root, file);
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
    for (const abs of state.files) await runFile(abs, cwd);
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
    mock,
    spyOn,
    jest,
    vi: jest,
    setDefaultTimeout(ms) {
      if (typeof ms !== "number") throw new Error("setTimeout() expects a number (milliseconds)");
      options.timeout = ms;
    },
  };

  return { exports, run };
})
