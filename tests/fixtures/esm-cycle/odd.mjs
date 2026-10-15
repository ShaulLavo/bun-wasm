import { even } from "./even.mjs";
export function odd(n) {
  return n === 0 ? false : even(n - 1);
}
// even.mjs hasn't evaluated yet, but its hoisted function is callable.
export const fromOdd = `even(2) = ${even(2)}`;
console.log("odd.mjs evaluated first");
