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
