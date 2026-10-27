// React's server stack collector (Next.js dev rendering) calls these V8 CallSite predicates on
// every frame Error.prepareStackTrace receives, without checking that they exist.
function collect() {
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, sites) => sites;
  try { return new Error('probe').stack; } finally { Error.prepareStackTrace = saved; }
}
const site = collect()[0];
for (const name of ['isToplevel', 'isAsync', 'isPromiseAll', 'getPromiseIndex', 'isEval', 'isNative', 'isConstructor']) {
  console.log(name, typeof site[name], JSON.stringify(site[name]()));
}
const rendered = (() => {
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, sites) => sites.map(frame => [frame.isToplevel(), frame.isAsync(), frame.getLineNumber() > 0].join()).slice(0, 1);
  try { return new Error('render').stack; } finally { Error.prepareStackTrace = saved; }
})();
console.log('collector', rendered.join(' '));
