const depth = 200000;
const source = '(() => '.repeat(depth) + '0' + ')'.repeat(depth);

function recover(): void {
  if ((0, eval)('((value) => value + 1)(41)') !== 42) throw new Error('parser did not recover');
}

function parse(remaining: number): unknown {
  if (remaining === 0) return (0, eval)(source);
  return parse(remaining - 1);
}

function overflow(remaining: number): void {
  try {
    parse(remaining);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    recover();
    return;
  }
  throw new Error('deep valid arrow syntax did not overflow');
}

for (let remaining = 0; remaining < 16; remaining++) overflow(remaining);
console.log('arrow overflow is RangeError');
try {
  (0, eval)('(value,,) => value');
  throw new Error('invalid parameter list was accepted');
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  console.log('invalid parameters are SyntaxError');
}
recover();
console.log('parser recovered');

// A literal and a destructuring assignment start alike, so the parser looks ahead and then
// restores its position one frame deeper than where it reads on. When that restore ran out of
// stack, the literal was parsed from a stale token and the overflow became a SyntaxError.
function overflowIn(literal: string, remaining: number): void {
  const parseLiteral = (left: number): unknown => (left === 0 ? (0, eval)(literal) : parseLiteral(left - 1));
  try {
    parseLiteral(remaining);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    recover();
    return;
  }
  throw new Error('deep valid literal did not overflow');
}

for (const [name, open, close] of [['object', '({a:', '})'], ['array', '[', ']']] as const) {
  const literal = open.repeat(depth) + '0' + close.repeat(depth);
  for (let remaining = 0; remaining < 16; remaining++) overflowIn(literal, remaining);
  console.log(`${name} literal overflow is RangeError`);
}
try {
  (0, eval)('({a:1,,})');
  throw new Error('invalid object literal was accepted');
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  console.log('invalid literals are SyntaxError');
}
recover();
console.log('parser recovered after literals');
