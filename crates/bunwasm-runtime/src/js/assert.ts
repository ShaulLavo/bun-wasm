// node:assert polyfill. Returns the callable `assert` (= assert.ok) with all
// methods attached; `assert.strict` is the strict-mode variant. Messages follow
// native Bun (Node's assertion_error.js). No source access, so `ok(false)`
// reports "false == true" like Bun rather than echoing the expression.
(function (internal: BunWasm.Internal) {
  "use strict";

  const NO_EXCEPTION = Symbol("NO_EXCEPTION");

  function util() {
    return internal.require("util");
  }

  // Node's inspectValue(): stable, expanded, no custom inspectors.
  function inspectValue(value: unknown) {
    return internal.require("inspect").nodeInspect(value, {
      compact: false,
      customInspect: false,
      depth: 1000,
      maxArrayLength: Infinity,
      showHidden: false,
      showProxy: false,
      sorted: true,
      getters: true,
    });
  }

  function inspect(value: unknown, opts?: BunWasm.InspectOptions) {
    return internal.require("inspect").nodeInspect(value, opts);
  }

  function makeError(Ctor: new(message?: string) => BunWasm.UtilityError, code: string, message: string) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value: unknown) {
    if (value === null || value === undefined) return String(value);
    if (typeof value === "function") return `function ${value.name}`;
    if (typeof value === "object") {
      if (value.constructor && value.constructor.name) return `an instance of ${value.constructor.name}`;
      return inspect(value, { depth: -1 });
    }
    if (typeof value === "string") {
      const shown = value.length > 28 ? `${value.slice(0, 25)}...` : value;
      return `type string (${shown.indexOf("'") === -1 ? `'${shown}'` : JSON.stringify(shown)})`;
    }
    if (typeof value === "bigint") return `type bigint (${value}n)`;
    return `type ${typeof value} (${String(value)})`;
  }

  function invalidArgType(name: string, expected: string, value: unknown) {
    return makeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Diff messages
  // ---------------------------------------------------------------------------

  const kReadableOperator: Record<string, string> = {
    deepStrictEqual: "Expected values to be strictly deep-equal:",
    partialDeepStrictEqual: "Expected values to be partially and strictly deep-equal:",
    strictEqual: "Expected values to be strictly equal:",
    strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
    deepEqual: "Expected values to be loosely deep-equal:",
    notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
    notStrictEqual: 'Expected "actual" to be strictly unequal to:',
    notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
    notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
    notIdentical: "Values identical but not reference-equal:",
    notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
  };
  const kMaxShortStringLength = 12;
  const kNopLinesToCollapse = 5;

  function isObjectLike(value: unknown) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
  }

  function linesEqual(a: string, b: string, commaDisparity: boolean) {
    if (a === b) return true;
    return commaDisparity && (a + "," === b || a === b + ",");
  }

  // LCS line diff. Entries: [op, line] with op "nop" | "insert" (actual) | "delete" (expected).
  function lineDiff(actual: string[], expected: string[], commaDisparity: boolean) {
    const n = actual.length;
    const m = expected.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = linesEqual(actual[i], expected[j], commaDisparity)
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const out: BunWasm.AssertionDiff[] = [];
    let i = 0;
    let j = 0;
    let inserts: BunWasm.AssertionDiff[] = [];
    let deletes: BunWasm.AssertionDiff[] = [];
    const flush = () => {
      out.push.apply(out, inserts.concat(deletes));
      inserts = [];
      deletes = [];
    };
    while (i < n || j < m) {
      if (i < n && j < m && linesEqual(actual[i], expected[j], commaDisparity)) {
        flush();
        out.push(["nop", actual[i].length >= expected[j].length ? actual[i] : expected[j]]);
        i++;
        j++;
      } else if (j >= m || (i < n && table[i + 1][j] >= table[i][j + 1])) {
        inserts.push(["insert", actual[i++]]);
      } else {
        deletes.push(["delete", expected[j++]]);
      }
    }
    flush();
    return out;
  }

  function collapsedNops(diff: BunWasm.AssertionDiff[], idx: number, nopCount: number) {
    if (nopCount === kNopLinesToCollapse + 1) return { text: `  ${diff[idx - 1][1]}\n`, skipped: false };
    if (nopCount === kNopLinesToCollapse + 2) {
      return { text: `  ${diff[idx - 2][1]}\n  ${diff[idx - 1][1]}\n`, skipped: false };
    }
    if (nopCount >= kNopLinesToCollapse + 3) return { text: `...\n  ${diff[idx - 1][1]}\n`, skipped: true };
    return { text: "", skipped: false };
  }

  function printDiff(diff: BunWasm.AssertionDiff[]) {
    let message = "";
    let skipped = false;
    let nopCount = 0;
    for (let idx = 0; idx < diff.length; idx++) {
      const [operation, value] = diff[idx];
      const previous = idx > 0 ? diff[idx - 1][0] : null;
      if (previous === "nop" && operation !== "nop") {
        const collapsed = collapsedNops(diff, idx, nopCount);
        message += collapsed.text;
        skipped = skipped || collapsed.skipped;
        nopCount = 0;
      }
      if (operation === "insert") message += `+ ${value}\n`;
      else if (operation === "delete") message += `- ${value}\n`;
      else if (nopCount++ < kNopLinesToCollapse) message += `  ${value}\n`;
    }
    return { message: `\n${message.trimEnd()}`, skipped };
  }

  function stackedDiff(actual: string, expected: string) {
    let message = `\n+ ${actual}\n- ${expected}`;
    if (actual.length + expected.length > 80) return message;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] === expected[i]) continue;
      if (i >= 3) message += `\n${" ".repeat(i + 2)}^`;
      break;
    }
    return message;
  }

  function simpleDiff(actual: unknown, inspectedActual: string, expected: unknown, inspectedExpected: string) {
    let len = inspectedActual.length + inspectedExpected.length;
    if (typeof actual === "string") len -= 2;
    if (typeof expected === "string") len -= 2;
    if (len <= kMaxShortStringLength && (actual !== 0 || expected !== 0)) {
      return { message: `${inspectedActual} !== ${inspectedExpected}`, header: "" };
    }
    return { message: stackedDiff(inspectedActual, inspectedExpected), header: undefined };
  }

  function createErrDiff(actual: unknown, expected: unknown, operatorName: string, customMessage?: unknown) {
    let operator = operatorName;
    if (operator === "strictEqual" && isObjectLike(actual) && isObjectLike(expected)) operator = "strictEqualObject";
    const inspectedActual = inspectValue(actual);
    const inspectedExpected = inspectValue(expected);
    const headerText = customMessage != null ? String(customMessage) : kReadableOperator[operator];

    if (inspectedActual === inspectedExpected) {
      let base = operator === "strictEqualObject" ? "Values have same structure but are not reference-equal:" : kReadableOperator.notIdentical;
      if (customMessage != null) base = String(customMessage);
      return `${base}\n\n${inspectedActual}\n`;
    }

    const actualLines = inspectedActual.split("\n");
    const expectedLines = inspectedExpected.split("\n");
    const isSimple =
      actualLines.length === 1 &&
      expectedLines.length === 1 &&
      (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null);
    let header = "+ actual - expected";
    let message;
    let skipped = false;
    if (isSimple) {
      const simple = simpleDiff(actual, actualLines[0], expected, expectedLines[0]);
      message = simple.message;
      if (simple.header !== undefined) header = simple.header;
    } else {
      const printed = printDiff(lineDiff(actualLines, expectedLines, actual != null && typeof actual === "object"));
      message = printed.message;
      skipped = printed.skipped;
    }
    return `${headerText}\n${header}${skipped ? "\n... Skipped lines" : ""}\n${message}\n`;
  }

  function truncate(str: string, max: number) {
    return str.length > max ? `${str.slice(0, max - 3)}...` : str;
  }

  function notEqualMessage(actual: unknown, operator: string) {
    let base = kReadableOperator[operator];
    if (operator === "notStrictEqual" && isObjectLike(actual)) base = kReadableOperator.notStrictEqualObject;
    const lines = inspectValue(actual).split("\n");
    if (lines.length === 1) return `${base}${lines[0].length > 5 ? "\n\n" : " "}${lines[0]}`;
    return `${base}\n\n${lines.join("\n")}\n`;
  }

  function otherMessage(actual: unknown, expected: unknown, operator: string | undefined) {
    let res = inspectValue(actual);
    let other = inspectValue(expected);
    const known = kReadableOperator[String(operator)];
    if (operator === "notDeepEqual" && res === other) return truncate(`${known}\n\n${res}`, 1024);
    res = truncate(res, 512);
    other = truncate(other, 512);
    if (operator === "deepEqual") return `${known}\n\n${res}\n\nshould loosely deep-equal\n\n${other}`;
    const unequal = kReadableOperator[`${operator}Unequal`];
    if (unequal) return `${unequal}\n\n${res}\n\nshould not loosely deep-equal\n\n${other}`;
    return `${res} ${operator} ${other}`;
  }

  function generateMessage(actual: unknown, expected: unknown, operator: string | undefined) {
    if (operator === "deepStrictEqual" || operator === "strictEqual" || operator === "partialDeepStrictEqual") return createErrDiff(actual, expected, operator);
    if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") return notEqualMessage(actual, operator);
    return otherMessage(actual, expected, operator);
  }

  // ---------------------------------------------------------------------------
  // AssertionError
  // ---------------------------------------------------------------------------

  class AssertionError extends Error {
    declare generatedMessage: boolean;
    declare actual: unknown;
    declare expected: unknown;
    declare operator?: string;
    [key: string]: unknown;
    declare code: string;
    declare diff: string;
    constructor(options: BunWasm.AssertionOptions) {
      if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
      const { message, operator, stackStartFn } = options;
      const { actual, expected } = options;
      let text;
      if (message != null) {
        text =
          operator === "deepStrictEqual" || operator === "strictEqual" || operator === "partialDeepStrictEqual"
            ? createErrDiff(actual, expected, operator, message)
            : String(message);
      } else {
        text = generateMessage(actual, expected, operator);
      }
      super(text);
      this.generatedMessage = !message;
      if (options.details) setDetails(this, options.details);
      else {
        this.actual = actual;
        this.expected = expected;
        this.operator = operator;
      }
      Object.defineProperty(this, "name", { value: "AssertionError", enumerable: false, writable: true, configurable: true });
      this.code = "ERR_ASSERTION";
      this.diff = "simple";
      if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this, stackStartFn || undefined);
    }

    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  }

  function setDetails(error: AssertionError, details: readonly BunWasm.AssertionDetail[]) {
    for (let index = 0; index < details.length; index++) {
      const detail = details[index];
      error["message " + index] = detail.message;
      error["actual " + index] = detail.actual;
      error["expected " + index] = detail.expected;
      error["operator " + index] = detail.operator;
      error["stack trace " + index] = detail.stack;
    }
  }

  // ---------------------------------------------------------------------------
  // CallTracker (Bun's src/js/internal/assert/calltracker.ts, deprecated as DEP0173)
  // ---------------------------------------------------------------------------

  interface CallRecord {
    thisArg: unknown;
    arguments: readonly unknown[];
  }

  class CallTrackerContext {
    #expected: number;
    #calls: CallRecord[] = [];
    #name: string;
    #stackTrace: Error;
    constructor({ expected, stackTrace, name }: { expected: number; stackTrace: Error; name: string }) {
      this.#expected = expected;
      this.#stackTrace = stackTrace;
      this.#name = name;
    }
    track(thisArg: unknown, args: readonly unknown[]) {
      this.#calls.push(Object.freeze({ thisArg, arguments: Object.freeze(Array.prototype.slice.call(args)) }));
    }
    get delta() {
      return this.#calls.length - this.#expected;
    }
    reset() {
      this.#calls = [];
    }
    getCalls() {
      return Object.freeze(this.#calls.slice());
    }
    report(): BunWasm.AssertionDetail | undefined {
      if (this.delta === 0) return undefined;
      const message = `Expected the ${this.#name} function to be executed ${this.#expected} time(s) but was executed ${this.#calls.length} time(s).`;
      return { message, actual: this.#calls.length, expected: this.#expected, operator: this.#name, stack: this.#stackTrace };
    }
  }

  function validateExpectedCalls(expected: unknown): asserts expected is number {
    if (typeof expected !== "number") throw invalidArgType("expected", "of type number", expected);
    if (Number.isInteger(expected) && expected >= 1 && expected <= 0xffffffff) return;
    const range = Number.isInteger(expected) ? ">= 1 && <= 4294967295" : "an integer";
    throw makeError(RangeError, "ERR_OUT_OF_RANGE", `The value of "expected" is out of range. It must be ${range}. Received ${expected}`);
  }

  class CallTracker {
    #callChecks = new Set<CallTrackerContext>();
    #trackedFunctions = new WeakMap<Function, CallTrackerContext>();
    #getTrackedFunction(tracked: Function) {
      if (this.#trackedFunctions.has(tracked)) return this.#trackedFunctions.get(tracked)!;
      throw makeError(TypeError, "ERR_INVALID_ARG_VALUE", `The argument 'tracked' is not a tracked function. Received ${inspect(tracked)}`);
    }
    reset(tracked?: Function) {
      if (tracked === undefined) {
        this.#callChecks.forEach(check => check.reset());
        return;
      }
      this.#getTrackedFunction(tracked).reset();
    }
    getCalls(tracked: Function) {
      return this.#getTrackedFunction(tracked).getCalls();
    }
    calls(fn?: Function | number, expected = 1) {
      if ("_exiting" in globalThis.process && globalThis.process._exiting) {
        throw makeError(Error, "ERR_UNAVAILABLE_DURING_EXIT", "Cannot call function in process exit handler");
      }
      let target: Function;
      if (typeof fn === "number") {
        expected = fn;
        target = () => {};
      } else {
        target = fn === undefined ? () => {} : fn;
      }
      validateExpectedCalls(expected);
      const context = new CallTrackerContext({ expected, stackTrace: new Error(), name: target.name || "calls" });
      const handler = {
        apply(target: Function, thisArg: unknown, argList: unknown[]) {
          context.track(thisArg, argList);
          return Reflect.apply(target, thisArg, argList);
        },
      };
      Object.setPrototypeOf(handler, null);
      const tracked = new Proxy(target, handler);
      this.#callChecks.add(context);
      this.#trackedFunctions.set(tracked, context);
      return tracked;
    }
    report() {
      const errors: BunWasm.AssertionDetail[] = [];
      for (const context of this.#callChecks) {
        const message = context.report();
        if (message !== undefined) errors.push(message);
      }
      return errors;
    }
    verify() {
      const errors = this.report();
      if (errors.length === 0) return;
      const message = errors.length === 1 ? errors[0].message : "Functions were not called the expected number of times";
      throw new AssertionError({ message, details: errors });
    }
  }

  function defineCallTracker(): PropertyDescriptor {
    let tracker: typeof CallTracker | undefined;
    return {
      get() {
        if (tracker === undefined) tracker = util().deprecate(CallTracker, "assert.CallTracker is deprecated.", "DEP0173");
        return tracker;
      },
      set(value) {
        Object.defineProperty(this, "CallTracker", { value, writable: true, enumerable: true, configurable: true });
      },
      configurable: true,
      enumerable: true,
    };
  }

  function innerFail(obj: BunWasm.AssertionOptions): never {
    if (obj.message instanceof Error) throw obj.message;
    throw new AssertionError(obj);
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  function innerOk(fn: Function, argLen: number, value: unknown, message?: unknown) {
    if (value) return;
    let generatedMessage = false;
    let text = message;
    if (argLen === 0) {
      generatedMessage = true;
      text = "No value argument passed to `assert.ok()`";
    } else if (message == null) {
      generatedMessage = true;
      text = `${inspect(value)} == true`;
    } else if (message instanceof Error) {
      throw message;
    }
    const err = new AssertionError({ actual: value, expected: true, message: text, operator: "==", stackStartFn: fn });
    err.generatedMessage = generatedMessage;
    throw err;
  }

  function ok() {
    innerOk(ok, arguments.length, arguments[0], arguments[1]);
  }

  function requireArgs(count: number, min: number) {
    if (count < min) {
      throw makeError(TypeError, "ERR_MISSING_ARGS", 'The "actual" and "expected" arguments must be specified');
    }
  }

  function looseEqual(a: unknown, b: unknown) {
    return a == b || (a !== a && b !== b);
  }

  function equal(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (!looseEqual(actual, expected)) innerFail({ actual, expected, message, operator: "==", stackStartFn: equal });
  }

  function notEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (looseEqual(actual, expected)) innerFail({ actual, expected, message, operator: "!=", stackStartFn: notEqual });
  }

  function strictEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (!Object.is(actual, expected)) {
      innerFail({ actual, expected, message, operator: "strictEqual", stackStartFn: strictEqual });
    }
  }

  function notStrictEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (Object.is(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notStrictEqual", stackStartFn: notStrictEqual });
    }
  }

  // Bun's loose deep equality is Bun.deepEquals(a, b, false).
  function looseDeepEqual(a: unknown, b: unknown) {
    return util().bunDeepEquals(a, b, false);
  }

  function strictDeepEqual(a: unknown, b: unknown) {
    return util().isDeepStrictEqual(a, b);
  }

  function deepEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (!looseDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "deepEqual", stackStartFn: deepEqual });
    }
  }

  function notDeepEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (looseDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notDeepEqual", stackStartFn: notDeepEqual });
    }
  }

  function deepStrictEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (!strictDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: deepStrictEqual });
    }
  }

  function notDeepStrictEqual(actual?: unknown, expected?: unknown, message?: unknown) {
    requireArgs(arguments.length, 2);
    if (strictDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notDeepStrictEqual", stackStartFn: notDeepStrictEqual });
    }
  }

  let warnedFail = false;

  function fail(actual?: unknown, expected?: unknown, message?: unknown, operator?: string, stackStartFn?: Function) {
    const argsLen = arguments.length;
    if (argsLen === 0) {
      const err = new AssertionError({ message: "Failed", operator: "fail", stackStartFn: fail });
      err.generatedMessage = true;
      throw err;
    }
    if (argsLen === 1) {
      if (actual instanceof Error) throw actual;
      innerFail({ message: actual, operator: "fail", stackStartFn: fail });
    }
    if (!warnedFail && typeof process !== "undefined" && typeof process.emitWarning === "function") {
      warnedFail = true;
      process.emitWarning(
        "assert.fail() with more than one argument is deprecated. Please use assert.strictEqual() instead or only pass a message.",
        "DeprecationWarning",
        "DEP0094",
      );
    }
    const op = argsLen === 2 ? "!=" : operator === undefined ? "fail" : operator;
    const err = new AssertionError({ actual, expected, message, operator: op, stackStartFn: stackStartFn || fail });
    if (argsLen === 2 || message === undefined) err.generatedMessage = true;
    throw err;
  }

  function isRegExp(value: unknown): value is RegExp {
    return util().types.isRegExp(value);
  }

  function isError(value: unknown): value is Error {
    return util().types.isNativeError(value) || value instanceof Error;
  }

  function internalMatch(string: unknown, regexp: unknown, message: unknown, fn: Function) {
    if (!isRegExp(regexp)) throw invalidArgType("regexp", "an instance of RegExp", regexp);
    const match = fn === assertMatch;
    if (typeof string === "string" && regexp.test(string) === match) return;
    if (message instanceof Error) throw message;
    const generatedMessage = !message;
    const text =
      message ||
      (typeof string !== "string"
        ? `The "string" argument must be of type string. Received ${describeReceived(string)}`
        : (match
            ? "The input did not match the regular expression "
            : "The input was expected to not match the regular expression ") +
          `${inspect(regexp)}. Input:\n\n${inspect(string)}\n`);
    const err = new AssertionError({ actual: string, expected: regexp, message: text, operator: fn.name, stackStartFn: fn });
    err.generatedMessage = generatedMessage;
    throw err;
  }

  function assertMatch(string: unknown, regexp: unknown, message?: unknown) {
    internalMatch(string, regexp, message, assertMatch);
  }
  Object.defineProperty(assertMatch, "name", { value: "match" });

  function doesNotMatch(string: unknown, regexp: unknown, message?: unknown) {
    internalMatch(string, regexp, message, doesNotMatch);
  }

  function ifError(err: unknown) {
    if (err === null || err === undefined) return;
    let message = "ifError got unwanted exception: ";
    if (typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
      if ((err as { message: string }).message.length === 0 && err.constructor) message += err.constructor.name;
      else message += (err as { message: string }).message;
    } else {
      message += inspect(err);
    }
    const newErr = new AssertionError({ actual: err, expected: null, operator: "ifError", message, stackStartFn: ifError });
    newErr.generatedMessage = false;
    throw newErr;
  }

  // ---------------------------------------------------------------------------
  // throws / rejects
  // ---------------------------------------------------------------------------

  function getActual(fn: unknown) {
    if (typeof fn !== "function") throw invalidArgType("fn", "of type function", fn);
    try {
      fn();
    } catch (e) {
      return e;
    }
    return NO_EXCEPTION;
  }

  function isPromiseLike(value: unknown): value is PromiseLike<unknown> & { catch: Function } {
    return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function" && typeof (value as { catch?: unknown }).catch === "function";
  }

  async function waitForActual(promiseFn: unknown) {
    let resultPromise;
    if (typeof promiseFn === "function") {
      resultPromise = promiseFn();
      if (!isPromiseLike(resultPromise)) {
        throw makeError(
          TypeError,
          "ERR_INVALID_RETURN_VALUE",
          `Expected instance of Promise to be returned from the "promiseFn" function but got ${describeReceived(resultPromise)}.`,
        );
      }
    } else if (isPromiseLike(promiseFn)) {
      resultPromise = promiseFn;
    } else {
      throw invalidArgType("promiseFn", "of type function or an instance of Promise", promiseFn);
    }
    try {
      await resultPromise;
    } catch (e) {
      return e;
    }
    return NO_EXCEPTION;
  }

  class Comparison {
    [key: string]: unknown;
    constructor(obj: Record<string, unknown>, keys: string[], actual?: Record<string, unknown>) {
      for (const key of keys) {
        if (!(key in obj)) continue;
        const matchesRegExp =
          actual !== undefined && typeof actual[key] === "string" && isRegExp(obj[key]) && obj[key].test(actual[key]);
        this[key] = matchesRegExp ? actual[key] : obj[key];
      }
    }
  }

  function compareExceptionKey(actual: Record<string, unknown>, expected: Record<string, unknown>, key: string, message: unknown, keys: string[], fn: Function) {
    if (key in actual && strictDeepEqual(actual[key], expected[key])) return;
    if (!message) {
      const a = new Comparison(actual, keys);
      const b = new Comparison(expected, keys, actual);
      const err = new AssertionError({ actual: a, expected: b, operator: "deepStrictEqual", stackStartFn: fn });
      err.actual = actual;
      err.expected = expected;
      err.operator = fn.name;
      throw err;
    }
    innerFail({ actual, expected, message, operator: fn.name, stackStartFn: fn });
  }

  function validateWithObject(actual: unknown, expected: Record<string, unknown>, message: unknown, fn: Function) {
    if (typeof actual !== "object" || actual === null) {
      const err = new AssertionError({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: fn });
      err.operator = fn.name;
      throw err;
    }
    const keys = Object.keys(expected);
    if (expected instanceof Error) keys.push("name", "message");
    else if (keys.length === 0) {
      throw makeError(TypeError, "ERR_INVALID_ARG_VALUE", "The argument 'error' may not be an empty object. Received {}");
    }
    for (const key of keys) {
      const isMatchingRegExp =
        typeof (actual as Record<string, unknown>)[key] === "string" && isRegExp(expected[key]) && expected[key].test((actual as Record<string, string>)[key]);
      if (!isMatchingRegExp) compareExceptionKey(actual as Record<string, unknown>, expected, key, message, keys, fn);
    }
  }

  function wrongClassMessage(actual: unknown, expected: Function) {
    let message = `The error is expected to be an instance of "${expected.name}". Received `;
    if (!isError(actual)) return `${message}"${inspect(actual, { depth: -1 })}"`;
    const name = (actual.constructor && actual.constructor.name) || actual.name;
    message += expected.name === name ? "an error with identical name but a different prototype." : `"${name}"`;
    if (actual.message) message += `\n\nError message:\n\n${actual.message}`;
    return message;
  }

  function expectedException(actual: unknown, expected: object, message: unknown, fn: Function) {
    let generated = false;
    let text = message;
    if (typeof expected !== "function") {
      if (!isRegExp(expected)) return validateWithObject(actual, expected as Record<string, unknown>, message, fn);
      const str = String(actual);
      if (expected.test(str)) return undefined;
      if (!text) {
        generated = true;
        text = `The input did not match the regular expression ${inspect(expected)}. Input:\n\n${inspect(str)}\n`;
      }
    } else if (expected.prototype !== undefined && actual instanceof expected) {
      return undefined;
    } else if (Object.prototype.isPrototypeOf.call(Error, expected) || expected === Error) {
      if (!text) {
        generated = true;
        text = wrongClassMessage(actual, expected);
      }
    } else {
      const res = Reflect.apply(expected, {}, [actual]);
      if (res === true) return undefined;
      if (!text) {
        generated = true;
        const name = expected.name ? `"${expected.name}" ` : "";
        text = `The ${name}validation function is expected to return "true". Received ${inspect(res)}`;
        if (isError(actual)) text += `\n\nCaught error:\n\n${actual}`;
      }
    }
    const err = new AssertionError({ actual, expected, message: text, operator: fn.name, stackStartFn: fn });
    err.generatedMessage = generated;
    throw err;
  }

  function expectsError(stackStartFn: Function, actual: unknown, error: unknown, message: unknown, argCount: number) {
    let expected = error;
    let text = message;
    if (typeof expected === "string") {
      if (argCount === 3) throw invalidArgType("error", "of type function or an instance of Error, RegExp, or Object", expected);
      text = expected;
      expected = undefined;
    } else if (expected != null && typeof expected !== "object" && typeof expected !== "function") {
      throw invalidArgType("error", "of type function or an instance of Error, RegExp, or Object", expected);
    }
    if (actual === NO_EXCEPTION) {
      let details = expected && (expected as { name?: unknown }).name ? ` (${(expected as { name?: unknown }).name})` : "";
      details += text ? `: ${text}` : ".";
      const fnType = stackStartFn === rejects ? "rejection" : "exception";
      innerFail({
        actual: undefined,
        expected,
        operator: stackStartFn.name,
        message: `Missing expected ${fnType}${details}`,
        stackStartFn,
      });
    }
    if (expected) expectedException(actual, expected, text, stackStartFn);
  }

  function hasMatchingError(actual: unknown, expected: unknown) {
    if (typeof expected !== "function") {
      if (isRegExp(expected)) return expected.test(String(actual));
      throw invalidArgType("expected", "of type function or an instance of RegExp", expected);
    }
    if (expected.prototype !== undefined && actual instanceof expected) return true;
    if (Object.prototype.isPrototypeOf.call(Error, expected)) return false;
    return Reflect.apply(expected, {}, [actual]) === true;
  }

  function expectsNoError(stackStartFn: Function, actual: unknown, error: unknown, message: unknown) {
    if (actual === NO_EXCEPTION) return;
    let expected = error;
    let text = message;
    if (typeof expected === "string") {
      text = expected;
      expected = undefined;
    }
    if (!expected || hasMatchingError(actual, expected)) {
      const details = text ? `: ${text}` : ".";
      const fnType = stackStartFn === doesNotReject ? "rejection" : "exception";
      innerFail({
        actual,
        expected,
        operator: stackStartFn.name,
        message: `Got unwanted ${fnType}${details}\nActual message: "${actual && (actual as { message?: unknown }).message}"`,
        stackStartFn,
      });
    }
    throw actual;
  }

  function throws(promiseFn: unknown, error?: unknown, message?: unknown) {
    expectsError(throws, getActual(promiseFn), error, message, arguments.length);
  }

  async function rejects(promiseFn: unknown, error?: unknown, message?: unknown) {
    expectsError(rejects, await waitForActual(promiseFn), error, message, arguments.length);
  }

  function doesNotThrow(fn: unknown, error?: unknown, message?: unknown) {
    expectsNoError(doesNotThrow, getActual(fn), error, message);
  }

  async function doesNotReject(fn: unknown, error?: unknown, message?: unknown) {
    expectsNoError(doesNotReject, await waitForActual(fn), error, message);
  }

  // ---------------------------------------------------------------------------
  // Module object
  // ---------------------------------------------------------------------------

  function assert() {
    innerOk(assert, arguments.length, arguments[0], arguments[1]);
  }

  const methods = {
    ok,
    equal,
    notEqual,
    strictEqual,
    notStrictEqual,
    deepEqual,
    notDeepEqual,
    deepStrictEqual,
    partialDeepStrictEqual: internal.require("partial_assert").create(innerFail, requireArgs),
    notDeepStrictEqual,
    throws,
    doesNotThrow,
    rejects,
    doesNotReject,
    fail,
    match: assertMatch,
    doesNotMatch,
    ifError,
    AssertionError,
  };
  Object.assign(assert, methods);

  function strict() {
    innerOk(strict, arguments.length, arguments[0], arguments[1]);
  }
  Object.assign(strict, methods, {
    equal: strictEqual,
    notEqual: notStrictEqual,
    deepEqual: deepStrictEqual,
    notDeepEqual: notDeepStrictEqual,
  });

  assert.strict = strict;
  strict.strict = strict;
  const callTrackerDescriptor = defineCallTracker();
  Object.defineProperty(assert, "CallTracker", callTrackerDescriptor);
  Object.defineProperty(strict, "CallTracker", callTrackerDescriptor);

  return assert;
});
