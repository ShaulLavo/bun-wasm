import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { automaticChecks, checkCommand, discoverChecks, selectChecks, runCheck, checkBatches, namedCheckBatches, selectCheckBatch, checkArguments, parseCheck, nativeEngineGroups, nativeProducerEngines } from "./test-checks";
import { migrationBase } from "./migrations/split-bun-patches";
import { oldSelections, proveCheckMigration } from "./migrations/discover-checks";
import { needsJsc, needsRust } from "./ci-changes";
import { installFixtureTargets } from "./install-fixture-command";

const root = resolve(import.meta.dir, "..");
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "bun-wasm-check-discovery-"));
  scratch.push(path);
  mkdirSync(join(path, "checks"));
  mkdirSync(join(path, "scripts"));
  writeFileSync(join(path, "scripts/example.test.ts"), "");
  writeFileSync(join(path, "checks/runtime-example.json"), JSON.stringify({ owner: "runtime", path: "scripts/example.test.ts", localRuntime: true }));
  return path;
}

function manifest(directory: string, fields: unknown, filename = "runtime-example.json") {
  writeFileSync(join(directory, "checks", filename), JSON.stringify(fields));
}

test("immutable old selections match the discovered sets, with seven overlapping probes assigned only to Web", () => {
  const proof = proveCheckMigration();
  expect(proof.deduplicated).toHaveLength(7);
  const original = oldSelections();
  const historical = new Set(Object.values(original).flat());
  expect(selectChecks("local-runtime").filter(path => historical.has(path))).toEqual(original.runtime.toSorted());
  const paths = proof.explicit.map(check => check.path).concat(proof.automatic.map(check => check.path));
  expect(new Set(paths).size).toBe(paths.length);
});

test("CI's native command runs the busy-loop stdout handshake fixture", () => {
  const command = checkCommand("native");
  expect(command.slice(0, 3)).toEqual(["bash", join(root, "scripts/test.sh"), "--no-build"]);
  expect(command).toContain("stdout-busy-loop");
});

test("WASI memory views declare blocking commands for all three supported engines", () => {
  const path = "tests/fixtures/wasi-memory-views";
  const check = discoverChecks().find(check => check.path === path);
  expect(check && "engines" in check ? check.engines : undefined).toEqual(["quickjs", "jsc", "browser"]);
  expect(needsJsc([`${path}/index.ts`])).toBe(true);
});

test("native commands select the declared engine explicitly", () => {
  const path = "tests/fixtures/wasi-memory-views";
  for (const engine of ["quickjs", "jsc", "browser"]) {
    expect(Reflect.apply(checkCommand, undefined, ["native", [path], "split", engine])).toEqual([
      "bash", join(root, "scripts/test.sh"), "--no-build", "--engine", engine, "wasi-memory-views",
    ]);
  }
});

test.each([[], ["jsc", "jsc"], ["unknown"], [17], "browser", null].map(engines => ({ engines })))("native engines reject invalid selection $engines", ({ engines }) => {
  expect(() => parseCheck({ owner: "native", path: "tests/fixtures/example", engines }, "native-example.json")).toThrow();
});

test("native execution discovers each WASI engine command once without changing other fixture ownership", () => {
  const path = "tests/fixtures/wasi-memory-views";
  const groups = nativeEngineGroups([path], { count: 2 });
  expect(groups.map(group => group.engine)).toEqual(["quickjs", "jsc", "browser"]);
  for (const group of groups) expect(group.commands).toEqual([
    ["bash", join(root, "scripts/test.sh"), "--no-build", "--engine", group.engine, "wasi-memory-views"],
  ]);
  const legacy = parseCheck({ owner: "native", path: "tests/fixtures/legacy-case" }, "native-legacy-case.json");
  const multi = parseCheck({ owner: "native", path, engines: ["quickjs", "jsc", "browser"] }, "native-wasi-memory-views.json");
  const mixed = nativeEngineGroups([path, legacy.path], { count: 2, checks: [multi, legacy] });
  expect(mixed[0]?.commands).toHaveLength(2);
  for (const group of mixed) expect(group.commands.flat().filter(argument => argument === "legacy-case")).toHaveLength(group.engine === "quickjs" ? 1 : 0);
});

