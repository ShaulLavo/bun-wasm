// ES module import cycles: live bindings, and a hoisted function used before
// its module finished evaluating.
import { countEven, even, evenCalls } from "./even.mjs";
import { odd } from "./odd.mjs";
import * as self from "./index.mjs";

console.log("even(10):", even(10), "odd(7):", odd(7));
countEven();
console.log("evenCalls is live:", evenCalls === 1);
console.log("self import:", typeof self.main);
export function main() {}
