import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { constructorCode, keysCode, restoreDestinations } from "./runtime-util-equivalence.ts";

interface Result { values: Record<PropertyKey, unknown>; positionals: unknown[]; tokens?: ({ kind: "option"; name: unknown; rawName: unknown; value: unknown } | { kind: "positional"; value: unknown } | { kind: "option-terminator" })[] }
interface Parser { parseArgs(config: unknown): Result }

function parser(text: string): Parser {
  return runInNewContext(text)({ require: () => ({ nodeInspect: (value: unknown) => String(value) }) });
}

function rawParserControls(text: string) {
  const { parseArgs } = parser(text);
  const observations: unknown[] = [];
  const raws = [1, true, {}, null, undefined, Symbol("raw")];
  for (const raw of raws) {
    if (raw == null) {
      let observed: unknown;
      try { parseArgs({ args: [raw], allowPositionals: true, tokens: true }); } catch (error) { observed = error; }
      assert.equal(String(observed), `TypeError: Cannot read properties of ${raw} (reading 'length')`);
      observations.push([typeof raw, String(observed)]);
      continue;
    }
    const result = parseArgs({ args: [raw], allowPositionals: true, tokens: true });
    assert.equal(result.positionals[0], raw);
    assert.equal(result.tokens?.[0]?.kind, "positional");
    assert.equal(result.tokens?.[0] && "value" in result.tokens[0] ? result.tokens[0].value : undefined, raw);
    observations.push([typeof raw, "same positional and token identity"]);
  }
  const endedArgs: unknown[] = ["--"];
  const ended = parseArgs({ args: endedArgs.concat(raws), tokens: true, allowPositionals: true });
  raws.forEach((value, index) => assert.equal(ended.positionals[index], value));
  for (const value of [true, {}, Symbol("option")]) {
    const result = parseArgs({ args: ["--file", value], options: { file: { type: "string" } }, strict: false, tokens: true });
    assert.equal(result.values.file, value);
    const token = result.tokens?.[0];
    assert.equal(token?.kind === "option" ? token.value : undefined, value);
  }
  for (const config of [{ args: [1] }, { args: ["--file", true], options: { file: { type: "string" } } }]) {
    assert.throws(() => parseArgs(config));
    try { parseArgs(config); } catch (error) { observations.push(String(error)); }
  }
  return observations;
}

function shortControls(text: string) {
  const { parseArgs } = parser(text);
  return [1, true, {}, Symbol("short"), null, undefined].map(name => {
    const events: string[] = [];
    const raw = { get length() { events.push("length"); return 2; }, get 0() { events.push("0"); return "-"; }, get 1() { events.push("1"); return name; } };
    const result = parseArgs({ args: [raw], strict: false, tokens: true });
    const token = result.tokens?.[0];
    assert.equal(token?.kind, "option");
    if (token?.kind !== "option") throw new Error("Expected option");
    assert.equal(token.name, name);
    assert.equal(token.rawName, raw);
    assert.equal(result.values[typeof name === "symbol" ? name : String(name)], true);
    return { name: typeof name, events };
  });
}

function methodControls(text: string, inline: boolean) {
  const events: unknown[] = [];
  const rawName = { [Symbol.toPrimitive](hint: string) { events.push(["name coercion", hint]); return "file"; } };
  const equalIndex = { [Symbol.toPrimitive](hint: string) { events.push(["index coercion", hint]); return "2"; } };
  const value = {};
  const raw = {
    get length() { events.push("length"); return 5; },
    get 0() { events.push("0"); return "?"; },
    startsWith(prefix: unknown) { assert.equal(this, raw); events.push(["startsWith", prefix]); return {}; },
    includes(needle: unknown, start: unknown) { assert.equal(this, raw); events.push(["includes", needle, start]); return inline; },
    indexOf(needle: unknown) { assert.equal(this, raw); events.push(["indexOf", needle]); return equalIndex; },
    slice(start: unknown, end: unknown) {
      assert.equal(this, raw);
      events.push(["slice", start, end === equalIndex ? "index identity" : end]);
      return start === 2 ? rawName : value;
    },
  };
  const result = parser(text).parseArgs({ args: [raw], strict: false, tokens: true });
  const token = result.tokens?.[0];
  if (token?.kind !== "option") throw new Error("Expected raw long option");
  assert.equal(token.name, rawName);
  assert.equal(token.rawName, inline ? "--file" : raw);
  assert.equal(token.value, inline ? value : undefined);
  assert.equal(result.values.file, inline ? value : true);
  if (inline) assert(events.some(event => Array.isArray(event) && event[0] === "slice" && event[1] === "21"));
  return events;
}

