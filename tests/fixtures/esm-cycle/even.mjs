import { odd, fromOdd } from "./odd.mjs";
export let evenCalls = 0;
export function even(n) {
  return n === 0 ? true : odd(n - 1);
}
export function countEven() {
  evenCalls++;
}
console.log("even.mjs evaluated; odd.mjs said:", fromOdd);
