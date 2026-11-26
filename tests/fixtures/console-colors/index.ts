// console output with FORCE_COLOR: native Bun colours values on both streams, wraps
// console.error lines in red and prints uncaught errors with highlighted source.
console.log({ a: 1, b: "x", c: [1, 2, null, undefined, true], d: new Map([["k", 1]]) }, "plain", 42, 10n, Symbol("s"));
console.log("%s is %d", "x", 5, { nested: { deep: { deeper: { deepest: 1 } } } });
console.info({ info: [1, 2] });
console.debug(function named() {}, class Klass {}, /re/g, new Date(0));
console.log([1, 2, 3], new Uint8Array([1, 2]), Promise.resolve(1), null, undefined);
console.error({ err: true }, "e");
console.error("a single string");
console.error(2);
console.warn({ warn: true }, "w");
console.table([{ a: 1, b: "two" }, { a: 3, b: "four" }]);
console.dir({ dir: [1, 2] });
console.dir({ plain: 1 }, { colors: false });
console.assert(false, "asserted");
function inner() {
  const error = new RangeError("bad range");
  Object.assign(error, { code: "ERR_X", extra: { n: 1, s: "two" } });
  throw error;
}
inner();