test("native commands honor the CI producer subset without probing artifact presence", () => {
  const path = "tests/fixtures/wasi-memory-views";
  const producers = nativeProducerEngines({ BUN_WASM_CHECK_ENGINES: "quickjs,browser" });
  const groups = nativeEngineGroups([path], { count: 2, producers });
  expect(groups.map(group => group.engine)).toEqual(["quickjs", "browser"]);
  for (const group of groups) expect(group.commands).toEqual([
    ["bash", join(root, "scripts/test.sh"), "--no-build", "--engine", group.engine, "wasi-memory-views"],
  ]);
  const selected = nativeProducerEngines({ BUN_WASM_CHECK_ENGINES: "quickjs,jsc,browser" });
  expect(nativeEngineGroups([path], { count: 2, producers: selected }).map(group => group.engine)).toEqual(["quickjs", "jsc", "browser"]);
});

test("local native checks default to all declared producers", () => {
  expect(nativeProducerEngines({})).toEqual(["quickjs", "jsc", "browser", "spidermonkey"]);
});

test("native fixture engines and installer engines retain separate domains", () => {
  const env = { INSTALL_ENGINES: "quickjs,jsc,browser", BUN_WASM_CHECK_ENGINES: "quickjs,jsc,browser,spidermonkey" };
  expect(nativeProducerEngines(env)).toEqual(["quickjs", "jsc", "browser", "spidermonkey"]);
  expect(installFixtureTargets(env).map(target => target.engine)).toEqual(["quickjs", "jsc", "browser"]);
});

test("capacity, process and large IO retain blocking coverage on three ordinary engines", () => {
  const paths = ["process-wasm-capacity", "process", "io-large-pieces"].map(name => `tests/fixtures/${name}`);
  const env = { SPIDERMONKEY_WASM: "/ordinary pair/core.wasm" };
  const groups = nativeEngineGroups(paths, { count: 1, env });
  expect(groups.map(group => group.engine)).toEqual(["quickjs", "jsc", "spidermonkey"]);
  for (const group of groups) expect(group.commands[0]?.slice(-3)).toEqual(paths.map(path => path.slice("tests/fixtures/".length)).sort());
  expect(checkCommand("native", [paths[0]!], "split", "spidermonkey", env)).toEqual([
    "bash", join(root, "scripts/test.sh"), "--no-build", "--engine", "spidermonkey", "--wasm", "/ordinary pair/core.wasm", "--tier", "interp", "process-wasm-capacity",
  ]);
  expect(() => checkCommand("native", paths, "split", "spidermonkey", {})).toThrow("absolute SPIDERMONKEY_WASM");
  expect(() => checkCommand("native", paths, "split", "spidermonkey", { SPIDERMONKEY_WASM: "relative.wasm" })).toThrow("absolute");
});

test("CI declares its native fixture and installer engine domains separately", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const gate = workflow.split("name: Blocking native fixture checks")[1]!.split("\n      - name:")[0]!;
  expect(gate).toContain("INSTALL_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser' || 'quickjs,browser' }}");
  expect(gate).toContain("BUN_WASM_CHECK_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser,spidermonkey' || 'quickjs,browser,spidermonkey' }}");
  expect(gate).toContain("          bun scripts/test-checks.ts native\n");
});

