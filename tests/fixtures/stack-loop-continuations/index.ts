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
  console.log("continued");
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
