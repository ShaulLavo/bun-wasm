import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = resolve(process.argv[2] ?? join(root, "third_party/rquickjs-sys/quickjs"));
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-quickjs-context-"));
function cleanup() { rmSync(scratch, { recursive: true, force: true }); }
process.once("SIGTERM", () => { cleanup(); process.exit(143); });
process.once("SIGINT", () => { cleanup(); process.exit(130); });
function source(path: string) { return readFileSync(join(root, path), "utf8"); }
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  return result.status ?? 1;
}
function hashFile(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function producedLibrary(engine: string, inputs: readonly string[]) {
  const out = process.env.BUN_WASM_QUICKJS_OUT_DIR;
  if (!out) return null;
  for (const name of inputs) {
    if (hashFile(join(out, name)) !== hashFile(join(engine, name))) throw Error(`Produced QuickJS source mismatch: ${name}`);
  }
  const path = join(out, "libquickjs.a");
  const identity = { path, sha256: hashFile(path) };
  console.log(JSON.stringify({ ordinaryLibrary: identity, sourceIdentity: "all inputs match" }));
  return path;
}
try {
  const bootstrap = source("crates/bunwasm-runtime/src/js/bootstrap.js");
  const start = bootstrap.indexOf("  function runInContext(context, fn, thisArg, args) {");
  const end = bootstrap.indexOf("  internal.runInContext = runInContext;", start);
  if (start < 0 || end < 0) throw Error("Missing production context runner");
  const fixture = stripTypeScriptTypes(source("scripts/fixtures/quickjs-async-context.ts"));
  const script = `const native = { getAsyncContext: nativeGet, setAsyncContext: nativeSet };
    const internal = { native, builtinFactories: {}, require: name => { if (name === 'dns') return {}; throw Error(name); } };
    ${bootstrap.slice(start, end)}
    internal.runInContext = runInContext;
    (${source("crates/bunwasm-runtime/src/js/builtins.js")})(internal);
    const storage = new (internal.builtinFactories['node:async_hooks']().AsyncLocalStorage)();
    ${fixture}`;
  const input = join(scratch, "controls.js");
  const binary = join(scratch, "quickjs-context");
  writeFileSync(input, script);
  const inputs = readdirSync(engine).filter(name => /\.[ch]$/.test(name)).sort();
  const hashes = Object.fromEntries(inputs.map(name => [name, hashFile(join(engine, name))]));
  const ordinaryLibrary = producedLibrary(engine, inputs);
  console.log(JSON.stringify({ engine, hashes, scriptSha256: createHash("sha256").update(script).digest("hex"), compiler: process.env.CC ?? "cc" }));
  for (const stress of [false, true]) {
    const flags = stress ? ["-DFORCE_GC_AT_MALLOC"] : [];
    console.log(JSON.stringify({ gcStress: stress, flags }));
    const linkInputs = stress || !ordinaryLibrary
      ? ["quickjs.c", "libregexp.c", "libunicode.c", "dtoa.c"].map(name => join(engine, name))
      : [ordinaryLibrary];
    const compiled = run(process.env.CC ?? "cc", ["-D_GNU_SOURCE", "-std=gnu11", "-O0", "-g", "-I", engine,
      join(root, "scripts/fixtures/quickjs-async-context.c")].concat(flags, linkInputs,
      ["-lm", "-lpthread", "-o", binary]));
    if (compiled !== 0) throw Error(`Native QuickJS compilation exited ${compiled}`);
    const contracts = run(binary, [input]);
    const faults = run(binary, ["--faults"]);
    process.exitCode = Number(process.exitCode ?? 0) || contracts || faults;
  }
} finally {
  cleanup();
  console.log(JSON.stringify({ cleanup: scratch, removed: true }));
}