test("native runner executes engine groups once and propagates the first failure", () => {
  const directory = fixture();
  copyFileSync(join(root, "scripts/test-checks.ts"), join(directory, "scripts/test-checks.ts"));
  copyFileSync(join(root, "scripts/install-fixture-command.ts"), join(directory, "scripts/install-fixture-command.ts"));
  writeFileSync(join(directory, "scripts/preflight.ts"), `import { installFixtureTargets } from "./install-fixture-command.ts";
if (installFixtureTargets().map(target => target.engine).join(",") !== "quickjs,jsc,browser") throw new Error("Invalid installer preflight engines");
`);
  writeFileSync(join(directory, "scripts/check-runtime.sh"), 'exec "$BUN_TEST_EXECUTABLE" "$PREFLIGHT_FILE"\n');
  writeFileSync(join(directory, "scripts/test.sh"), `engine=quickjs
case " $* " in
  *" --engine jsc "*) engine=jsc ;;
  *" --engine spidermonkey "*) engine=spidermonkey ;;
esac
printf '%s\\n' "$engine $*" >> "$RECORD"
[ "$engine" != "\${FAIL_ENGINE:-}" ]
`);
  for (const name of ["plain", "matrix"]) mkdirSync(join(directory, "tests/fixtures", name), { recursive: true });
  manifest(directory, { owner: "native", path: "tests/fixtures/plain" }, "native-plain.json");
  manifest(directory, { owner: "native", path: "tests/fixtures/matrix", engines: ["quickjs", "jsc", "spidermonkey"] }, "native-matrix.json");
  const record = join(directory, "record");
  const env: NodeJS.ProcessEnv = { ...process.env, RECORD: record, BUN_WASM_CHECK_JOBS: "1", INSTALL_ENGINES: "quickjs,jsc,browser", BUN_WASM_CHECK_ENGINES: "quickjs,jsc,spidermonkey", SPIDERMONKEY_WASM: "/ordinary/core.wasm", BUN_TEST_EXECUTABLE: process.execPath, PREFLIGHT_FILE: join(directory, "scripts/preflight.ts") };
  const run = () => spawnSync(process.execPath, [join(directory, "scripts/test-checks.ts"), "native"], { env, encoding: "utf8" });
  expect(run().status).toBe(0);
  expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
    "quickjs --no-build --engine quickjs matrix plain",
    "jsc --no-build --engine jsc matrix",
    "spidermonkey --no-build --engine spidermonkey --wasm /ordinary/core.wasm --tier interp matrix",
  ]);
  writeFileSync(record, "");
  env.FAIL_ENGINE = "jsc";
  expect(run().status).toBe(1);
  expect(readFileSync(record, "utf8")).not.toContain("spidermonkey");
});

test.each(["", "jsc,jsc", "unknown", "quickjs, jsc", ",browser"])("native producer selection rejects %s", value => {
  expect(() => nativeProducerEngines({ BUN_WASM_CHECK_ENGINES: value })).toThrow("Invalid native engines");
});

test("engine selection belongs only to split native fixtures", () => {
  expect(() => parseCheck({ owner: "web", path: "scripts/example.test.ts", engines: ["browser"] }, "web-example.json")).toThrow();
  expect(() => parseCheck({ owner: "native", path: "tests/fixtures/example", profile: "shared-group", engines: ["jsc"] }, "native-example.json")).toThrow();
});

test("import-specifier collection runs through the shared QuickJS and JSC native gates", () => {
  const path = "tests/fixtures/esm-import-specifier-collection";
  expect(discoverChecks().find(check => check.path === path)).toEqual({
    owner: "native", path, profile: "shared-group", localRuntime: false, batch: "default",
  });
  expect(selectChecks("native", undefined, "shared-group")).toContain(path);
  expect(selectChecks("native")).not.toContain(path);
  expect(checkCommand("native", [path], "shared-group")).toEqual([
    "bun", join(root, "scripts/native-profile-fixtures.ts"), path,
  ]);
});

test("discovery is sorted and adding a feature needs no shared command edit", () => {
  const directory = fixture();
  writeFileSync(join(directory, "scripts/another.test.ts"), "");
  manifest(directory, { owner: "runtime", path: "scripts/another.test.ts", localRuntime: true }, "runtime-another.json");
  expect(selectChecks("runtime", discoverChecks(directory))).toEqual(["scripts/another.test.ts", "scripts/example.test.ts"]);
  expect(() => selectChecks("web", discoverChecks(directory))).toThrow("Missing checks");
});

test("a later hostname feature keeps the formats limit under its existing single owner", () => {
  const directory = fixture();
  for (const path of ["formats-input-limit", "hostname-normalization"]) {
    writeFileSync(join(directory, `scripts/${path}.test.ts`), "");
    manifest(directory, { owner: "runtime", path: `scripts/${path}.test.ts`, localRuntime: true }, `runtime-${path}.json`);
  }
  expect(selectChecks("runtime", discoverChecks(directory))).toEqual(["scripts/example.test.ts", "scripts/formats-input-limit.test.ts", "scripts/hostname-normalization.test.ts"]);
  expect(discoverChecks().filter(check => check.path === "scripts/formats-input-limit.test.ts")).toEqual([
    { owner: "runtime", path: "scripts/formats-input-limit.test.ts", localRuntime: true, batch: "default" },
  ]);
});

