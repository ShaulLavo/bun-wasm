// B reads a binding A re-exports from C before C has evaluated: ReferenceError.
try {
  await import('./a.mjs');
  console.log('complete');
} catch (error) {
  console.log(error.constructor.name);
}