function changingReadControls(text: string) {
  const events: string[] = [];
  let reads = 0;
  const raw = { length: 2, 0: "-", get 1() { events.push("1"); return ++reads === 1 ? "x" : true; } };
  const result = parser(text).parseArgs({ args: [raw], strict: false, tokens: true });
  const token = result.tokens?.[0];
  assert.equal(token?.kind === "option" ? token.name : undefined, true);
  assert.equal(result.values.true, true);
  return events;
}

function negativeNameControls(text: string) {
  const events: string[] = [];
  const positive = Symbol("positive");
  const name = {
    [Symbol.toPrimitive](hint: string) { events.push(`key:${hint}`); return "no-file"; },
    startsWith(prefix: unknown) { assert.equal(this, name); events.push(`startsWith:${prefix}`); return {}; },
    slice(start: unknown) { assert.equal(this, name); events.push(`slice:${start}`); return positive; },
  };
  const raw = { length: 2, 0: "-", 1: name };
  const result = parser(text).parseArgs({ args: [raw], options: { [positive]: { type: "boolean" } }, allowNegative: true, strict: false, tokens: true });
  const token = result.tokens?.[0];
  assert.equal(token?.kind === "option" ? token.name : undefined, positive);
  assert.equal(result.values[positive], false);
  return events;
}