test.each([
  { owner: "runtime", path: "scripts/../outside.test.ts" },
  { owner: "runtime", path: "/tmp/outside.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts;exit 0" },
  { owner: "runtime", path: "scripts/*.test.ts" },
  { owner: "runtime", path: "web/tests/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", command: "true" },
  { owner: "unknown", path: "scripts/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", localRuntime: "true" },
  { path: "scripts/example.test.ts" },
  { owner: "runtime", path: "scripts/example.test.ts", batch: "10-web" },
])("unsafe or malformed manifest is rejected: %j", fields => {
  const directory = fixture();
  manifest(directory, fields);
  expect(() => discoverChecks(directory)).toThrow();
});

test("missing, duplicate and linked inputs fail closed", () => {
  const directory = fixture();
  manifest(directory, { owner: "web", path: "scripts/example.test.ts" }, "web-duplicate.json");
  expect(() => discoverChecks(directory)).toThrow("Duplicate check owner");
  rmSync(join(directory, "checks/web-duplicate.json"));
  rmSync(join(directory, "scripts/example.test.ts"));
  expect(() => discoverChecks(directory)).toThrow();
  symlinkSync(join(root, "scripts/test-checks.test.ts"), join(directory, "scripts/example.test.ts"));
  expect(() => discoverChecks(directory)).toThrow("Unsafe linked check");
});

test("Browser guest secondary inputs preserve the blocking owner and profile selection", () => {
  const path = "scripts/example.test.ts";
  const inputs = ["web/src/example.ts"];
  const split = parseCheck({ owner: "browser-guest", path, inputs }, "browser-guest-example.json");
  const shared = parseCheck({ owner: "browser-guest", path, inputs, profile: "shared-group" }, "browser-guest-example.json");
  expect(split).toMatchObject({ owner: "browser-guest", path, inputs });
  expect(selectChecks("browser-guest", [split])).toEqual([path]);
  expect(selectChecks("browser-guest", [shared], "shared-group")).toEqual([path]);
  expect(checkCommand("browser-guest", [path])).toEqual(["bun", "test", join(root, path)]);
  expect(() => parseCheck({ owner: "web", path, inputs }, "web-example.json")).toThrow();
});

test.each([[], ["../outside.ts"], ["/outside.ts"], ["web/src/*.ts"], ["web/src/../outside.ts"], ["web/src/"], ["web/src/file.ts", "web/src/file.ts"], [17], "web/src/file.ts", null].map(inputs => ({ inputs })))("Browser guest rejects unsafe secondary inputs $inputs", ({ inputs }) => {
  expect(() => parseCheck({ owner: "browser-guest", path: "scripts/example.test.ts", inputs }, "browser-guest-example.json")).toThrow();
});

