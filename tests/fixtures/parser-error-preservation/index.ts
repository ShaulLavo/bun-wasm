function recover(): void {
  if ((0, eval)('((value) => value + 1)(41)') !== 42) throw new Error('parser did not recover');
}

function overflow(): void {
  const depth = 200000;
  try {
    (0, eval)('(() => '.repeat(depth) + '0' + ')'.repeat(depth));
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    console.log('arrow overflow is RangeError');
    recover();
    return;
  }
  throw new Error('deep valid arrow syntax did not overflow');
}

overflow();
try {
  (0, eval)('(value,,) => value');
  throw new Error('invalid parameter list was accepted');
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  console.log('invalid parameters are SyntaxError');
}
recover();
console.log('parser recovered');
