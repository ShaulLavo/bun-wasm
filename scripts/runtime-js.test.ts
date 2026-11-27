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
    env: { ...process.env, CARGO_MANIFEST_DIR: directory, OUT_DIR: destination, BUNWASM_JS_OVERRIDE_DIR: override ?? "", BUNWASM_JS_PRESERVE_POSITIONS: "" },
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
  symlinkSync(join(root, "web"), join(scratch, "web"));
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

test("embeds minified TypeScript and JavaScript factories and excludes declarations", async () => {
  writeFileSync(join(source, "leaf.ts"), '(function (this: unknown, value: number): number {\n  "use strict";\n  // Comment text is dropped.\n  if (this !== undefined) throw new Error("lost strict mode");\n  return value + 1;\n})\n');
  writeFileSync(join(source, "ambient.d.ts"), "declare const ignored: number;\n");
  writeFileSync(join(source, "old.js"), "(function () {\n  return 7;\n})\n");
  // The Intl data modules are embedded exactly as written.
  writeFileSync(join(source, "intl.js"), "(function () {\n  return 1;\n})\n");
  const result = await runBuild();
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.reason, result.diagnostic).toBe("exit");
  const table = readFileSync(join(out, "polyfills.rs"), "utf8");
  expect(table).toContain('("leaf", include_str!(');
  expect(table).toContain(join(out, "runtime-js/old.js"));
  expect(table).toContain(join(source, "intl.js"));
  expect(table).not.toContain("ambient");
  const generated = readFileSync(join(out, "runtime-js/leaf.js"), "utf8");
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  expect((0, eval)(generated)(41)).toBe(42);
  expect(generated).not.toContain(": number");
  expect(generated).not.toContain("Comment text");
  expect(generated).toContain('"use strict"');
  expect(generated.trim().split("\n")).toHaveLength(1);
  // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
  expect((0, eval)(readFileSync(join(out, "runtime-js/old.js"), "utf8"))()).toBe(7);
  expect(readFileSync(join(source, "intl.js"), "utf8")).toContain("\n  return 1;\n");
  rmSync(join(source, "intl.js"));
});

test("excludes split-only polyfills when building engine-host without engine-split", async () => {
  for (const name of ["intl.js", "tz_data.js", "streams_polyfill.js", "webassembly.ts", "zone_names.js", "worker_lane.ts", "time_zone.ts", "zone_ids.js"]) {
    writeFileSync(join(source, name), "(function () { return 1; })\n");
  }
  try {
    const hostOut = join(scratch, "out-host-only");
    mkdirSync(hostOut, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, CARGO_MANIFEST_DIR: manifest, OUT_DIR: hostOut, BUNWASM_JS_OVERRIDE_DIR: "", BUNWASM_JS_PRESERVE_POSITIONS: "", CARGO_FEATURE_ENGINE_HOST: "1" };
    delete env.CARGO_FEATURE_ENGINE_SPLIT;
    const hostResult = await commands.run(builder, [], { phase: "embed-host-only-unset", timeout: 4_000, env });
    expect(hostResult.exitCode, hostResult.diagnostic).toBe(0);
    expect(hostResult.stdout.toString()).toContain("cargo:rerun-if-env-changed=CARGO_FEATURE_ENGINE_HOST");
    expect(hostResult.stdout.toString()).toContain("cargo:rerun-if-env-changed=CARGO_FEATURE_ENGINE_SPLIT");
    const table = readFileSync(join(hostOut, "polyfills.rs"), "utf8");
    expect(table).toContain('("leaf", include_str!(');
    for (const stem of ["intl", "tz_data", "streams_polyfill", "webassembly", "zone_names", "worker_lane", "time_zone", "zone_ids"]) {
      expect(table).not.toContain(`("${stem}",`);
    }
  } finally {
    for (const name of ["intl.js", "tz_data.js", "streams_polyfill.js", "webassembly.ts", "zone_names.js", "worker_lane.ts", "time_zone.ts", "zone_ids.js"]) {
      rmSync(join(source, name), { force: true });
    }
  }
});

test("keeps token positions when BUNWASM_JS_PRESERVE_POSITIONS is set", async () => {
  writeFileSync(join(source, "leaf.ts"), "(function (value: number) {\n  return value + 1;\n})\n");
  const result = await commands.run(builder, [], {
    phase: "embed-positions", timeout: 4_000,
    env: { ...process.env, CARGO_MANIFEST_DIR: manifest, OUT_DIR: out, BUNWASM_JS_OVERRIDE_DIR: "", BUNWASM_JS_PRESERVE_POSITIONS: "1" },
  });
  expect(result.exitCode, result.diagnostic).toBe(0);
  expect(result.stdout.toString()).toContain("cargo:rerun-if-env-changed=BUNWASM_JS_PRESERVE_POSITIONS");
  const table = readFileSync(join(out, "polyfills.rs"), "utf8");
  expect(table).toContain(join(source, "old.js"));
  expect(readFileSync(join(out, "runtime-js/leaf.js"), "utf8")).toBe("(function (value        ) {\n  return value + 1;\n})\n");
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
  // One batch minifies every module; the Intl data modules are left out of it.
  expect(result.stderr.match(/runtime-js launch phase=strip /g)).toBeNull();
  expect(result.stderr.match(/runtime-js launch phase=compact /g)).toHaveLength(1);
  expect(result.stderr).not.toContain("phase=compact source=" + join(root, "crates/bunwasm-runtime/src/js/intl.js"));
  expect(result.stderr.match(/runtime-js phase=bun_wrap /g)).toHaveLength(1);
  expect(result.stderr.match(/runtime-js phase=direct_stream /g)).toHaveLength(1);
  expect(table).toContain('("direct_stream", include_str!(');
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
