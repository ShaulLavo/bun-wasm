function check(label, action) {
  let caught = false;
  try { action(); } catch (error) { caught = error instanceof RangeError; }
  if (!caught) throw new Error(`${label} did not throw RangeError`);
  console.log(label, 'RangeError');
}
function recurse() { return 1 + recurse(); }
check('plain', recurse);
check('plain again', recurse);
const getter = { get value() { return 1 + getter.value; } };
check('getter', () => getter.value);
const proxy = new Proxy({}, { get() { return 1 + proxy.value; } });
check('proxy', () => proxy.value);
function Construct() { Reflect.construct(Construct, []); }
check('reflect construct', () => new Construct());
// A TypeScript module loaded from a catch at the depth limit runs the transpiler and the parser
// with the least stack left. It loads or throws RangeError, and the program goes on.
const modulePath = require('node:path').join(process.cwd(), 'stack-overflow-mod.ts');
require('node:fs').writeFileSync(modulePath, 'const n: number = 1;\nexport const value: number = n + 1;\n');
let atLimit = false;
function nearLimit() {
  try { nearLimit(); } catch {
    if (atLimit) return;
    atLimit = true;
    try { require(modulePath); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
}
nearLimit();
console.log('require at limit survived', require(modulePath).value);
let object = {};
for (let i = 0; i < 50000; i++) object = { child: object };
// Hosts with a large stack, or engines that do these without deep native recursion, may
// finish instead of throwing.
function survive(label, action) {
  try { action(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  console.log(label, 'survived');
}
survive('json', () => JSON.stringify(object, (key, value) => value));
const nested = '['.repeat(100000) + ']'.repeat(100000);
survive('json parse', () => JSON.parse(nested));
survive('nested source', () => (0, eval)(nested));
Promise.resolve().then(recurse).then(
  () => { throw new Error('promise did not reject'); },
  (error) => {
    if (!(error instanceof RangeError)) throw error;
    console.log('promise RangeError');
  },
).then(() => {
  let chain = Promise.resolve(0);
  for (let i = 0; i < 5000; i++) chain = chain.then((count) => count + 1);
  return chain;
}).then((count) => {
  if (count !== 5000) throw new Error('promise chain did not finish');
  console.log('promise chain', count);
  console.log('continued', 2 + 2);
});
