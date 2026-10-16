export function hasEvalMetadata() {
  const previous = Error.prepareStackTrace;
  try {
    Error.prepareStackTrace = (_error, sites) => sites;
    const sites = new Error().stack;
    const caller = Array.isArray(sites) ? sites[1] : null;
    return Boolean(caller && typeof caller.getEvalOrigin === "function" &&
      typeof caller.isEval === "function" && caller.isEval() && caller.getEvalOrigin());
  } finally { Error.prepareStackTrace = previous; }
}

export function makeEval() {
  return eval('(function fromEval() { return { origin: globalThis.reviewCaller(), metadata: globalThis.reviewEvalMetadata() }; })');
}
export function directEval() {
  return eval('({ origin: globalThis.reviewCaller(), metadata: globalThis.reviewEvalMetadata() })');
}
export function makeFunction() {
  return new Function('return { origin: globalThis.reviewCaller(), metadata: globalThis.reviewEvalMetadata() };');
}
