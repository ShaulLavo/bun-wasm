import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { automaticChecks, checkCommand, checkId, discoverChecks, parseCheckId, selectChecks, runCheck, checkBatches, namedCheckBatches, selectCheckBatch, checkArguments, parseCheck, nativeEngineGroups, nativeProducerEngines, shardTestFiles, testJobs } from "./test-checks";
import { migrationBase } from "./migrations/split-bun-patches";
import { oldSelections, proveCheckMigration } from "./migrations/discover-checks";
import { needsJsc, needsRust } from "./ci-changes";
import { installFixtureTargets } from "./install-fixture-command";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");

test("named batches retain their allowed owners and reject malformed names", () => {
  const path = "scripts/example.test.ts";
  for (const owner of ["web", "browser-guest", "web-browser", "native-probe", "runtime"]) {
    expect(parseCheck({ owner, path, batch: "10-interface", ...(owner === "native-probe" ? { inputs: [path] } : {}) }, `${owner}-example.json`).batch).toBe("10-interface");
  }
  for (const owner of ["quality", "package-extra", "cmake", "native"]) {
    const input = owner === "native" ? "tests/fixtures/example" : path;
    expect(() => parseCheck({ owner, path: input, batch: "10-interface" }, `${owner}-example.json`)).toThrow("Invalid check batch");
  }
  for (const batch of [null, 1, [], {}, "", "interface", "10-", "10-Interface"]) {
    expect(() => parseCheck({ owner: "web-browser", path, batch }, "web-browser-example.json")).toThrow("Invalid check batch");
  }
});

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
  // One execution, one owner: compared by check id, since two commands of one fixture share a path.
  const ids = proof.explicit.map(checkId).concat(proof.automatic.map(check => check.path));
  expect(new Set(ids).size).toBe(ids.length);
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

test("CallSite predicates run through every ordinary engine's blocking fixture gate", () => {
  const path = "tests/fixtures/stack-callsite-predicates";
  const groups = nativeEngineGroups([path], { count: 1, env: { SPIDERMONKEY_WASM: "/fixture/bun-spidermonkey.wasm" } });
  expect(groups.map(group => group.engine)).toEqual(["quickjs", "jsc", "browser", "spidermonkey"]);
  for (const group of groups) {
    expect(group.commands).toHaveLength(1);
    expect(group.commands[0]).toContain("stack-callsite-predicates");
  }
  expect(needsJsc([`${path}/index.js`])).toBe(true);
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
  const workflow = expandedCiWorkflow();
  const runtimeGate = workflow.split("name: Blocking native runtime checks")[1]!.split("\n      - name:")[0]!;
  expect(runtimeGate).toContain('BUN_WASM_RUNTIME_JOBS: "3"');
  expect(runtimeGate).toContain("INSTALL_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser' || 'quickjs,browser' }}");
  expect(runtimeGate).toContain("BUN_WASM_CHECK_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser,spidermonkey' || 'quickjs,browser,spidermonkey' }}");
  expect(runtimeGate).toContain("          bun scripts/test-checks.ts native --only runtime");
  const fixtureGate = workflow.split("name: Blocking native fixture and install checks")[1]!.split("\n  browser-guest:")[0]!;
  expect(fixtureGate).toContain("INSTALL_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser' || 'quickjs,browser' }}");
  expect(fixtureGate).toContain("BUN_WASM_CHECK_ENGINES: ${{ needs.selection.outputs.jsc == 'true' && 'quickjs,jsc,browser,spidermonkey' || 'quickjs,browser,spidermonkey' }}");
  expect(fixtureGate).toContain("          bun scripts/test-checks.ts native --only fixtures");
  expect(checkArguments(["native", "--only", "runtime"])).toMatchObject({ owner: "native", only: "runtime" });
  expect(checkArguments(["native", "--only", "fixtures"])).toMatchObject({ owner: "native", only: "fixtures" });
  expect(() => checkArguments(["native", "--only", "invalid"])).toThrow("Invalid native phase");
  expect(() => checkArguments(["quality", "--only", "runtime"])).toThrow("native");
});

