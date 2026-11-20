import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { programKind, sharedGroupPair } from "../src/engine-kind.ts";
import { convertSideInitializers } from "./spidermonkey-side-core-receipt.ts";
import { groupAddressSpaceBytes } from "./src/program-profile.ts";

export interface PanicProcessInputs {
  core: string;
  launcher: string;
  build: string;
  archive: string;
}

const modes = ["string", "owned", "opaque", "overflow"] as const;
const source = resolve(import.meta.dir, "../crates/bunwasm-spidermonkey/tests/fixtures/panic-report-control.rs");
const survivor = "panic process reached JavaScript";

function runProcess(launcher: string, core: string) {
  const result = spawnSync(launcher, ["--wasm", core, "--", "-e", `console.log(${JSON.stringify(survivor)})`],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function linkControl(inputs: PanicProcessInputs, scratch: string, mode: typeof modes[number], shared: boolean): void {
  const sdk = process.env.WASI_SDK_PATH;
  assert(sdk, "Source env.sh before the selected-engine panic controls");
  const object = join(scratch, "panic-control.o");
  const flags = ["--edition=2021", "--crate-type=lib", "--target=wasm32-wasip1", "--emit=obj",
    "-C", "panic=abort", "-C", "relocation-model=pic", "-C", "opt-level=2"];
  const libraries = readdirSync(join(dirname(inputs.archive), "build"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".rmeta"))
    .map(entry => join(entry.parentPath, entry.name));
  for (const directory of new Set(libraries.map(dirname))) flags.push("-L", `dependency=${directory}`);
  for (const name of ["std", "core", "alloc"]) {
    const matches = libraries.filter(file => file.includes(`/lib${name}-`));
    assert(matches.length === 1 && matches[0], `Expected one producer ${name} library`);
    flags.push("--extern", `${name}=${matches[0]}`);
  }
  if (shared) flags.push("-C", "target-feature=+atomics,+bulk-memory,+mutable-globals");
  execFileSync("rustc", flags.concat([source, "-o", object]),
    { env: { ...process.env, BUNSM_PANIC_CONTROL: mode }, stdio: "pipe", timeout: 120_000 });
  const implicit = join(scratch, "control.implicit.wasm");
  const group = shared ? ["--shared-memory", `--max-memory=${groupAddressSpaceBytes()}`,
    "--wrap=write", "--wrap=writev", "--wrap=clock_gettime", "--wrap=getcwd", join(inputs.build, "group-errno.o")] : [];
  execFileSync(join(sdk, "bin/wasm-ld"), ["--shared", "--Bsymbolic", "--no-export-dynamic", "--gc-sections", "--no-entry",
    "--import-memory=env,memory", "--import-table", "--allow-undefined", "--export=spidermonkey_ctor_value",
    "--export=__stack_pointer", "--export=__wasm_call_ctors", "--export=spidermonkey_register", "--export=spidermonkey_run",
    "--wrap=bunsm_host_call", "-o", implicit, join(inputs.build, "engine-init.o"), object].concat(group, [inputs.archive]),
  { stdio: "pipe", timeout: 120_000 });
  writeFileSync(join(scratch, "spidermonkey-engine.wasm"), convertSideInitializers(readFileSync(implicit), shared ? "shared-group" : "split"));
}

export function runPanicProcessControls(inputs: PanicProcessInputs) {
  const core = readFileSync(inputs.core);
  const module = new WebAssembly.Module(core);
  assert.equal(programKind(module), "spidermonkey");
  const normalSide = readFileSync(join(inputs.build, "engine.wasm"));
  const shared = sharedGroupPair(module, normalSide);
  const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-panic-process-"));
  try {
    const program = join(scratch, "bun.wasm");
    writeFileSync(program, core);
    copyFileSync(join(inputs.build, "engine.wasm"), join(scratch, "spidermonkey-engine.wasm"));
    const normal = runProcess(inputs.launcher, program);
    console.log(JSON.stringify({ mode: "normal", ...normal }));
    assert.deepEqual(normal, { status: 0, stdout: `${survivor}\n`, stderr: "" });
    const results = modes.map(mode => {
      linkControl(inputs, scratch, mode, shared);
      const result = runProcess(inputs.launcher, program);
      console.log(JSON.stringify({ mode, ...result }));
      assert.equal(result.status, 134, JSON.stringify({ mode, result }));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^bun-wasm: SpiderMonkey fatal error: SpiderMonkey Rust panic/);
      return { mode, ...result };
    });
    for (const result of results.filter(result => result.mode !== "overflow")) {
      assert.match(result.stderr, / at .*panic-report-control\.rs:\d+:\d+: /);
    }
    assert(results[0]?.stderr.endsWith("selected-engine panic control\n"));
    assert(results[1]?.stderr.endsWith("owned panic control\n"));
    assert(results[2]?.stderr.endsWith("non-string panic payload\n"));
    assert.equal(results[3]?.stderr, "bun-wasm: SpiderMonkey fatal error: SpiderMonkey Rust panic (report exceeded fixed buffer)\n");
    return { profile: shared ? "shared-group" : "split", inputs, normal, results };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [core, launcher, build, archive, output] = process.argv.slice(2);
  assert(core && launcher && build && archive && output, "Usage: spidermonkey-panic-process.ts CORE LAUNCHER SIDE_BUILD ENGINE_ARCHIVE OUTPUT_JSON");
  writeFileSync(output, JSON.stringify(runPanicProcessControls({ core, launcher, build, archive }), null, 2) + "\n");
}
