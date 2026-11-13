import { spawnSync } from "node:child_process";

function quickjsDepth(): number {
  try { new Function("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "'let' is not a valid lexical identifier") return 5000;
    if (error.message.includes("Cannot use 'let' as an identifier name") || error.message === "let is disallowed as a lexically bound name") return 200;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}

function visit(n: number, a?: number, b?: number): number {
  return n === 0 ? Number(a === undefined && b === undefined) : 1 + visit.call(null, n - 1);
}

function main(depth: number): void {
  if (visit(depth) !== depth + 1) throw new Error("CALL changed padded parameters or its return value");
  console.log("nested CALL completed");
  const token = {};
  let unwound = 0;
  function fail(n: number): never {
    try {
      if (n === 0) throw token;
      return fail.call(null, n - 1);
    } finally { unwound++; }
  }
  let caught: unknown;
  try { fail(depth); } catch (error) { caught = error; }
  if (caught !== token || unwound !== depth + 1) throw new Error("CALL changed exception identity or finally");
  console.log("CALL exception and finally preserved");
  function overflow(): number { return 1 + overflow.call(null); }
  caught = undefined;
  try { overflow(); } catch (error) { caught = error; }
  if (!(caught instanceof RangeError)) throw new Error("unbounded CALL did not throw RangeError");
  console.log("unbounded CALL caught");
  if (visit(depth) !== depth + 1) throw new Error("CALL failed after overflow");
  reduceChecks(depth);
  console.log("continued");
}

function reduceChecks(depth: number): void {
  function nested(a: number, n: number): number { return n === 0 ? 0 : 1 + [n - 1].reduce(nested, 0); }
  function right(a: number, n: number): number { return n === 0 ? 0 : 1 + [n - 1, ,].reduceRight(right, 0); }
  if (nested(0, depth) !== depth || right(0, depth) !== depth) throw new Error("nested reduce changed its result");
  console.log("nested reduce and reduceRight completed");
  type Node = { nodes: Node[]; value: number };
  let tree: Node = { nodes: [], value: 1 };
  const walkDepth = Math.min(depth, 2000);
  for (let i = 0; i < walkDepth; i++) tree = { nodes: [tree], value: 1 };
  function names(node: Node): number { return node.nodes.reduce((a, child) => a + names(child), node.value); }
  if (names(tree) !== walkDepth + 1) throw new Error("Ajv-shaped reduce walk changed its result");
  console.log("Ajv-shaped callback walk completed");
  const marker = {};
  let finallyCount = 0;
  function fail(a: number, n: number): number {
    try {
      if (n === 0) throw marker;
      return [n - 1].reduce(fail, 0);
    } finally { finallyCount++; }
  }
  let caught: unknown;
  try { fail(0, depth); } catch (error) { caught = error; }
  if (caught !== marker || finallyCount !== depth + 1) throw new Error("reduce changed throw identity or finally");
  console.log("reduce exception and finally preserved");
  function overflow(): number { return 1 + [1].reduce(overflow, 0); }
  caught = undefined;
  try { overflow(); } catch (error) { caught = error; }
  if (!(caught instanceof RangeError)) throw new Error("unbounded reduce did not throw RangeError");
  console.log("unbounded reduce caught");
  if (nested(0, depth) !== depth || [1, 2].reduce((a, v) => a + v, 0) !== 3) throw new Error("reduce failed after overflow");
}

if (process.argv[2] === "run") {
  main(Number(process.argv[3]));
} else {
  const depth = quickjsDepth();
  for (const budget of ["32", "36"]) {
    const env = depth === 5000 ? { ...process.env, BUN_WASM_STACK_KIB: budget } : process.env;
    const child = spawnSync(process.execPath, [__filename, "run", String(depth)], { env, encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`CALL child exited ${child.status}`);
  }
}
