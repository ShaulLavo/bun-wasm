import assert from "node:assert";
import util from "node:util";

const cycle: { value: number; self?: unknown } = { value: 1 };
cycle.self = cycle;
const other: typeof cycle = { value: 1 };
other.self = other;
assert.deepStrictEqual(cycle, other);
assert.deepStrictEqual(new Set([{ x: 1 }, 2]), new Set([2, { x: 1 }]));
assert.deepStrictEqual(new Map([[{ x: 1 }, [2]]]), new Map([[{ x: 1 }, [2]]]));
assert.notDeepStrictEqual(new Uint8Array([1]), new Uint8Array([2]));
assert.notDeepStrictEqual([, 1], [undefined, 1]);
assert.strict.equal(1, 1);
assert.throws(() => { throw Object.assign(new Error("marker"), { code: "MARK" }); }, { message: /mark/, code: "MARK" });
assert.doesNotThrow(() => assert.match("marker", /mark/));
assert.throws(() => assert.equal(), { code: "ERR_MISSING_ARGS" });
const custom = new Error("original");
try { assert.ok(false, custom); } catch (error) { assert.strictEqual(error, custom); }
const failure = new assert.AssertionError({ actual: 1, expected: 2, operator: "strictEqual" });
assert.equal(failure.code, "ERR_ASSERTION");
assert.equal(failure.generatedMessage, true);
assert.equal(failure.toString().includes("AssertionError [ERR_ASSERTION]"), true);
assert.equal(Object.getOwnPropertyDescriptor(failure, "name")?.enumerable, false);
console.log("assert sync", util.isDeepStrictEqual(cycle, other), failure.message.includes("1 !== 2"));

const parsed = util.parseArgs({
  args: ["-vfvalue", "--no-color", "tail"],
  options: { verbose: { type: "boolean", short: "v" }, file: { type: "string", short: "f" }, color: { type: "boolean", default: true } },
  tokens: true, allowPositionals: true, allowNegative: true,
});
console.log("args", JSON.stringify(parsed.values), parsed.positionals.join(","), parsed.tokens?.map(token => token.kind).join(","));
console.log("strings", util.stripVTControlCharacters("\x1b[31mred\x1b[39m"), util.toUSVString("a\ud800b"), util.styleText("red", "text", { validateStream: false }) === "\x1b[31mtext\x1b[39m");
console.log("types", util.types.isDate(new Date()), util.types.isRegExp(/x/), util.types.isTypedArray(new Uint16Array()), util.types.isMap(new Map()), util.types.isSet(new Set()), util.types.isBoxedPrimitive(new Number(1)));
console.log("format", util.format("%s:%d", "value", 7), util.inspect({ a: [1] }, { depth: 0 }));
const customized = Object.assign(function () {}, { [util.promisify.custom]: async () => 42 });
console.log("promisify custom", await util.promisify(customized)());
const receiver = { base: 4, fn: util.promisify(function (this: { base: number }, value: number, callback: (error: null, value: number) => void) { callback(null, this.base + value); }) };
console.log("promisify receiver", await receiver.fn(3));
await assert.rejects(Promise.reject(new TypeError("marker")), { name: "TypeError", message: /mark/ });
await assert.doesNotReject(Promise.resolve(1));
await new Promise<void>(resolve => {
  util.callbackify(async () => { throw 0; })((error: unknown) => {
    assert.equal(error instanceof Error, true);
    console.log("callback falsy", (error as Error & { code: string; reason: unknown }).code, (error as Error & { reason: unknown }).reason);
    resolve();
  });
});
console.log("assert async ok");

function assertionStackMarker() { assert.strictEqual(1, 2); }
function utilityStackMarker() { Reflect.apply(util.stripVTControlCharacters, null, [1]); }
for (const marker of [assertionStackMarker, utilityStackMarker]) {
  try { marker(); } catch (error) {
    assert(error instanceof Error);
    console.log("stack", marker.name, error.stack?.includes(marker.name));
  }
}
