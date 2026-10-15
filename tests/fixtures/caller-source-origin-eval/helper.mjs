export function makeEval() {
  return eval('(function fromEval() { return { origin: globalThis.reviewCaller(), stack: new Error().stack }; })');
}
export function directEval() {
  return eval('({ origin: globalThis.reviewCaller() })');
}
export function makeFunction() {
  return new Function('return { origin: globalThis.reviewCaller() };');
}
