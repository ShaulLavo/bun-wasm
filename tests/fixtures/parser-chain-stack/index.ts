// A chain of assignment targets, as generated CommonJS exports have (`exports.A = exports.B = … =
// void 0`), costs a parser one recursion level per target. A real 100-target chain has to load
// inside the smallest stack budget a browser passes to JSC once the parser reserve is lowered
// (docs/stack-limits.md): at the default reserve JSC refuses it there. A chain far past any budget
// has to throw a catchable error and leave the guest working. The child runs with that budget and
// reserve. Engines that ignore them, and native Bun, load the same modules with room to spare.
const { spawnSync }: typeof import("node:child_process") = require("node:child_process");
const fs: typeof import("node:fs") = require("node:fs");
const path: typeof import("node:path") = require("node:path");

const targets = 100;
const beyond = 400_000;

function writeChain(name: string, length: number): string {
  const file = path.join(process.cwd(), `${name}.cjs`);
  let source = "";
  for (let index = 0; index < length; index++) source += `exports.a${index} = `;
  fs.writeFileSync(file, `${source}void 0;\n`);
  return file;
}

function loadChain(name: string): void {
  const loaded: Record<string, unknown> = require(writeChain(name, targets));
  if (Object.keys(loaded).length !== targets) throw new Error(`${name} exported ${Object.keys(loaded).length} names`);
}

function refused(error: unknown): boolean {
  // QuickJS reports its parser's stack guard as a SyntaxError, and native Bun's own transpiler
  // refuses the file before its engine sees it. Both name the stack.
  return error instanceof RangeError || (error instanceof Error && /stack/i.test(error.message));
}

function loadChains(): void {
  loadChain("chain");
  console.log(targets, "chained export targets loaded");

  let caught = false;
  try { require(writeChain("beyond", beyond)); } catch (error) {
    if (!refused(error)) throw error;
    caught = true;
  }
  if (!caught) throw new Error("a chain far past the budget loaded");
  console.log("far deeper chain refused");

  loadChain("again");
  console.log("continued");
}

if (process.argv[2] === "load") {
  loadChains();
} else {
  const env = { ...process.env, BUN_WASM_STACK_KIB: "192", BUN_WASM_JSC_PARSER_RESERVE: "1024" };
  const child = spawnSync(process.execPath, [__filename, "load"], { env, encoding: "utf8" });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`chain child exited ${child.status}`);
}
