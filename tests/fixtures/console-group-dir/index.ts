// console.group indents the first line of a message and lets the formatter indent the rest.
console.group("outer");
console.log({ a: 1, b: 2 });
console.log("line one\nline two");
console.group('Tab\tNewline\nQuote"Backslash');
console.log([1, 2, 3]);
console.dir({ a: { b: { c: 1 } } }, { depth: 0 });
console.groupEnd();
console.groupEnd();
console.log("after");

// console.dir reads only depth and colors; a depth is clamped to 0 or more and cut to 16 bits.
const nested = { 1: { 2: { 3: { 4: { 5: 5 } } } } };
for (const depth of [0, -1, 1.2, 3, Infinity, -Infinity, NaN, null, undefined, "2", 65536 + 1]) {
  console.log("depth", String(depth));
  console.dir(nested, { depth: depth as number });
}
console.dir(nested);
console.dir({ a: 1 }, { colors: true });

// Printing past the depth limit and revoked proxies.
console.log(-0, "%f %f %d", -0, 1.5, -0);
const { proxy, revoke } = Proxy.revocable({}, {});
revoke();
console.log(proxy);
console.log([[[[1]]]], new Map([[1, new Map([[2, new Map([[3, new Map([[4, 5]])]])]])]]));
console.log({ a: { b: { c: new Set([1]) } } }, { a: { b: { c: new (class Box {})() } } });
