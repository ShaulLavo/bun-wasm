// JSC keeps an all-constant array literal as one copy-on-write buffer, allocated from the garbage
// collected heap while it generates the function's bytecode. A host that cannot grow memory makes
// that allocation fail. The guest must survive it: the literal is then built element by element.
//
// The gate runs this with `--refuse-engine-allocation 80000-80511:2` (scripts/jsc-embedding.ts).
// The literal's buffer is 16 + 8 * 10,000 bytes plus a small allocation header, so the first
// refusal is the buffer during bytecode generation and the second is the array's own storage on
// the first call. Nothing else the engine allocates at startup or here has that size.
const elementCount = 10_000;

// A function whose top level declares one all-constant array, the shape of
// `const esbuildUsedEnvVars = [...]` in esbuild-wasm's launcher module.
const build = new Function(`const table = [${"0,".repeat(elementCount - 1)}7]; return table;`) as () => number[];

let first: string;
try {
  first = `built ${build().length}`;
} catch (error) {
  first = error instanceof RangeError ? `caught RangeError: ${error.message}` : `unexpected ${String(error)}`;
}
console.log("first call:", first);

const table = build();
console.log("second call: built", table.length, table[0], table[elementCount - 1]);
table[0] = 1;
console.log("fresh array per call:", build()[0] === 0);
console.log("guest survived");
