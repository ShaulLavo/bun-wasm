// Run as a guest TypeScript entry; eval inputs below deliberately exercise JavaScript parsing.
function getters() {
  let depth = 0;
  const object = { get value() { return ++depth === 128 ? 1 : 1 + object.value; } };
  if (object.value !== 128) throw new Error('getter result changed');
  console.log('128 getters completed');
}
function caught(name, action) {
  try { action(); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.log(name, 'RangeError');
    return;
  }
  throw new Error(`${name} did not reach a catchable stack guard`);
}
const depth = 200000;
getters();
let array = [];
let object = {};
let proxy = { value: 1 };
for (let i = 0; i < depth; i++) {
  array = [array];
  object = { child: object };
  proxy = new Proxy(proxy, {});
}
caught('flat', () => array.flat(Infinity));
caught('proxychain', () => proxy.value);
caught('jsonplain', () => JSON.stringify(object));
caught('arrow', () => (0, eval)('(() => '.repeat(depth) + '0' + ')'.repeat(depth)));
caught('statement', () => (0, eval)('if(0)'.repeat(depth) + ';'));
getters();
console.log('continued');