test("testJobs validates bounds and shardTestFiles distributes every path once and spreads heavy files for relative and absolute paths", () => {
  expect(testJobs(undefined)).toBe(1);
  for (const value of ["1", "2", "3", "4"]) expect(testJobs(value)).toBe(Number(value));
  for (const value of ["", "0", "5", "2.5", "-1", "abc"]) expect(() => testJobs(value)).toThrow("Invalid BUN_WASM_TEST_JOBS");
  const files = selectChecks("quality");
  const relativeShards = shardTestFiles(files, 4);
  const absoluteFiles = files.map(path => join(root, path));
  const absoluteShards = shardTestFiles(absoluteFiles, 4);
  for (const [shards, expected] of [[relativeShards, files], [absoluteShards, absoluteFiles]] as const) {
    expect(shards).toHaveLength(4);
    expect(shards.flat().toSorted()).toEqual(expected.toSorted());
    expect(new Set(shards.flat()).size).toBe(expected.length);
  }
  const heavyPrefix = ["scripts/ci-changes.test.ts", "scripts/ci-check-inputs.test.ts", "scripts/goals-matrix/playground.test.ts", "scripts/quality-probes.test.ts"];
  heavyPrefix.forEach((file, index) => {
    expect(relativeShards[index]?.[0]).toBe(file);
    expect(absoluteShards[index]?.[0]).toBe(join(root, file));
  });
});

test("runShardedFiles preserves sibling and signaled child diagnostics instead of discarding buffered output", () => {
  const directory = fixture();
  writeFileSync(join(directory, "ok.test.ts"), 'import { test } from "bun:test"; test("ok", () => { console.log("SIBLING_DIAGNOSTIC_OK"); });\n');
  writeFileSync(join(directory, "killed.test.ts"), 'import { test } from "bun:test"; test("killed", () => { console.log("SIGNALED_DIAGNOSTIC_BEFORE_KILL"); process.kill(process.pid, "SIGTERM"); });\n');
  const script = `import { runShardedFiles } from ${JSON.stringify(join(root, "scripts/test-checks.ts"))};
process.exitCode = await runShardedFiles([${JSON.stringify(join(directory, "ok.test.ts"))}, ${JSON.stringify(join(directory, "killed.test.ts"))}], 2);
`;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("SIBLING_DIAGNOSTIC_OK");
  expect(result.stdout).toContain("SIGNALED_DIAGNOSTIC_BEFORE_KILL");
  expect(result.stdout).toContain("terminated by SIGTERM");
});

test("runtime declarations retain process isolation and source selection inputs together", () => {
  const raw = { owner: "runtime", path: "scripts/example.test.ts", isolation: "process", inputs: ["scripts/example.ts"] };
  const parsed = parseCheck(raw, "runtime-example.json");
  expect(parsed).toEqual({ owner: "runtime", path: raw.path, isolation: "process", inputs: raw.inputs, batch: "default", localRuntime: false });
  expect(raw).toEqual({ owner: "runtime", path: "scripts/example.test.ts", isolation: "process", inputs: ["scripts/example.ts"] });
  expect(parseCheck({ owner: "runtime", path: raw.path, isolation: "process" }, "runtime-example.json")).toEqual({
    owner: "runtime", path: raw.path, isolation: "process", inputs: [], batch: "default", localRuntime: false,
  });
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
  delete env.FAIL_ENGINE;
  writeFileSync(record, "");
  env.BUN_WASM_CHECK_JOBS = "2";
  expect(run().status).toBe(0);
  const parallelLines = readFileSync(record, "utf8").trim().split("\n");
  expect(parallelLines.some(line => line.startsWith("quickjs ") && line.includes("plain"))).toBe(true);
  expect(parallelLines.some(line => line.startsWith("quickjs ") && line.includes("matrix"))).toBe(true);
  expect(parallelLines.some(line => line.startsWith("jsc ") && line.includes("matrix"))).toBe(true);
  expect(parallelLines.some(line => line.startsWith("spidermonkey ") && line.includes("matrix"))).toBe(true);
});

test.each(["", "jsc,jsc", "unknown", "quickjs, jsc", ",browser"])("native producer selection rejects %s", value => {
  expect(() => nativeProducerEngines({ BUN_WASM_CHECK_ENGINES: value })).toThrow("Invalid native engines");
});

test("engine selection belongs only to split native fixtures", () => {
  expect(() => parseCheck({ owner: "web", path: "scripts/example.test.ts", engines: ["browser"] }, "web-example.json")).toThrow();
  expect(() => parseCheck({ owner: "native", path: "tests/fixtures/example", profile: "shared-group", engines: ["jsc"] }, "native-example.json")).toThrow();
});

