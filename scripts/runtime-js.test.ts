import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RuntimeJsCommands } from "./runtime-js-process";

const root = resolve(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-runtime-js-"));
const commands = new RuntimeJsCommands(() => rmSync(scratch, { recursive: true, force: true }));
const manifest = join(scratch, "crates/runtime");
const source = join(manifest, "src/js");
const out = join(scratch, "out");
const builder = join(scratch, "embed");

function runBuild(override?: string, directory = manifest, destination = out) {
  return commands.run(builder, [], {
    phase: "embed", timeout: 4_000,
    env: { ...process.env, CARGO_MANIFEST_DIR: directory, OUT_DIR: destination, BUNWASM_JS_OVERRIDE_DIR: override ?? "" },
  });
}

// Lazily emit within the first real control's unchanged 5s budget, never in the 120s setup hook.
let fullArtifact: Promise<{ result: Awaited<ReturnType<typeof runBuild>>; directory: string }> | undefined;
function runtimeArtifact() {
  return fullArtifact ??= (async () => {
    const directory = join(scratch, "full-runtime");
    mkdirSync(directory);
    const result = await runBuild(undefined, join(root, "crates/bunwasm-runtime"), directory);
    return { result, directory };
  })();
}

beforeAll(async () => {
  mkdirSync(source, { recursive: true });
  mkdirSync(out);
  symlinkSync(join(root, "scripts"), join(scratch, "scripts"));
  symlinkSync(join(root, "vendor"), join(scratch, "vendor"));
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
  const compile = await commands.run("rustc", [harness, "-o", builder], { phase: "compile-harness", timeout: 115_000 });
  expect(compile.exitCode, compile.diagnostic).toBe(0);
  expect(compile.reason, compile.diagnostic).toBe("exit");
  // Compiling the harness takes seconds on a loaded machine; the default 5s hook limit kills rustc mid-build.
}, 120_000);
afterEach(() => commands.cancel());
afterAll(async () => {
  await commands.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

test("embeds TypeScript factories, leaves JavaScript raw, and excludes declarations", async () => {
  writeFileSync(join(source, "leaf.ts"), '(function (this: unknown, value: number): number { "use strict"; if (this !== undefined) throw new Error("lost strict mode"); return value + 1; })\n');
  writeFileSync(join(source, "ambient.d.ts"), "declare const ignored: number;\n");
  writeFileSync(join(source, "old.js"), "(function () { return 7; })\n");
  const result = await runBuild();
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.reason, result.diagnostic).toBe("exit");
  const table = readFileSync(join(out, "polyfills.rs"), "utf8");
  expect(table).toContain('("leaf", include_str!(');
  expect(table).toContain(join(source, "old.js"));
  expect(table).not.toContain("ambient");
  const generated = readFileSync(join(out, "runtime-js/leaf.js"), "utf8");
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  expect((0, eval)(generated)(41)).toBe(42);
  expect(generated).not.toContain(": number");
});

test("transpiles TypeScript overrides and tracks their files", async () => {
  const override = join(scratch, "override");
  mkdirSync(override);
  writeFileSync(join(override, "leaf.ts"), "(function (value: number) { return value * 2; })\n");
  const result = await runBuild(override);
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.reason, result.diagnostic).toBe("exit");
  expect(result.stdout.toString()).toContain(`cargo:rerun-if-changed=${join(override, "leaf.ts")}`);
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  expect((0, eval)(readFileSync(join(out, "runtime-js/leaf.js"), "utf8"))(21)).toBe(42);
});

test("rejects duplicate module stems and invalid TypeScript", async () => {
  writeFileSync(join(source, "leaf.js"), "(function () {})\n");
  expect((await runBuild()).exitCode).not.toBe(0);
  rmSync(join(source, "leaf.js"));
  writeFileSync(join(source, "leaf.ts"), "(function (value: ) {})\n");
  expect((await runBuild()).exitCode).not.toBe(0);
  rmSync(join(source, "leaf.ts"));
});

test("embeds the converted runtime factories under their original names", async () => {
  const { result, directory } = await runtimeArtifact();
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.reason, result.diagnostic).toBe("exit");
  const table = readFileSync(join(directory, "polyfills.rs"), "utf8");
  expect(table).not.toContain(source);
  expect(result.stderr.match(/runtime-js launch phase=strip /g)).toHaveLength(1);
  expect(result.stderr.match(/runtime-js launch phase=compact /g)).toHaveLength(1);
  expect(result.stderr.match(/runtime-js phase=wrap /g)).toHaveLength(1);
  expect(table).toContain('("glob", include_str!(');
  expect(table).toContain('("bun_builtin_globals", include_str!(');
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  const globals = (0, eval)(readFileSync(join(directory, "runtime-js/bun_builtin_globals.js"), "utf8"))();
  expect(Object.isFrozen(globals)).toBe(true);
  expect(globals.Array).toBe(Array);
  expect(globals.Buffer).toBe(Buffer);
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  const { Glob } = (0, eval)(readFileSync(join(directory, "runtime-js/glob.js"), "utf8"))({
    native: {
      globMatch: (pattern: string, path: string) => pattern === path,
      globScan: () => ["fixture.ts"],
    },
    require: () => ({ resolve: (cwd: string) => cwd }),
  });
  expect(new Glob("fixture.ts").match("fixture.ts")).toBe(true);
  expect(Array.from(new Glob("*").scanSync())).toEqual(["fixture.ts"]);
});

test("embeds the TCP factory chain under the names used by node:net", async () => {
  const { result, directory } = await runtimeArtifact();
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.reason, result.diagnostic).toBe("exit");
  const table = readFileSync(join(directory, "polyfills.rs"), "utf8");
  for (const name of ["net", "net_address", "net_port", "node_net", "bun_tcp"]) {
    expect(table).toContain(`("${name}", include_str!(`);
  }
});
