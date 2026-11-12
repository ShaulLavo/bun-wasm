// A chain of assignment targets, as generated CommonJS exports have (`exports.A = exports.B = … =
// void 0`), used to cost JSC's parser one recursion level per target. A real 100-target chain has to
// load inside the smallest stack budget a browser passes to JSC, with the default parser reserve
// (docs/stack-limits.md). A chain four times deeper is past JSC's guard there: its code generator
// must throw a catchable RangeError and leave the guest working
// (docs/bun-patches/jsc-assignment-chains.md). The child runs with that budget. Engines that ignore
// it, and native Bun, may load the deeper chain; BUNWASM_STACK_EXPECT_CAUGHT=1 requires the refusal.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

const targets = 100;
const deeper = 400;
const mustCatch = process.env.BUNWASM_STACK_EXPECT_CAUGHT === "1";

function loadChain(name: string, length: number): void {
  const file = path.join(process.cwd(), `${name}.cjs`);
  let source = "";
  for (let index = 0; index < length; index++) source += `exports.a${index} = `;
  fs.writeFileSync(file, `${source}void 0;\n`);
  const loaded: Record<string, unknown> = require(file);
  if (Object.keys(loaded).length !== length) throw new Error(`${name} exported ${Object.keys(loaded).length} names`);
}

function loadChains(): void {
  loadChain("chain", targets);
  console.log(targets, "chained export targets loaded");

  let caught = false;
  try { loadChain("deeper", deeper); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    caught = true;
  }
  if (mustCatch && !caught) throw new Error("the deeper chain did not reach a catchable stack guard");
  console.log(deeper, "chained export targets survived");

  loadChain("again", targets);
  console.log("continued");
}

if (process.argv[2] === "load") {
  loadChains();
} else {
  const env: Record<string, string | undefined> = { ...process.env, BUN_WASM_STACK_KIB: "192" };
  delete env.BUN_WASM_JSC_PARSER_RESERVE;
  const child = spawnSync(process.execPath, [__filename, "load"], { env, encoding: "utf8" });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`chain child exited ${child.status}`);
}
