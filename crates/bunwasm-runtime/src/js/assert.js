// node:assert polyfill. Returns the callable `assert` (= assert.ok) with all
// methods attached; `assert.strict` is the strict-mode variant. Messages follow
// native Bun (Node's assertion_error.js). No source access, so `ok(false)`
// reports "false == true" like Bun rather than echoing the expression.
(function (internal) {
  "use strict";

  const NO_EXCEPTION = Symbol("NO_EXCEPTION");

  function util() {
    return internal.require("util");
  }

  // Node's inspectValue(): stable, expanded, no custom inspectors.
  function inspectValue(value) {
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

  function inspect(value, opts) {
    return internal.require("inspect").nodeInspect(value, opts);
  }

  function makeError(Ctor, code, message) {
    const err = new Ctor(message);
    err.code = code;
    return err;
  }

  function describeReceived(value) {
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

  function invalidArgType(name, expected, value) {
    return makeError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Diff messages
  // ---------------------------------------------------------------------------

  const kReadableOperator = {
    deepStrictEqual: "Expected values to be strictly deep-equal:",
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

  function isObjectLike(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
  }

  function linesEqual(a, b, commaDisparity) {
    if (a === b) return true;
    return commaDisparity && (a + "," === b || a === b + ",");
  }

  // LCS line diff. Entries: [op, line] with op "nop" | "insert" (actual) | "delete" (expected).
  function lineDiff(actual, expected, commaDisparity) {
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
    const out = [];
    let i = 0;
    let j = 0;
    let inserts = [];
    let deletes = [];
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

  function collapsedNops(diff, idx, nopCount) {
    if (nopCount === kNopLinesToCollapse + 1) return { text: `  ${diff[idx - 1][1]}\n`, skipped: false };
    if (nopCount === kNopLinesToCollapse + 2) {
      return { text: `  ${diff[idx - 2][1]}\n  ${diff[idx - 1][1]}\n`, skipped: false };
    }
    if (nopCount >= kNopLinesToCollapse + 3) return { text: `...\n  ${diff[idx - 1][1]}\n`, skipped: true };
    return { text: "", skipped: false };
  }

  function printDiff(diff) {
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

  function stackedDiff(actual, expected) {
    let message = `\n+ ${actual}\n- ${expected}`;
    if (actual.length + expected.length > 80) return message;
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] === expected[i]) continue;
      if (i >= 3) message += `\n${" ".repeat(i + 2)}^`;
      break;
    }
    return message;
  }

  function simpleDiff(actual, inspectedActual, expected, inspectedExpected) {
    let len = inspectedActual.length + inspectedExpected.length;
    if (typeof actual === "string") len -= 2;
    if (typeof expected === "string") len -= 2;
    if (len <= kMaxShortStringLength && (actual !== 0 || expected !== 0)) {
      return { message: `${inspectedActual} !== ${inspectedExpected}`, header: "" };
    }
    return { message: stackedDiff(inspectedActual, inspectedExpected), header: undefined };
  }

  function createErrDiff(actual, expected, operatorName, customMessage) {
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

  function truncate(str, max) {
    return str.length > max ? `${str.slice(0, max - 3)}...` : str;
  }

  function notEqualMessage(actual, operator) {
    let base = kReadableOperator[operator];
    if (operator === "notStrictEqual" && isObjectLike(actual)) base = kReadableOperator.notStrictEqualObject;
    const lines = inspectValue(actual).split("\n");
    if (lines.length === 1) return `${base}${lines[0].length > 5 ? "\n\n" : " "}${lines[0]}`;
    return `${base}\n\n${lines.join("\n")}\n`;
  }

  function otherMessage(actual, expected, operator) {
    let res = inspectValue(actual);
    let other = inspectValue(expected);
    const known = kReadableOperator[operator];
    if (operator === "notDeepEqual" && res === other) return truncate(`${known}\n\n${res}`, 1024);
    res = truncate(res, 512);
    other = truncate(other, 512);
    if (operator === "deepEqual") return `${known}\n\n${res}\n\nshould loosely deep-equal\n\n${other}`;
    const unequal = kReadableOperator[`${operator}Unequal`];
    if (unequal) return `${unequal}\n\n${res}\n\nshould not loosely deep-equal\n\n${other}`;
    return `${res} ${operator} ${other}`;
  }

  function generateMessage(actual, expected, operator) {
    if (operator === "deepStrictEqual" || operator === "strictEqual") return createErrDiff(actual, expected, operator);
    if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") return notEqualMessage(actual, operator);
    return otherMessage(actual, expected, operator);
  }

  // ---------------------------------------------------------------------------
  // AssertionError
  // ---------------------------------------------------------------------------

  class AssertionError extends Error {
    constructor(options) {
      if (options === null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
      const { message, operator, stackStartFn } = options;
      const { actual, expected } = options;
      let text;
      if (message != null) {
        text =
          operator === "deepStrictEqual" || operator === "strictEqual"
            ? createErrDiff(actual, expected, operator, message)
            : String(message);
      } else {
        text = generateMessage(actual, expected, operator);
      }
      super(text);
      this.generatedMessage = !message;
      this.actual = actual;
      this.expected = expected;
      this.operator = operator;
      Object.defineProperty(this, "name", { value: "AssertionError", enumerable: false, writable: true, configurable: true });
      this.code = "ERR_ASSERTION";
      this.diff = "simple";
      if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this, stackStartFn || undefined);
    }

    toString() {
      return `${this.name} [${this.code}]: ${this.message}`;
    }
  }

  function innerFail(obj) {
    if (obj.message instanceof Error) throw obj.message;
    throw new AssertionError(obj);
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  function innerOk(fn, argLen, value, message) {
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

  function requireArgs(count, min) {
    if (count < min) {
      throw makeError(TypeError, "ERR_MISSING_ARGS", 'The "actual" and "expected" arguments must be specified');
    }
  }

  function looseEqual(a, b) {
    return a == b || (a !== a && b !== b);
  }

  function equal(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (!looseEqual(actual, expected)) innerFail({ actual, expected, message, operator: "==", stackStartFn: equal });
  }

  function notEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (looseEqual(actual, expected)) innerFail({ actual, expected, message, operator: "!=", stackStartFn: notEqual });
  }

  function strictEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (!Object.is(actual, expected)) {
      innerFail({ actual, expected, message, operator: "strictEqual", stackStartFn: strictEqual });
    }
  }

  function notStrictEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (Object.is(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notStrictEqual", stackStartFn: notStrictEqual });
    }
  }

  // Bun's loose deep equality is Bun.deepEquals(a, b, false).
  function looseDeepEqual(a, b) {
    return util().bunDeepEquals(a, b, false);
  }

  function strictDeepEqual(a, b) {
    return util().isDeepStrictEqual(a, b);
  }

  function deepEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (!looseDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "deepEqual", stackStartFn: deepEqual });
    }
  }

  function notDeepEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (looseDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notDeepEqual", stackStartFn: notDeepEqual });
    }
  }

  function deepStrictEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (!strictDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "deepStrictEqual", stackStartFn: deepStrictEqual });
    }
  }

  function notDeepStrictEqual(actual, expected, message) {
    requireArgs(arguments.length, 2);
    if (strictDeepEqual(actual, expected)) {
      innerFail({ actual, expected, message, operator: "notDeepStrictEqual", stackStartFn: notDeepStrictEqual });
    }
  }

  let warnedFail = false;

  function fail(actual, expected, message, operator, stackStartFn) {
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

  function isRegExp(value) {
    return util().types.isRegExp(value);
  }

  function isError(value) {
    return util().types.isNativeError(value) || value instanceof Error;
  }

  function internalMatch(string, regexp, message, fn) {
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

  function assertMatch(string, regexp, message) {
    internalMatch(string, regexp, message, assertMatch);
  }
  Object.defineProperty(assertMatch, "name", { value: "match" });

  function doesNotMatch(string, regexp, message) {
    internalMatch(string, regexp, message, doesNotMatch);
  }

  function ifError(err) {
    if (err === null || err === undefined) return;
    let message = "ifError got unwanted exception: ";
    if (typeof err === "object" && typeof err.message === "string") {
      if (err.message.length === 0 && err.constructor) message += err.constructor.name;
      else message += err.message;
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

  function getActual(fn) {
    if (typeof fn !== "function") throw invalidArgType("fn", "of type function", fn);
    try {
      fn();
    } catch (e) {
      return e;
    }
    return NO_EXCEPTION;
  }

  function isPromiseLike(value) {
    return value !== null && typeof value === "object" && typeof value.then === "function" && typeof value.catch === "function";
  }

  async function waitForActual(promiseFn) {
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
    constructor(obj, keys, actual) {
      for (const key of keys) {
        if (!(key in obj)) continue;
        const matchesRegExp =
          actual !== undefined && typeof actual[key] === "string" && isRegExp(obj[key]) && obj[key].test(actual[key]);
        this[key] = matchesRegExp ? actual[key] : obj[key];
      }
    }
  }

  function compareExceptionKey(actual, expected, key, message, keys, fn) {
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

  function validateWithObject(actual, expected, message, fn) {
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
        typeof actual[key] === "string" && isRegExp(expected[key]) && expected[key].test(actual[key]);
      if (!isMatchingRegExp) compareExceptionKey(actual, expected, key, message, keys, fn);
    }
  }

  function wrongClassMessage(actual, expected) {
    let message = `The error is expected to be an instance of "${expected.name}". Received `;
    if (!isError(actual)) return `${message}"${inspect(actual, { depth: -1 })}"`;
    const name = (actual.constructor && actual.constructor.name) || actual.name;
    message += expected.name === name ? "an error with identical name but a different prototype." : `"${name}"`;
    if (actual.message) message += `\n\nError message:\n\n${actual.message}`;
    return message;
  }

  function expectedException(actual, expected, message, fn) {
    let generated = false;
    let text = message;
    if (typeof expected !== "function") {
      if (!isRegExp(expected)) return validateWithObject(actual, expected, message, fn);
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

  function expectsError(stackStartFn, actual, error, message, argCount) {
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
      let details = expected && expected.name ? ` (${expected.name})` : "";
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

  function hasMatchingError(actual, expected) {
    if (typeof expected !== "function") {
      if (isRegExp(expected)) return expected.test(String(actual));
      throw invalidArgType("expected", "of type function or an instance of RegExp", expected);
    }
    if (expected.prototype !== undefined && actual instanceof expected) return true;
    if (Object.prototype.isPrototypeOf.call(Error, expected)) return false;
    return Reflect.apply(expected, {}, [actual]) === true;
  }

  function expectsNoError(stackStartFn, actual, error, message) {
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
        message: `Got unwanted ${fnType}${details}\nActual message: "${actual && actual.message}"`,
        stackStartFn,
      });
    }
    throw actual;
  }

  function throws(promiseFn, error, message) {
    expectsError(throws, getActual(promiseFn), error, message, arguments.length);
  }

  async function rejects(promiseFn, error, message) {
    expectsError(rejects, await waitForActual(promiseFn), error, message, arguments.length);
  }

  function doesNotThrow(fn, error, message) {
    expectsNoError(doesNotThrow, getActual(fn), error, message);
  }

  async function doesNotReject(fn, error, message) {
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

  return assert;
});