test("named shared commands keep their identity and reject split engine selection", () => {
  const value = { owner: "native", path: "tests/fixtures/example", profile: "shared-group", entry: "lifetime" };
  const check = parseCheck(value, "native-example.json");
  expect(checkId(check)).toBe("tests/fixtures/example#lifetime");
  expect(nativeEngineGroups([checkId(check)], { count: 1, checks: [check] })).toEqual([]);
  expect(() => parseCheck({ ...value, engines: ["jsc"] }, "native-example.json")).toThrow("Only split native checks select engines");
  expect(() => parseCheck({ ...value, profile: "split", engines: ["jsc"] }, "native-example.json")).toThrow("Only native shared-group checks name an entry");
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
    { owner: "runtime", path: "scripts/formats-input-limit.test.ts", localRuntime: true, batch: "default", inputs: [] },
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
  { owner: "quality", path: "scripts/example.test.ts", batch: "10-web" },
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

test("a fixture's second command needs its own files, one owner and one declaration", () => {
  const directory = fixture();
  const path = "tests/fixtures/shared";
  const files = (names: readonly string[]) => { for (const name of names) writeFileSync(join(directory, path, name), "run\n"); };
  mkdirSync(join(directory, path), { recursive: true });
  files(["cmd", "expected.txt", "cmd.lifetime", "expected.lifetime.txt"]);
  manifest(directory, { owner: "native", path, profile: "shared-group" }, "native-shared.json");
  manifest(directory, { owner: "native", path, profile: "shared-group", entry: "lifetime" }, "native-shared-lifetime.json");
  expect(discoverChecks(directory).filter(check => check.path === path).map(checkId)).toEqual([path, `${path}#lifetime`]);
  // The same entry twice, or two default commands, is one execution with two owners.
  manifest(directory, { owner: "native", path, profile: "shared-group", entry: "lifetime" }, "native-shared-again.json");
  expect(() => discoverChecks(directory)).toThrow(`Duplicate check owner: ${path}#lifetime`);
  manifest(directory, { owner: "native", path, profile: "shared-group" }, "native-shared-again.json");
  expect(() => discoverChecks(directory)).toThrow(`Duplicate check owner: ${path}`);
  // A split owner cannot share the fixture with the shared-group commands.
  manifest(directory, { owner: "native", path }, "native-shared-again.json");
  expect(() => discoverChecks(directory)).toThrow(`Conflicting check owners: ${path}`);
  rmSync(join(directory, "checks/native-shared-again.json"));
  // An entry's command and expected output are regular files in the fixture.
  for (const name of ["cmd.lifetime", "expected.lifetime.txt"]) {
    rmSync(join(directory, path, name));
    expect(() => discoverChecks(directory), name).toThrow(`needs ${name}`);
    symlinkSync(join(directory, path, "cmd"), join(directory, path, name));
    expect(() => discoverChecks(directory), name).toThrow(`needs ${name}`);
    rmSync(join(directory, path, name));
    mkdirSync(join(directory, path, name));
    expect(() => discoverChecks(directory), name).toThrow(`needs ${name}`);
    rmSync(join(directory, path, name), { recursive: true });
    files([name]);
  }
  expect(discoverChecks(directory).map(checkId)).toContain(`${path}#lifetime`);
  expect(parseCheckId(`${path}#lifetime`)).toEqual({ path, entry: "lifetime" });
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

test.each([[], ["../outside.ts"], ["/outside.ts"], ["web/src/*.ts"], ["web/src/../outside.ts"], ["web/src/"], ["web/src/file.ts", "web/src/file.ts"], [17], "web/src/file.ts", null].map(inputs => ({ inputs })))("producer consumers reject unsafe secondary inputs $inputs", ({ inputs }) => {
  for (const owner of ["browser-guest", "runtime"]) expect(() => parseCheck({ owner, path: "scripts/example.test.ts", inputs }, `${owner}-example.json`)).toThrow();
});

test("runtime helpers preserve one blocking owner and local preflight selection", () => {
  const path = "scripts/example.test.ts";
  const inputs = ["web/scripts/run.ts", "tests/fixtures/net-fetch/expected.txt"];
  const check = parseCheck({ owner: "runtime", path, localRuntime: true, inputs }, "runtime-example.json");
  expect(check).toMatchObject({ owner: "runtime", path, inputs });
  expect(selectChecks("runtime", [check])).toEqual([path]);
  expect(selectChecks("local-runtime", [check])).toEqual([path]);
  expect(() => selectChecks("web", [check])).toThrow("Missing checks for web");
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
}, 30_000);

test("each discovery group retains one command owner and browser deadlines stay outside discovery", () => {
  const workflow = expandedCiWorkflow();
  for (const owner of ["package-extra", "cmake"]) expect(workflow.match(new RegExp(`bun scripts/test-checks\\.ts ${owner}\\n`, "g"))).toHaveLength(1);
  expect(workflow.match(/bun scripts\/test-checks\.ts native --only runtime\n/g)).toHaveLength(1);
  expect(workflow.match(/bun scripts\/test-checks\.ts native --only fixtures\n/g)).toHaveLength(1);
  const web = readFileSync(join(root, "scripts/test-web-host.sh"), "utf8");
  expect(web.match(/bun \.\.\/scripts\/test-checks.ts web\n/g)).toHaveLength(1);
  expect(web).toContain("browser_test bun ../scripts/test-checks.ts web-browser");
  // ordinary-build bundles one verified site. Browser legs and shared consumers reuse it.
  expect(readFileSync(join(root, "scripts/ci-browser-guest-run.ts"), "utf8")).toContain('"browser-guest", "--batch", batch.name');
  expect(readFileSync(join(root, ".github/actions/native-production/action.yml"), "utf8").match(/bun scripts\/browser-guest-site\.ts build "\$RUNNER_TEMP\/browser-guest-site"\n/g)).toHaveLength(1);
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
  expect(selectChecks("native-probe", checks)).toEqual(["scripts/jsc-resizable-native.test.ts", "scripts/quickjs-regexp-test.test.ts", "scripts/tls-probe-live.test.ts"]);
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
  expect(batches.map(batch => batch.name)).toEqual(["10-storage", "11-multitab", "20-installer-links", "21-subprocess-aliases", "22-preview-websocket-headers", "23-engine-interruption", "24-worker-modules", "25-terminal-stdin", "26-tools-integrity", "default"]);
  const paths = batches.flatMap(batch => selectCheckBatch("browser-guest", batch.name));
  expect(paths.toSorted()).toEqual(selectChecks("browser-guest").toSorted());
  expect(new Set(paths).size).toBe(paths.length);
  expect(selectCheckBatch("browser-guest", "10-storage")).toEqual(["scripts/sandbox-fs-observation-browser.test.ts", "scripts/sandbox-storage-browser.test.ts"]);
  expect(selectCheckBatch("browser-guest", "11-multitab")).toEqual(["scripts/isolated-preview-origins-browser.test.ts", "scripts/multitab-browser.test.ts"]);
  expect(selectChecks("web")).toContain("scripts/sandbox-editor-sync.test.ts");
  expect(selectChecks("web")).toContain("scripts/sandbox-dev-server-coordinator.test.ts");
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

test("browser-guest and web-browser keep process checks blocking and fail-closed under ci-result", () => {
  const workflow = expandedCiWorkflow();
  const guest = workflow.split("\n  browser-guest:\n")[1]!.split(/\n  [\w-]+:\n/, 1)[0]!;
  expect(guest).toContain("matrix: ${{ fromJSON(needs.selection.outputs.browser-guest-matrix) }}");
  expect(guest).toContain("fail-fast: false");
  expect(guest).toContain("timeout-minutes: ${{ matrix.timeoutMinutes }}");
  expect(guest).not.toContain("browser-guest-site.ts build");
  expect(guest).toContain("needs: [selection, ordinary-build, web-browser]");
  expect(guest).toContain('bun ../scripts/run-with-timeout.mts 300 bun tests/bun-runtime-proc-browser.ts "$b"');
  expect(guest).toContain('bun ../scripts/run-with-timeout.mts 120 bun tests/browser-wasm-transfer.ts "$b"');
  const webBrowser = workflow.split("\n  web-browser:\n")[1]!.split(/\n  [\w-]+:\n/, 1)[0]!;
  expect(webBrowser).toContain("bun ../scripts/ci-web-browser-run.ts");
  const webRunner = readFileSync(join(root, "scripts/ci-web-browser-run.ts"), "utf8");
  for (const script of ["tests/browser-process.ts", "tests/browser-interrupt.ts", "tests/browser-runtime-proc.ts"]) {
    expect(webRunner).toContain(script);
  }
});
