// Run as a guest TypeScript entry; eval inputs below deliberately exercise JavaScript parsing.
function getters(): void {
  let depth = 0;
  const object: { readonly value: number } = { get value(): number { return ++depth === 128 ? 1 : 1 + object.value; } };
  if (object.value !== 128) throw new Error('getter result changed');
  console.log('128 getters completed');
}
const mustCatch = process.env.BUNWASM_STACK_EXPECT_CAUGHT === "1";
function caught(name: string, action: () => unknown, accepted: readonly ErrorConstructor[] = [RangeError]): void {
  let caught = false;
  try { action(); } catch (error) {
    if (!accepted.some(type => error instanceof type)) throw error;
    caught = true;
  }
  if (mustCatch && !caught) throw new Error(`${name} did not reach a catchable stack guard`);
  console.log(name, "survived");
}
const depth = 200000;
getters();
let array: unknown[] = [];
let object: object = {};
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
const unary: Readonly<Record<string, (levels: number) => string>> = {
  'logical not': levels => `${'!'.repeat(levels)}0`,
  negate: levels => `var x = 1; ${'- '.repeat(levels)}x`,
  'bitwise not': levels => `var x = 1; ${'~'.repeat(levels)}x`,
  'unary plus': levels => `${'+ '.repeat(levels)}0`,
  typeof: levels => `${'typeof '.repeat(levels)}0`,
  void: levels => `${'void '.repeat(levels)}0`,
  delete: levels => `${'delete '.repeat(levels)}0`,
  'negated condition': levels => `if (${'!'.repeat(levels)}globalThis) 1`,
  await: levels => `(async () => {${'await '.repeat(levels)}0})`,
};
const patterns: Readonly<Record<string, (levels: number) => string>> = {
  'noncapturing groups': levels => `${'(?:'.repeat(levels)}${')'.repeat(levels)}`,
  lookahead: levels => `${'(?=a'.repeat(levels)}${')'.repeat(levels)}`,
  'negative lookahead': levels => `${'(?!a'.repeat(levels)}${')'.repeat(levels)}`,
  'anchored groups': levels => `^${'(?:'.repeat(levels)}${')'.repeat(levels)}`,
  'repeated groups': levels => `${'(?:'.repeat(levels)}a${')*'.repeat(levels)}`,
};
const regexpErrors = [RangeError, SyntaxError];
for (const [name, source] of Object.entries(unary)) caught(name, () => (0, eval)(source(depth)));
for (const [name, source] of Object.entries(patterns)) caught(name, () => new RegExp(source(depth)).exec('aaa'), regexpErrors);
// A depth that compiles must still survive every later compile and match pass.
function interior(action: () => unknown): void {
  try { action(); } catch (error) {
    if (!regexpErrors.some(type => error instanceof type)) throw error;
  }
}
for (const levels of [100, 300, 700, 1400, 3000, 10000]) {
  for (const source of Object.values(unary)) interior(() => (0, eval)(source(levels)));
  for (const source of Object.values(patterns)) interior(() => new RegExp(source(levels)).exec('aaa'));
}
console.log('interior depths survived');
const nestedRepeatSource = `^${'(?:'.repeat(40)}a${')*'.repeat(40)}$`;
const nestedRepeat = new RegExp(nestedRepeatSource);
const globalRepeat = new RegExp(nestedRepeatSource, 'g');
function matchingResults(): void {
  if (nestedRepeat.exec('a')?.[0] !== 'a') throw new Error('regexp exec lost a matching result');
  if (!nestedRepeat.test('a')) throw new Error('regexp test lost a matching result');
  if ('a'.replace(nestedRepeat, 'matched') !== 'matched') throw new Error('regexp replace lost a matching result');
  globalRepeat.lastIndex = 0;
  const matches = Array.from('a'.matchAll(globalRepeat), match => match[0]);
  if (matches.length !== 1 || matches[0] !== 'a') throw new Error('regexp matchAll lost a matching result');
}
function reentrantMatching(): void {
  try { matchingResults(); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  'x'.replace('x', () => { reentrantMatching(); return ''; });
}
matchingResults();
try { reentrantMatching(); } catch (error) {
  if (!(error instanceof RangeError)) throw error;
}
matchingResults();
if (nestedRepeat.exec('b') !== null || nestedRepeat.test('b')) throw new Error('regexp no-match result changed');
console.log('regexp reentrant matches remain correct');
getters();
console.log('continued');
