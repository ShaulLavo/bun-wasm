// Native contract for the frame stack of ordinary bytecode calls: builds
// scripts/fixtures/quickjs-frame-stack.c against the bare QuickJS engine and checks the
// frame-limit boundaries, physical accounting, denied chunk allocations and call semantics.
// No bun-wasm runtime is involved; the produced Wasm pair has its own guest fixtures.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { nativeCheck } from "./quickjs-native-check.ts";

const sanitize = process.argv.includes("--sanitize");
const engineArgument = process.argv.slice(2).find(arg => arg !== "--sanitize");
const { root, engine, scratch, cleanup } = nativeCheck("bun-wasm-quickjs-frames-", engineArgument);

function run(command: string, args: string[]): { status: number | null; output: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  process.stderr.write(result.stderr ?? "");
  return { status: result.status, output: result.stdout ?? "", stderr: result.stderr ?? "" };
}
const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

// The Rust contract test passes the archive it already built from these sources. Link that
// instead of compiling the engine a second time, after checking it is the same source.
function producedLibrary(): string | null {
  const out = process.env.BUN_WASM_QUICKJS_OUT_DIR;
  if (!out) return null;
  for (const name of readdirSync(engine).filter(file => /\.[ch]$/.test(file))) {
    if (hashFile(join(out, name)) !== hashFile(join(engine, name))) throw new Error(`Produced QuickJS source mismatch: ${name}`);
  }
  return join(out, "libquickjs.a");
}

function check(label: string, ok: boolean): boolean {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  return ok;
}

try {
  const binary = join(scratch, "quickjs-frame-stack");
  const library = producedLibrary();
  if (sanitize && library) throw new Error("Sanitizer checks must compile engine sources");
  const sanitizerFlags = sanitize ? ["-fsanitize=address,undefined", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"] : [];
  const engineInputs = library ? [library] : ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"].map(name => join(engine, name));
  console.log(JSON.stringify({ engine, linked: library ? "produced archive" : "engine sources" }));
  const compiled = run(process.env.CC ?? "cc", ["-D_GNU_SOURCE", "-std=gnu11", "-O1", "-g", "-I", engine,
    join(root, "scripts/fixtures/quickjs-frame-stack.c")].concat(sanitizerFlags, engineInputs, ["-lm", "-lpthread", "-o", binary]));
  if (compiled.status !== 0) throw new Error(`Native QuickJS compilation exited ${compiled.status}`);

  const semantics = join(scratch, "frames.js");
  writeFileSync(semantics, stripTypeScriptTypes(readFileSync(join(root, "scripts/fixtures/quickjs-frame-stack.ts"), "utf8")));

  let passed = true;
  const contract = run(binary, ["contract"]);
  process.stdout.write(contract.output);
  passed = check("frame limit boundaries, chunk accounting, denied chunks, native refusal and recovery", contract.status === 0) && passed;

  const unmapFailure = run(binary, ["unmap-failure"]);
  if (unmapFailure.status !== 77) {
    passed = check("failed backing unmap stops before its frame charge can be cleared",
      unmapFailure.status === 1 && unmapFailure.stderr.includes("fatal: QuickJS allocator could not unmap backing")) && passed;
  }

  const observed = run(binary, ["run", semantics]);
  const expectedPath = join(root, "scripts/fixtures/quickjs-frame-stack.expected.txt");
  const expected = readFileSync(expectedPath, "utf8");
  if (observed.output !== expected) {
    writeFileSync(join(scratch, "frames.txt"), observed.output);
    process.stdout.write(run("diff", ["-u", expectedPath, join(scratch, "frames.txt")]).output);
  }
  passed = check("call semantics match the engine before the change", observed.status === 0 && observed.output === expected) && passed;
  process.exitCode = passed ? 0 : 1;
} finally {
  cleanup();
  console.log(JSON.stringify({ cleanup: scratch, removed: true }));
}
