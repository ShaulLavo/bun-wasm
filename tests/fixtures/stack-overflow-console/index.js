let caught = false;
function exhaust() {
  try { exhaust(); } catch (error) {
    caught = error instanceof RangeError;
    try { void console.Console; } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
  }
}
exhaust();
if (!caught || typeof console.Console !== 'function') throw new Error('console did not recover');
console.log('console continued');
