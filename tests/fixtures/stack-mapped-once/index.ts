interface Point {
  x: number;
  y: number;
}
interface Other {
  value: string;
}
Error.prepareStackTrace = (_error, sites) => sites;
function inner() {
  const holder = {};
  Error.captureStackTrace(holder, inner);
  return holder.stack[0];
}
function outer() {
  return inner();
}
const site = outer();
// Engines with native raw CallSites may expose generated coordinates. JSC's
// adapter has already mapped this getter to the original call at 15:10.
console.log('mapped once', site.getLineNumber() !== 15 || site.toString().endsWith(':15:10)'));
globalThis.padding = 1;
globalThis.padding = 2;
globalThis.padding = 3;
globalThis.padding = 4;
globalThis.padding = 5;
globalThis.padding = 6;
globalThis.padding = 7;
globalThis.padding = 8;
globalThis.padding = 9;
globalThis.padding = 10;
globalThis.padding = 11;
globalThis.padding = 12;
globalThis.padding = 13;
globalThis.padding = 14;
globalThis.padding = 15;
globalThis.padding = 16;
globalThis.padding = 17;
globalThis.padding = 18;
globalThis.padding = 19;
globalThis.padding = 20;
