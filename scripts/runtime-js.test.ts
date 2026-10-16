import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync("/work/tmp/bun-wasm-runtime-js-");
const manifest = join(scratch, "crates/runtime");
const source = join(manifest, "src/js");
const out = join(scratch, "out");
const builder = join(scratch, "embed");

function runBuild(override?: string, directory = manifest) {
  return Bun.spawnSync([builder], {
    env: { ...process.env, CARGO_MANIFEST_DIR: directory, OUT_DIR: out, BUNWASM_JS_OVERRIDE_DIR: override ?? "" },
    stdout: "pipe", stderr: "pipe",
  });
}

beforeAll(() => {
  mkdirSync(source, { recursive: true });
  mkdirSync(out);
  symlinkSync(join(root, "scripts"), join(scratch, "scripts"));
  const harness = join(scratch, "embed.rs");
  writeFileSync(harness, `
#[path = ${JSON.stringify(join(root, "crates/bunwasm-runtime/build/polyfills.rs"))}]
mod polyfills;
fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let out = std::env::var("OUT_DIR").unwrap();
    polyfills::embed(std::path::Path::new(&manifest), std::path::Path::new(&out));
}
`);
  const compile = Bun.spawnSync(["rustc", harness, "-o", builder]);
  expect(compile.exitCode).toBe(0);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("embeds TypeScript factories, leaves JavaScript raw, and excludes declarations", () => {
  writeFileSync(join(source, "leaf.ts"), '(function (this: unknown, value: number): number { "use strict"; if (this !== undefined) throw new Error("lost strict mode"); return value + 1; })\n');
  writeFileSync(join(source, "ambient.d.ts"), "declare const ignored: number;\n");
  writeFileSync(join(source, "old.js"), "(function () { return 7; })\n");
  const result = runBuild();
  expect(result.exitCode).toBe(0);
  const table = readFileSync(join(out, "polyfills.rs"), "utf8");
  expect(table).toContain('("leaf", include_str!(');
  expect(table).toContain(join(source, "old.js"));
  expect(table).not.toContain("ambient");
  const generated = readFileSync(join(out, "runtime-js/leaf.js"), "utf8");
  expect((0, eval)(generated)(41)).toBe(42);
  expect(generated).not.toContain(": number");
});

test("transpiles TypeScript overrides and tracks their files", () => {
  const override = join(scratch, "override");
  mkdirSync(override);
  writeFileSync(join(override, "leaf.ts"), "(function (value: number) { return value * 2; })\n");
  const result = runBuild(override);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(`cargo:rerun-if-changed=${join(override, "leaf.ts")}`);
  expect((0, eval)(readFileSync(join(out, "runtime-js/leaf.js"), "utf8"))(21)).toBe(42);
});

test("rejects duplicate module stems and invalid TypeScript", () => {
  writeFileSync(join(source, "leaf.js"), "(function () {})\n");
  expect(runBuild().exitCode).not.toBe(0);
  rmSync(join(source, "leaf.js"));
  writeFileSync(join(source, "leaf.ts"), "(function (value: ) {})\n");
  expect(runBuild().exitCode).not.toBe(0);
  rmSync(join(source, "leaf.ts"));
});

test("embeds the converted runtime factories under their original names", () => {
  const result = runBuild(undefined, join(root, "crates/bunwasm-runtime"));
  expect(result.exitCode).toBe(0);
  const table = readFileSync(join(out, "polyfills.rs"), "utf8");
  expect(table).toContain('("glob", include_str!(');
  expect(table).toContain('("bun_builtin_globals", include_str!(');
  const globals = (0, eval)(readFileSync(join(out, "runtime-js/bun_builtin_globals.js"), "utf8"))();
  expect(Object.isFrozen(globals)).toBe(true);
  expect(globals.Array).toBe(Array);
  expect(globals.Buffer).toBe(Buffer);
  const { Glob } = (0, eval)(readFileSync(join(out, "runtime-js/glob.js"), "utf8"))({
    native: {
      globMatch: (pattern: string, path: string) => pattern === path,
      globScan: () => ["fixture.ts"],
    },
    require: () => ({ resolve: (cwd: string) => cwd }),
  });
  expect(new Glob("fixture.ts").match("fixture.ts")).toBe(true);
  expect(Array.from(new Glob("*").scanSync())).toEqual(["fixture.ts"]);
});

test("erases types without printing constructors or moving source positions", () => {
  const text = '(function (value: string) { "use strict"; throw new TypeError(value); })\n';
  writeFileSync(join(source, "position.ts"), text);
  const result = runBuild();
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(out, "runtime-js/position.js"), "utf8"))
    .toBe('(function (value        ) { "use strict"; throw new TypeError(value); })\n');
});

test("converted Glob preserves replacement error classes and their stacks", async () => {
  const { runInNewContext } = await import("node:vm");
  expect(runBuild(undefined, join(root, "crates/bunwasm-runtime")).exitCode).toBe(0);
  class ReplacementError extends Error { name = "ReplacementError"; }
  class ReplacementTypeError extends Error { name = "ReplacementTypeError"; }
  const factory = runInNewContext(readFileSync(join(out, "runtime-js/glob.js"), "utf8"), {
    TypeError: ReplacementTypeError, Error: ReplacementError, process: { cwd: () => "/" },
  }, { filename: "bun-wasm:glob" });
  const { Glob } = factory({ native: {}, require: () => ({ resolve: (cwd: string) => cwd }) });
  const cases: [() => unknown, typeof Error, string][] = [
    [() => new Glob(), ReplacementTypeError, "Glob.constructor: expected 1 arguments, got 0"],
    [() => new Glob(7), ReplacementTypeError, "Glob.constructor: first argument is not a string"],
    [() => new Glob("*").match(), ReplacementTypeError, "Glob.matchString: expected 1 arguments, got 0"],
    [() => new Glob("*").match(7), ReplacementTypeError, "Glob.matchString: first argument is not a string"],
    [() => new Glob("*").scanSync(false), ReplacementTypeError, "Expected options to be an object"],
    [() => new Glob("*").scanSync({ cwd: false }), ReplacementTypeError, "Expected cwd to be a string"],
    [() => new Glob("*").scanSync({ cwd: "/".repeat(4097) }), ReplacementError, "ENAMETOOLONG: name too long, scandir"],
  ];
  for (const [trigger, Ctor, message] of cases) {
    let error: unknown;
    try { trigger(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Ctor);
    if (!(error instanceof Error)) throw new Error("Expected an Error instance");
    expect(Object.getPrototypeOf(error)).toBe(Ctor.prototype);
    expect(error.name).toBe(Ctor === ReplacementError ? "ReplacementError" : "ReplacementTypeError");
    expect(error.message).toBe(message);
    expect(error.stack).toContain("bun-wasm:glob");
  }
});
