// A typed array or ArrayBuffer longer than the engine can allocate is RangeError: Out of memory,
// as in Bun (JavaScriptCore), not a length-validation error.
for (const [name, make] of [
  ["Uint8Array(2 ** 32 + 1)", () => new Uint8Array(2 ** 32 + 1)],
  ["ArrayBuffer(2 ** 32 + 1)", () => new ArrayBuffer(2 ** 32 + 1)],
  ["Float64Array(2 ** 30)", () => new Float64Array(2 ** 30)],
] as const) {
  try {
    make();
    console.log(name, "allocated");
  } catch (error) {
    console.log(name, (error as Error).name, (error as Error).message);
  }
}