test("runner uses argv, no-build fixtures and failure propagation, not a shell command string", () => {
  expect(checkCommand("runtime", ["scripts/example.test.ts"])).toEqual(["bun", "test", join(root, "scripts/example.test.ts")]);
  expect(checkCommand("native", ["tests/fixtures/node-misc"])).toEqual(["bash", join(root, "scripts/test.sh"), "--no-build", "node-misc"]);
  const result = spawnSync("bun", ["./test-checks.ts", "invalid-owner"], { cwd: import.meta.dir, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Unknown check owner");
  const source = readFileSync(join(root, "scripts/test-checks.ts"), "utf8");
  expect(runCheck(["bun", "-e", "process.exit(23)"])).toBe(23);
  expect(source).toContain('BUN_WASM_CI_CHECKS: "1"');
});

function testFiles(folder: string): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry => {
    const path = `${folder}/${entry.name}`;
    return entry.isDirectory() ? testFiles(path) : /\.test\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

test("new script tests need an owner; existing non-CI probes remain outside the blocking selection", () => {
  const before = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", migrationBase], { cwd: root, encoding: "utf8" }).split("\n"));
  const owned = new Set(discoverChecks().map(check => check.path).concat(automaticChecks().map(check => check.path)));
  for (const path of testFiles("scripts")) expect(before.has(path) || owned.has(path)).toBe(true);
});

test("dormant Hermes proof controls stay outside explicit and automatic CI discovery", () => {
  const path = "tests/hermes/promise-ownership.test.ts";
  expect(testFiles("tests/hermes")).toContain(path);
  const paths = discoverChecks().map(check => check.path).concat(automaticChecks().map(check => check.path));
  expect(paths.filter(path => /^scripts\/hermes-|^tests\/hermes\//.test(path))).toEqual([]);
  const route = readFileSync(join(root, "tests/hermes/run.sh"), "utf8");
  const command = "bun test ./tests/hermes/promise-ownership.test.ts";
  expect(route.split(command)).toHaveLength(2);
  expect(route.indexOf(command)).toBeLessThan(route.indexOf('expect eval "2"'));
  expect(route).toContain("set -euo pipefail");
});

test("selected tests cannot import hidden test barrels that give a fixture a second owner", () => {
  const paths = discoverChecks().filter(check => check.owner !== "native").map(check => check.path).concat(automaticChecks().map(check => check.path));
  for (const path of paths) expect(readFileSync(join(root, path), "utf8")).not.toMatch(/^import\s+(?:.*from\s+)?["'][^"']+\.test\.[cm]?[jt]s["']/m);
});

test("each discovery group retains one command owner and browser deadlines stay outside discovery", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const owner of ["native", "package-extra", "cmake"]) expect(workflow.match(new RegExp(`bun scripts/test-checks\\.ts ${owner}\\n`, "g"))).toHaveLength(1);
  const web = readFileSync(join(root, "scripts/test-web-host.sh"), "utf8");
  expect(web.match(/bun \.\.\/scripts\/test-checks.ts web\n/g)).toHaveLength(1);
  expect(web).toContain("browser_test bun ../scripts/test-checks.ts web-browser");
  // The rust job bundles one verified site. Browser legs and the shared-profile consumer reuse it.
  expect(workflow.match(/bun \.\.\/scripts\/test-checks\.ts browser-guest --batch/g)).toHaveLength(1);
  expect(workflow.match(/bun scripts\/browser-guest-site\.ts build "\$RUNNER_TEMP\/browser-guest-site"\n/g)).toHaveLength(1);
  expect(workflow.match(/name: browser-guest-site\n/g)).toHaveLength(3);
  expect(workflow).toContain("BUN_WASM_BROWSER_SITE: ${{ runner.temp }}/browser-guest-site");
  expect(workflow).not.toContain("web/build.ts");
  expect(workflow).toContain("bun scripts/ci-install.ts --cwd sandbox --frozen-lockfile --ignore-scripts");
  const storage = discoverChecks().find(check => check.path === "scripts/sandbox-storage-browser.test.ts");
  expect(storage?.owner).toBe("browser-guest");
  expect(storage?.inputs).toContain("sandbox/template-sveltekit/src/routes/+page.svelte");
  const runtime = readFileSync(join(root, "scripts/check-runtime.sh"), "utf8");
  expect(runtime).toContain('bun "$root/scripts/test-checks.ts" runtime');
  expect(runtime).toContain('bun "$root/scripts/test-checks.ts" local-runtime');
  expect(runtime.indexOf('BUN_WASM_CI_CHECKS')).toBeLessThan(runtime.indexOf('"$root/web/node_modules/.bin/tsc" -p'));
});

function sandboxPageInputs(): string[] {
  const pending = [join(root, "sandbox/src/main.ts")];
  const inputs = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (inputs.has(path)) continue;
    inputs.add(path);
    if (!/\.[jt]sx?$/.test(path)) continue;
    const loader = path.endsWith("tsx") ? "tsx" : path.endsWith("js") ? "js" : "ts";
    const imports = new Bun.Transpiler({ loader }).scan(readFileSync(path, "utf8")).imports;
    for (const imported of imports) {
      if (!imported.path.startsWith(".")) continue;
      const input = Bun.resolveSync(imported.path, dirname(path));
      if (input.startsWith(`${root}/`) && !input.includes("/node_modules/")) pending.push(input);
    }
  }
  return Array.from(inputs, path => relative(root, path)).sort();
}

test("every consumed sandbox page input selects its real guest regression", () => {
  const check = discoverChecks().find(check => check.path === "scripts/sandbox-storage-browser.test.ts");
  expect(check?.owner).toBe("browser-guest");
  for (const path of sandboxPageInputs()) {
    expect(check?.inputs).toContain(path);
    expect(needsRust([path])).toBe(true);
  }
});

test("Web subprocess boundaries and fail-fast order are preserved by manifest batches", () => {
  const proof = proveCheckMigration();
  expect(checkBatches("web").map(paths => paths.filter(path => oldSelections().web.includes(path))).filter(paths => paths.length)).toEqual(proof.webBatches);
  expect(checkBatches("local-runtime")).toEqual([selectChecks("local-runtime")]);
  expect(proof.webBatches.map(paths => paths.length)).toEqual([10, 2, 3]);
});

test("native-probe inputs are typed and the source utility retains its lightweight owner", () => {
  const checks = discoverChecks();
  expect(selectChecks("cmake", checks)).toContain("scripts/tls-probe.test.ts");
  expect(selectChecks("native-probe", checks)).toEqual(["scripts/tls-probe-live.test.ts"]);
  const directory = fixture();
  writeFileSync(join(directory, "scripts/probe.test.ts"), "");
  const invalid = [undefined, [], ["../secret"], ["source.ts", "source.ts"], "source.ts"];
  for (const inputs of invalid) {
    manifest(directory, { owner: "native-probe", path: "scripts/probe.test.ts", inputs }, "native-probe-fixture.json");
    expect(() => discoverChecks(directory)).toThrow("native-probe");
  }
});


test("Browser guest matrix discovers each profile batch and runs every check exactly once", () => {
  const batches = namedCheckBatches("browser-guest");
  expect(batches.map(batch => batch.name)).toEqual(["10-storage", "default"]);
  const paths = batches.flatMap(batch => selectCheckBatch("browser-guest", batch.name));
  expect(paths.toSorted()).toEqual(selectChecks("browser-guest").toSorted());
  expect(new Set(paths).size).toBe(paths.length);
  expect(selectCheckBatch("browser-guest", "10-storage")).toEqual(["scripts/sandbox-storage-browser.test.ts"]);
  expect(() => selectCheckBatch("browser-guest", "missing")).toThrow("Unknown check batch");
  const shared = namedCheckBatches("browser-guest", undefined, "shared-group");
  expect(shared.flatMap(batch => batch.paths)).toEqual(selectChecks("browser-guest", undefined, "shared-group"));
  const result = spawnSync("bun", ["./test-checks.ts", "browser-guest", "--batches"], { cwd: import.meta.dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(batches.map(batch => batch.name));
  expect(checkArguments(["browser-guest", "--batch", "10-storage", "--list"])).toMatchObject({ batch: "10-storage", list: true });
  for (const args of [["--batch"], ["--batch", "--list"], ["--batch", "default", "--batches"], ["--batches", "--list"]]) {
    expect(() => checkArguments(["browser-guest"].concat(args))).toThrow();
  }
});

test("required Processes gates reject failed or cancelled guest batches and allow only producer-disabled skips", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const guest = workflow.split("\n  browser-guest:\n")[1]!.split(/\n  [\w-]+:\n/, 1)[0]!;
  expect(guest).toContain("batch: ${{ fromJSON(needs.selection.outputs.browser-guest-batches) }}");
  expect(guest).toContain("fail-fast: false");
  expect(guest).toContain("timeout-minutes: 10");
  expect(guest).not.toContain("browser-guest-site.ts build");
  const processes = workflow.split("\n  browser-process:\n")[1]!.split(/\n  [\w-]+:\n/, 1)[0]!;
  expect(processes).toContain("needs: [selection, rust, process-bundles, browser-guest]");
  expect(processes).toContain("always() && !cancelled()");
  const guard = processes.match(/run: \|\n([\s\S]*?)      - uses:/)?.[1];
  if (!guard) throw new Error("Missing required guest-result guard");
  for (const rust of ["success", "skipped", "failure", "cancelled"]) {
    for (const guest of ["success", "skipped", "failure", "cancelled"]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", guard], { env: { ...process.env, RUST_RESULT: rust, GUEST_RESULT: guest } });
      expect(result.status === 0, `${rust}/${guest}`).toBe(rust === "success" && guest === "success" || rust === "skipped" && guest === "skipped");
    }
  }
});
