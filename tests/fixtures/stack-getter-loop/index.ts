import { spawnSync } from "node:child_process";

function quickjsDepth(): number {
  try { new Function("let let = 1"); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    if (error.message === "'let' is not a valid lexical identifier") return 4096;
    if (error.message.includes("Cannot use 'let' as an identifier name") || error.message === "let is disallowed as a lexically bound name") return 48;
    throw new Error("Unrecognized parser fingerprint", { cause: error });
  }
  throw new Error("Invalid lexical declaration was accepted");
}

function ownGetter(depth: number): void {
  let remaining = depth;
  const object = { get value(): number { return remaining-- === 0 ? 0 : 1 + object.value; } };
  if (object.value !== depth) throw new Error("own getter changed its result");
  console.log("own getter loop completed");
}

function receiverGetter(depth: number): void {
  const object = { remaining: depth, get value(): number { return this.remaining-- === 0 ? 0 : 1 + this.value; } };
  if (object.value !== depth) throw new Error("receiver-preserving getter changed its result or receiver");
  console.log("receiver-preserving getter loop completed");
}

function superGetter(depth: number): void {
  let remaining = depth / 2;
  class Base { get value(): number { return remaining-- === 0 ? -1 : 1 + (this as Derived).value; } }
  class Derived extends Base { override get value(): number { return 1 + super.value; } }
  if (new Derived().value !== depth) throw new Error("super getter changed its result or receiver");
  console.log("super getter loop completed");
}

function getterException(depth: number): void {
  const token = {};
  let remaining = depth;
  let unwound = 0;
  const object = {
    get value(): number {
      try {
        if (remaining === 0) throw token;
        remaining--;
        return object.value;
      } finally { unwound++; }
    },
  };
  let caught: unknown;
  try { object.value; } catch (error) { caught = error; }
  if (caught !== token || unwound !== depth + 1) throw new Error("getter changed exception identity or finally");
  console.log("getter exception and finally preserved");
}

function main(depth: number): void {
  ownGetter(depth);
  receiverGetter(depth);
  superGetter(depth);
  getterException(depth);
  const endless = { get value(): number { return 1 + endless.value; } };
  let caught: unknown;
  try { endless.value; } catch (error) { caught = error; }
  if (!(caught instanceof RangeError)) throw new Error("unbounded getter did not throw RangeError");
  console.log("unbounded getter caught");
  ownGetter(depth);
  console.log("continued");
}

if (process.argv[2] === "run") {
  main(Number(process.argv[3]));
} else {
  const depth = quickjsDepth();
  for (const budget of ["32", "36"]) {
    const env = depth === 4096 ? { ...process.env, BUN_WASM_STACK_KIB: budget } : process.env;
    const child = spawnSync(process.execPath, [__filename, "run", String(depth)], { env, encoding: "utf8" });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`getter child exited ${child.status}`);
  }
}