function throwingControls(text: string, operation: string) {
  const marker = new Error(operation);
  const events: string[] = [];
  const raw = new Proxy({ length: 5, 0: "?" }, {
    get(target, key, receiver) {
      events.push(String(key));
      if (key === operation) throw marker;
      if (["startsWith", "includes", "slice", "indexOf"].includes(String(key))) return () => key === "includes" ? true : key === "slice" ? "file" : true;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(() => parser(text).parseArgs({ args: [raw], strict: false }), error => error === marker);
  return events;
}

function parserControls(text: string) {
  return {
    raw: rawParserControls(text), short: shortControls(text),
    long: methodControls(text, false), inline: methodControls(text, true), changing: changingReadControls(text), negative: negativeNameControls(text),
    throws: ["length", "0", "startsWith", "includes", "slice", "indexOf"].map(operation => throwingControls(text, operation)),
  };
}

function eventRecorder(failAt: number) {
  const events: string[] = [];
  const marker = {};
  function event(value: string) {
    events.push(value);
    if (events.length === failAt) throw marker;
  }
  return { events, marker, event };
}

export function constructorControl(code: string, failAt = -1) {
  const { events, marker, event } = eventRecorder(failAt);
  const identities = new Map<unknown, string>();
  const sandbox: Record<string, unknown> = { event };
  runInNewContext('const concat = Array.prototype.concat; Object.defineProperty(Array.prototype, "concat", { get() { event("concat:get"); return function(...args) { event("concat:call"); return Reflect.apply(concat, this, args); }; } });', sandbox);
  const names = ["Object", "Array", "Function", "RegExp", "Promise", "String", "Symbol", "BigInt", "Boolean", "Number", "Date", "Error", "Map", "Set", "WeakMap", "WeakSet", "ArrayBuffer", "DataView", "Int8Array", "Int16Array", "Int32Array", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array", "Float16Array"];
  let sets = 0;
  const capturedSet: Function = new Proxy(function () {}, { construct(_target, args: unknown[], newTarget) {
    event("construct");
    assert.equal(newTarget, capturedSet);
    assert(Array.isArray(args[0]));
    return { items: Array.from(args[0], item => identities.get(item)) };
  } });
  for (const name of names) {
    const identity = function () {};
    identities.set(identity, name);
    Object.defineProperty(sandbox, name, { configurable: true, get() { event(name); return name === "Set" && ++sets === 1 ? capturedSet : identity; } });
  }
  try { return { events, result: runInNewContext(code, sandbox), threw: false }; }
  catch (error) { assert.equal(error, marker); return { events, threw: true }; }
}

export function keyControl(code: string, failAt = -1) {
  const { events, marker, event } = eventRecorder(failAt);
  const first = ["string"];
  const symbol = Symbol("enumerable");
  const symbols = [symbol, Symbol("hidden")];
  const result = {};
  const obj = new Proxy({}, { ownKeys() { event("ownKeys"); return ["string", symbol]; }, getOwnPropertyDescriptor(_target, key) { event(`descriptor:${String(key)}`); return { enumerable: true, configurable: true }; } });
  const concat = function (this: unknown, input: unknown) { event("concat:call"); assert.equal(this, first); assert.deepEqual(input, [symbol]); return result; };
  Object.defineProperty(first, "concat", { get() { event("concat:get"); return concat; } });
  const filter = symbols.filter;
  Object.defineProperty(symbols, "filter", { get() { event("filter:get"); return function (this: unknown, predicate: (value: symbol) => unknown) { event("filter:call"); assert.equal(this, symbols); return Reflect.apply(filter, this, [predicate]); }; } });
  const propertyIsEnumerable = function (this: unknown, key: symbol) { event(`enumerable:${String(key)}`); assert.equal(this, obj); return key === symbol; };
  const prototype = { get propertyIsEnumerable() { event("propertyIsEnumerable:get"); return propertyIsEnumerable; } };
  const ObjectView = {
    get prototype() { event("prototype:get"); return prototype; },
    get keys() { event("keys:get"); return function (this: unknown, input: unknown) { event("keys:call"); assert.equal(this, ObjectView); assert.equal(input, obj); Object.keys(obj); return first; }; },
    get getOwnPropertySymbols() { event("symbols:get"); return function (this: unknown, input: unknown) { event("symbols:call"); assert.equal(this, ObjectView); assert.equal(input, obj); Object.getOwnPropertySymbols(obj); return symbols; }; },
  };
  try { assert.equal(runInNewContext(code, { Object: ObjectView, obj }), result); return { events, threw: false }; }
  catch (error) { assert.equal(error, marker); return { events, threw: true }; }
}

function controls(original: string, emitted: string) {
  const beforeParser = parserControls(original);
  const afterParser = parserControls(emitted);
  assert.deepEqual(afterParser, beforeParser);
  const beforeConstructors = constructorCode(original, false);
  const afterConstructors = constructorCode(emitted, true);
  const beforeKeys = keysCode(original);
  const afterKeys = keysCode(emitted);
  const constructors = constructorControl(beforeConstructors);
  const keys = keyControl(beforeKeys);
  assert.deepEqual(constructorControl(afterConstructors), constructors);
  assert.deepEqual(keyControl(afterKeys), keys);
  for (let index = 1; index <= constructors.events.length; index++) assert.deepEqual(constructorControl(afterConstructors, index), constructorControl(beforeConstructors, index));
  for (let index = 1; index <= keys.events.length; index++) assert.deepEqual(keyControl(afterKeys, index), keyControl(beforeKeys, index));
  return { parser: afterParser, constructors, keys, constructorFaults: constructors.events.length, keyFaults: keys.events.length };
}

if (import.meta.main) {
  const [path, receipt, originalPath] = process.argv.slice(2);
  if (!path || !receipt) throw new Error("Expected emitted module and receipt paths");
  const emitted = readFileSync(path, "utf8");
  const original = originalPath ? readFileSync(originalPath, "utf8") : restoreDestinations(emitted);
  const result = controls(original, emitted);
  writeFileSync(receipt, JSON.stringify({ node: process.version, original: originalPath ?? "AST-pinned reversal of the two extractions", ...result }, null, 2) + "\n");
  console.log("PASS original and corrected parser identities/errors/reads and both destination extractions with per-event faults");
}
