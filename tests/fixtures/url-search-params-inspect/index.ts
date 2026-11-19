import util from "node:util";

const empty = new URLSearchParams();
const one = new URLSearchParams("a=1");
const repeated = new URLSearchParams("a=1&b=two words&a=3");
const long = new URLSearchParams(Array.from({ length: 8 }, (_, i) => [`key${i}`, `a fairly long value ${i}`]));
class Params extends URLSearchParams {}

console.log(util.inspect(empty));
console.log(util.inspect(one));
console.log(util.inspect(repeated));
console.log(util.inspect(long));
console.log(util.inspect({ params: one }));
console.log(util.inspect({ a: { b: { c: one } } }, { depth: 1 }));
console.log(util.inspect(new Params("x=y")));
console.log(util.inspect(new URL("https://x.test/?q=hello%20world").searchParams));
