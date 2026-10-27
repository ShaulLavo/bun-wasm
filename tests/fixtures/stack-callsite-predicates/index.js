// React's server stack collector (Next.js dev rendering) calls these V8 CallSite predicates on
// every frame Error.prepareStackTrace receives, without checking that they exist. Only answers
// both engines can derive exactly are checked: frame strictness is not available to them, so
// every checked frame has no strict frame above it.
function sitesOf(run) {
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, sites) => sites;
  try { return run(); } finally { Error.prepareStackTrace = saved; }
}
const predicates = site => [site.isToplevel(), site.isAsync(), site.isPromiseAll(), site.getPromiseIndex()].join();
const named = (sites, name) => sites.find(site => (site.getFunctionName() ?? '').endsWith(name));

const first = sitesOf(() => new Error('probe').stack)[0];
for (const name of ['isToplevel', 'isAsync', 'isPromiseAll', 'getPromiseIndex']) console.log(name, typeof first[name]);

// A named sloppy function call is not top-level.
const sloppyNamed = new Function('return function sloppyNamed() { return new Error("probe").stack; }')();
console.log('sloppy named', predicates(named(sitesOf(sloppyNamed), 'sloppyNamed')));

// Program code is top-level.
const program = sitesOf(() => new Error('probe').stack).find(site => !site.getFunctionName() && site.getFileName().endsWith('index.js'));
console.log('program', program.isToplevel());

// After an await, the running function is not an async frame; only a suspended awaiting
// caller, where an engine reports one, is.
const leafAfterAwait = new Function('return async function asyncLeaf() { await 0; return new Error("probe").stack; }')();
async function asyncParent() { return await leafAfterAwait(); }
const saved = Error.prepareStackTrace;
Error.prepareStackTrace = (error, sites) => sites;
let resumed;
try { resumed = await asyncParent(); } finally { Error.prepareStackTrace = saved; }
console.log('resumed leaf', predicates(named(resumed, 'asyncLeaf')));
console.log('async frames are awaiting callers', resumed.filter(site => site.isAsync()).every(site => site.getFunctionName().endsWith('asyncParent')));
