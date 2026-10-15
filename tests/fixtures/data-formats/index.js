import assert from "node:assert/strict";
import { TOML, YAML, JSON5, JSONC, JSONL } from "bun";
import toml from "./config.toml";
import yaml from "./config.yaml";
import json5 from "./config.json5";
import jsonc from "./config.jsonc";
assert.deepEqual(toml, { title: "Bun", server: { port: 3000 } });
assert.deepEqual(yaml, { title: "Bun", list: [1, true] });
assert.deepEqual(json5, { title: "Bun", value: Infinity });
assert.deepEqual(jsonc, { title: "Bun" });
assert.deepEqual(require("./config.toml").default || require("./config.toml"), toml);
assert.deepEqual(require("./config.yaml").default || require("./config.yaml"), yaml);
assert.deepEqual(require("./config.json5").default || require("./config.json5"), json5);
console.log("TOML/YAML/JSON5/JSONC imports and require");
for (const [parser, source, value] of [
  [TOML, "a = 1", { a: 1 }],
  [YAML, "a: 1", { a: 1 }],
  [JSON5, "{a: 1,}", { a: 1 }],
]) {
  assert.deepEqual(parser.parse(source), value);
  const padded = Buffer.from("---" + source + "---");
  assert.deepEqual(parser.parse(padded.subarray(3, 3 + source.length)), value);
  const view = new DataView(padded.buffer, padded.byteOffset + 3, source.length);
  assert.deepEqual(parser.parse(view), value);
  assert.deepEqual(parser.parse(new Blob([source])), value);
  assert.deepEqual(parser.parse(parser.stringify(value)), value);
}
assert.deepEqual(JSONC.parse('{ /* comment */ "a": 1, }'), { a: 1 });
assert.throws(() => JSONC.parse(""), { name: "SyntaxError", message: "JSONC Parse error: Unexpected end of input" });
assert.throws(() => TOML.parse("a = \"unterminated"), SyntaxError);
assert.throws(() => JSON5.parse("{a:"), SyntaxError);
assert.throws(() => YAML.parse("[a"), SyntaxError);
assert.equal(YAML.parse(undefined), "undefined");
assert.equal(YAML.parse(null), null);
const proto = TOML.parse('"__proto__" = { safe = true }');
assert.equal(Object.getPrototypeOf(proto), Object.prototype);
assert.equal(Object.hasOwn(proto, "__proto__"), true);
assert.equal({}.safe, undefined);
const alias = YAML.parse("a: &a [1]\nb: *a");
assert.strictEqual(alias.a, alias.b);
const cycle = YAML.parse("&a [*a]");
assert.strictEqual(cycle, cycle[0]);
const revived = YAML.parse(YAML.stringify(cycle));
assert.strictEqual(revived, revived[0]);
assert.equal(JSON5.parse("[NaN, Infinity, -Infinity]")[1], Infinity);
assert.equal(Object.is(TOML.parse("a = -0.0").a, -0), true);
assert.equal(JSON5.parse('"\\ud800"').charCodeAt(0), 0xd800);
assert.deepEqual(JSONC.parse("/* " + "[".repeat(1000) + " */ {\"a\":1}"), { a: 1 });
try {
  assert.equal(Array.isArray(JSONC.parse("[".repeat(50000) + "]".repeat(50000))), true);
} catch (err) {
  assert.equal(err instanceof RangeError, true);
}
console.log("parser bytes/errors/aliases/prototypes/numbers");
assert.deepEqual(YAML.parse(YAML.stringify({ a: [1, true], b: "true" }, null, 2)), { a: [1, true], b: "true" });
assert.equal(JSON5.stringify({ a: "x" }), "{a:'x'}");
assert.equal(TOML.stringify({ a: 1 }), "a = 1\n");
const dates = TOML.parse("day = 1979-05-27\nlocal = 1979-05-27T07:32:00\ntime = 07:32:00.123456789\ninstant = 1979-05-27T00:32:00-07:00");
assert.equal(dates.day.toString(), "1979-05-27");
assert.equal(dates.local.toString(), "1979-05-27T07:32:00");
assert.equal(dates.time.toString(), "07:32:00.123456789");
assert.equal(dates.instant.toString(), "1979-05-27T07:32:00Z");
assert.equal(dates.instant.epochMilliseconds, 296638320000);
assert.equal(TOML.parse(TOML.stringify(dates)).time.toString(), dates.time.toString());
console.log("serialization and Temporal values");
const chunk = JSONL.parseChunk('{"a":1}\n{"b":');
assert.deepEqual(chunk.values, [{ a: 1 }]);
assert.equal(chunk.read, 7);
assert.equal(chunk.done, false);
assert.equal(chunk.error, null);
assert.deepEqual(JSONL.parse('{"a":[1,{"b":true}]}\n42\ninvalid'), [{ a: [1, { b: true }] }, 42]);
assert.deepEqual(JSONL.parse("{"), []);
assert.throws(() => JSONL.parse("{bad}\n"), { name: "SyntaxError", message: "Failed to parse JSONL" });
const bytes = Buffer.from('junk{"e":"🎉"}\n{"a":1}tail');
const result = JSONL.parseChunk(bytes, 4, bytes.length - 4);
assert.equal(result.read, bytes.length - 4);
assert.equal(result.done, true);
assert.deepEqual(result.values, [{ e: "🎉" }, { a: 1 }]);
console.log("JSONL streaming/offsets/partial/error");
