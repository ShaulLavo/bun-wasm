// Native contract for the iterative statement parser: builds the bare QuickJS engine with
// scripts/fixtures/quickjs-parser-stack.c and checks record limits, statement semantics,
// overflow error identity and cleanup when a statement record allocation fails. No bun-wasm
// runtime is involved; the produced Wasm pair has its own guest fixtures.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = resolve(process.argv[2] ?? join(root, "third_party/rquickjs-sys/quickjs"));
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-quickjs-parser-"));
function cleanup(): void { rmSync(scratch, { recursive: true, force: true }); }
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
process.once("SIGINT", () => { cleanup(); process.exit(130); });

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): { status: number; output: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env });
  if (result.error) throw result.error;
  process.stderr.write(result.stderr ?? "");
  return { status: result.status ?? 1, output: result.stdout ?? "" };
}

function nest(open: (level: number) => string, inner: string, close: string, count: number): string {
  let source = "";
  for (let i = 0; i < count; i++) source += open(i);
  return source + inner + close.repeat(count);
}

// Valid source that reaches every caller of the parser's parenthesis lookahead, repeated at
// growing function depth so a shrinking stack limit runs out at many different tokens.
function lookaheadFamilies(): string {
  const family = [
    "try { x = 1; } catch ({ message, ...rest }) { x = rest; }",
    "var { a: { b }, c: [d] } = o;",
    "var [[e], { f }] = o;",
    "({ g, h } = o); [i, j] = o; x = { k: 1, l: [1, 2] };",
    "x = (m, n) => m; x = (m + n);",
    "x = async (p) => p; x = async(p);",
    "let { q } = o, [r] = o;",
    "for ([s, t] of o) ; for ({ u } in o) ;",
    "for (var v = 0; v < 1; v++) ; for (w of o) ;",
    "x = function (y = 1, { z } = o) { return y; };",
  ].join("\n");
  return nest(() => `(function (o, x) {\n${family}\n`, "x = 0;", "\n})(o, x);", 12);
}

// Labels, loops, iterators, using, try and nested functions suspended together.
function faultInput(): string {
  const level = (i: number) => `a${i}: for (const v${i} of o) { b${i}: { try { switch (x) { case ${i}: if (x) { using r${i} = o;\n`
    + `for (var i${i} = (function () { c${i}: while (x) { { x = ${i}; } break c${i}; } })(); i${i} < 1; i${i}++) {\n`;
  return `function w(o, x) {\n${nest(level, "x = 1;", "} } } } finally { } } }", 6)}\n}`;
}

function check(label: string, ok: boolean): boolean {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  return ok;
}

try {
  const binary = join(scratch, "quickjs-parser-stack");
  const sources = ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"].map(name => join(engine, name));
  const compiled = run(process.env.CC ?? "cc", ["-D_GNU_SOURCE", "-std=gnu11", "-O1", "-g", "-I", engine,
    join(root, "scripts/fixtures/quickjs-parser-stack.c")].concat(sources, ["-lm", "-lpthread", "-o", binary]));
  if (compiled.status !== 0) throw new Error(`Native QuickJS compilation exited ${compiled.status}`);

  const semantics = join(scratch, "semantics.js");
  writeFileSync(semantics, stripTypeScriptTypes(readFileSync(join(root, "scripts/fixtures/quickjs-parser-stack.ts"), "utf8")));
  const families = join(scratch, "families.js");
  writeFileSync(families, lookaheadFamilies());
  const faults = join(scratch, "faults.js");
  writeFileSync(faults, faultInput());

  let passed = true;
  const contract = run(binary, ["contract"]);
  process.stdout.write(contract.output);
  passed = check("record limits, reentry, refusal, recovery and pool release", contract.status === 0) && passed;

  const observed = run(binary, ["run", semantics]);
  const expected = readFileSync(join(root, "scripts/fixtures/quickjs-parser-stack.expected.txt"), "utf8");
  if (observed.output !== expected) writeFileSync(join(scratch, "semantics.txt"), observed.output);
  if (observed.output !== expected) process.stdout.write(run("diff", ["-u", join(root, "scripts/fixtures/quickjs-parser-stack.expected.txt"), join(scratch, "semantics.txt")]).output);
  passed = check("statement semantics match the upstream recursive parser", observed.status === 0 && observed.output === expected) && passed;

  for (const mode of ["script", "cjs"]) {
    const sweep = run(binary, ["sweep", mode, families, "4096", "196608", "96"]);
    process.stdout.write(sweep.output);
    const counts = /sweep compiled (\d+) refused (\d+) replaced (\d+)/.exec(sweep.output);
    const reachedBoth = counts !== null && Number(counts[1]) > 0 && Number(counts[2]) > 0;
    passed = check(`valid ${mode} input only compiles or refuses with RangeError at every stack limit`, sweep.status === 0 && reachedBoth) && passed;
  }

  const faulted = run(binary, ["faults", "script", faults]);
  process.stdout.write(faulted.output);
  // Only the statement record pool's own allocations are denied. Other allocations of a compile
  // are not covered: upstream aborts on an assertion when one fails during function creation.
  passed = check("every denied statement record allocation is reported, leaks nothing and leaves the engine usable", faulted.status === 0) && passed;
  process.exitCode = passed ? 0 : 1;
} finally {
  cleanup();
  console.log(JSON.stringify({ cleanup: scratch, removed: true }));
}
