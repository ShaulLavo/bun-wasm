export function makeEval(directives) {
  return eval('(function fromEval() { return { origin: globalThis.reviewCaller() }; })\n' + directives);
}
