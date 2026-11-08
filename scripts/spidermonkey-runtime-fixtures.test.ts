import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const source = resolve(import.meta.dir, "..");
const roots: string[] = [];
const children = new Set<ReturnType<typeof Bun.spawn>>();
// Install cleanup before any synthetic executable or fixture directory exists.
function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
async function teardown() {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(Array.from(children, child => child.exited));
  children.clear();
  cleanup();
}
afterEach(teardown);
process.once("exit", cleanup);
process.once("SIGINT", () => { void teardown().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void teardown().finally(() => process.exit(143)); });

function put(path: string, text: string, executable = false) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (executable) chmodSync(path, 0o755);
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-runtime-fixtures-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(join(source, "scripts/test.sh"), join(root, "scripts/test.sh"));
  copyFileSync(join(source, "env.sh"), join(root, "env.sh"));
  mkdirSync(join(root, "tmp"));
  const launcher = join(root, "inputs with spaces", "launcher");
  const core = join(root, "inputs with spaces", "core.wasm");
  const side = join(dirname(core), "spidermonkey-engine.wasm");
  const shell = join(root, "shell.wasm");
  const utility = join(root, "env.wasm");
  for (const file of [core, side, shell, utility]) put(file, "synthetic bytes, never executed as Wasm\n");
  // This records the real test.sh child contract, not SpiderMonkey behavior.
  put(launcher, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
if (process.env.IGNORE_TERM === "1") process.on("SIGTERM", () => {});
appendFileSync(process.env.RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), tier: process.env.BUN_WASM_SPIDERMONKEY_TIER, cache: process.env.BUN_WASM_CACHE_DIR, stdin: readFileSync(0, "utf8"), pid: process.pid }) + "\\n");
if (process.env.HANG === "1") { while (true) {} }
if (existsSync("mutated")) process.exit(91);
writeFileSync("mutated", "fresh scratch only");
process.stdout.write(process.env.BAD_STDOUT === "1" ? "wrong\\n" : readFileSync(existsSync("stdout") ? "stdout" : "expected.txt", "utf8"));
process.stderr.write(process.env.BAD_STDERR === "1" ? "unexpected error\\n" : existsSync("expected_stderr.txt") ? readFileSync("expected_stderr.txt", "utf8") : "");
process.exit(Number(process.env.BAD_EXIT ?? (existsSync("expected_exit") ? readFileSync("expected_exit", "utf8") : "0")));
`, true);
  const forbidden = '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$FORBIDDEN"\nexit 93\n';
  for (const name of ["check-runtime.sh", "build.sh", "build-bun-jsc.sh", "build-bun-browser.sh", "build-engine-spidermonkey.sh", "build-bun-spidermonkey.sh", "build-bash-web-shell.sh"]) put(join(root, "scripts", name), forbidden, true);
  put(join(root, "bin/node"), '#!/bin/sh\nexec "$BUN_WASM_LAUNCHER" "$@"\n', true);
  put(join(root, "tools/bin/cargo"), forbidden, true);
  put(join(root, "bin/wasmtime"), forbidden, true);
  // Keep timeout tests cheap without weakening the production deadline.
  put(join(root, "bin/timeout"), '#!/bin/sh\nif [ "$SHORT_TIMEOUT" = 1 ]; then shift 2; exec /usr/bin/timeout --kill-after=.1s .1s "$@"; fi\nexec /usr/bin/timeout "$@"\n', true);
  for (const name of ["hello", "arguments", "failure", "later"]) put(join(root, "tests/fixtures", name, "index.ts"), 'console.log("fixture");\n');
  for (const name of ["hello", "arguments", "failure", "later"]) put(join(root, "tests/fixtures", name, "expected.txt"), `${name}\n`);
  put(join(root, "tests/fixtures/arguments/cmd"), "-e\nconsole.log('two words')\n");
  put(join(root, "tests/fixtures/arguments/args"), "one argument\n--flag=value\n");
  put(join(root, "tests/fixtures/arguments/expected_stderr.txt"), "expected diagnostic\n");
  put(join(root, "tests/fixtures/arguments/expected_exit"), "7\n");
  put(join(root, "tests/fixtures/arguments/stdin"), "input with spaces\n");
  put(join(root, "tests/fixtures/arguments/stdout"), "arguments\n");
  put(join(root, "tests/fixtures/arguments/show"), "mutated\n");
  put(join(root, "tests/fixtures/arguments/expected.txt"), "arguments\n--- mutated\nfresh scratch only");
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    TMPDIR: join(root, "tmp"),
    CARGO_TARGET_DIR: join(root, "target"),
    CARGO_HOME: join(root, "tools"),
    BUN_WASM_LAUNCHER: launcher,
    BUN_WASM_SHELL: shell,
    BUN_WASM_ENV_UTILITY: utility,
    BUN_WASM_RUNTIME_CHECKED: "0",
    BUN_WASM_SPIDERMONKEY_TIER: "ambient-must-not-win",
    BUN_WASM_CACHE_DIR: "off",
    TEST_SERVER: "",
    RECORD: join(root, "record.jsonl"),
    FORBIDDEN: join(root, "forbidden"),
  };
  return { root, launcher, core, side, shell, utility, env };
}
type Sandbox = ReturnType<typeof sandbox>;

function invoke(box: Sandbox, args: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawnSync(["bash", join(box.root, "scripts/test.sh")].concat(args), {
    cwd: box.root, env: { ...box.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  expect(existsSync(box.env.FORBIDDEN)).toBe(false);
  expect(readdirSync(join(box.root, "tmp"))).toEqual([]);
  return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
}
function selection(box: Sandbox, tier = "interp") {
  return ["--engine", "spidermonkey", "--wasm", box.core, "--tier", tier];
}
function records(box: Sandbox): { argv: string[]; cwd: string; tier: string; cache: string; stdin: string; pid: number }[] {
  return readFileSync(box.env.RECORD, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
}

test("explicit interpreter and PBL runs use the supplied native pair and separate child environments without building", () => {
  const box = sandbox();
  for (const tier of ["interp", "pbl"]) {
    const result = invoke(box, selection(box, tier).concat(["hello", "arguments", "hello"]));
    expect(result.code).toBe(0);
    expect(result.output).toContain("3 passed, 0 failed");
    expect(result.output).toContain(`tier=${tier}`);
  }
  const launches = records(box);
  expect(launches.map(record => record.tier)).toEqual(["interp", "interp", "interp", "pbl", "pbl", "pbl"]);
  expect(launches.every(record => record.cache === "off")).toBe(true);
  const first = launches[0]!;
  expect(first.argv).toEqual([
    "--wasm", box.core, "--engine", `spidermonkey=${box.core}`, "--shell", box.shell, "--env-utility", box.utility,
    "--env", "PATH=/opt/bun/spidermonkey/bin:/bin:/usr/bin", "--dir", `${first.cwd}::/`, "--env", "PWD=/", "--env", "HOME=/",
    "--env", "BUNWASM_TEST=1", "--env", "BUNWASM_TEST_HOST=native", "--env", "TEST_SERVER=",
    "--env", "BUN_WASM_SPIDERMONKEY_TIER=interp", "--", "run", "/index.ts",
  ]);
  expect(launches[1]!.stdin).toBe("input with spaces\n");
  expect(launches[4]!.stdin).toBe("input with spaces\n");
  expect(launches[1]!.argv.slice(-4)).toEqual(["-e", "console.log('two words')", "one argument", "--flag=value"]);
  expect(new Set(launches.map(record => record.pid)).size).toBe(6);
  expect(new Set(launches.map(record => record.cwd)).size).toBe(4);
  expect(existsSync(join(box.root, "tests/fixtures/hello/mutated"))).toBe(false);
});

test("inline selector forms and explicit no-build work", () => {
  const box = sandbox();
  const result = invoke(box, ["--engine=spidermonkey", `--wasm=${box.core}`, "--tier=pbl", "--no-build", "hello"]);
  expect(result.code).toBe(0);
  expect(records(box)[0]!.tier).toBe("pbl");
});

test("experimental selection rejects unsupported values, update, and missing option values before any producer or preflight", () => {
  const box = sandbox();
  for (const args of [
    ["--engine", "hermes"], ["--engine", "spidermonkey-pbl"], ["--engine", "spidermonkey-interp"],
    selection(box, "jit"), selection(box, ""), selection(box).concat(["--update"]),
    ["--engine"], ["--context"], ["--engine", "spidermonkey", "--wasm"], selection(box).concat(["--tier"]),
    selection(box).concat(["--context", "hooks"]), ["--tier", "pbl"], ["--wasm", box.core], ["--tier="], ["--wasm="], selection(box).concat(["--context", "invalid"]),
  ]) {
    const result = invoke(box, args);
    expect(result.code).toBe(2);
  }
  expect(existsSync(box.env.RECORD)).toBe(false);
});

test("no implicit dist, default launcher, tier, or shell inputs can fill missing experimental inputs", () => {
  const box = sandbox();
  put(join(box.root, "dist/bun-spidermonkey.wasm"), "stale bytes");
  put(join(box.root, "dist/spidermonkey-engine.wasm"), "stale bytes");
  for (const [args, env] of [
    [["--engine", "spidermonkey", "--tier", "interp", "hello"], {}],
    [["--engine", "spidermonkey", "--wasm", box.core, "hello"], {}],
    [selection(box).concat(["hello"]), { BUN_WASM_LAUNCHER: "" }],
    [selection(box).concat(["hello"]), { BUN_WASM_LAUNCHER: join(box.root, "missing") }],
    [selection(box).concat(["hello"]), { BUN_WASM_SHELL: "" }],
    [selection(box).concat(["hello"]), { BUN_WASM_ENV_UTILITY: "" }],
  ] satisfies [string[], NodeJS.ProcessEnv][]) expect(invoke(box, args, env).code).toBe(2);
  for (const path of [box.core, box.side, box.shell, box.utility]) {
    rmSync(path);
    expect(invoke(box, selection(box).concat(["hello"])).code).toBe(2);
    put(path, "synthetic bytes\n");
  }
  chmodSync(box.launcher, 0o644);
  expect(invoke(box, selection(box).concat(["hello"])).code).toBe(2);
  expect(existsSync(box.env.RECORD)).toBe(false);
});

for (const variable of ["BAD_STDOUT", "BAD_STDERR", "BAD_EXIT"]) {
  test(`complete experimental fixture comparison rejects ${variable}`, () => {
    const box = sandbox();
    const result = invoke(box, selection(box).concat(["failure", "later"]), { [variable]: "1" });
    expect(result.code).toBe(1);
    expect(result.output).toContain("0 passed, 2 failed");
    expect(result.output).toContain("FAIL failure");
    expect(result.output).toContain("FAIL later");
    expect(records(box)).toHaveLength(2);
  });
}

test("a timed-out fixture fails, terminates its child, and removes scratch", () => {
  const box = sandbox();
  const result = invoke(box, selection(box).concat(["hello"]), { HANG: "1", SHORT_TIMEOUT: "1" });
  expect(result.code).toBe(1);
  expect(result.output).toContain("exit 124, expected 0");
  const pid = records(box)[0]!.pid;
  expect(() => process.kill(pid, 0)).toThrow();
});

test("specialized selector failures remain in the denominator when a harness cannot start", () => {
  const box = sandbox();
  const probes = ["http-response-lifecycle", "worker-review", "fs-empty-read", "stdout-busy-loop", "fs-writev-partial", "pipe-closed-output"];
  const result = invoke(box, selection(box).concat(probes, ["hello"]));
  expect(result.code).toBe(1);
  expect(result.output).toContain("1 passed, 6 failed");
  for (const name of probes) expect(result.output).toContain(name);
  expect(result.output).not.toContain("specialized harness has no explicit SpiderMonkey program/tier contract");
  expect(records(box).length).toBeGreaterThanOrEqual(1);
});

for (const engine of ["quickjs", "jsc"]) {
  test(`ordinary ${engine} native no-build selection retains its defaults and argv`, () => {
    const box = sandbox();
    const args = ["--no-build", "hello"];
    const result = invoke(box, engine === "quickjs" ? args : ["--engine", engine].concat(args), { BUN_WASM_RUNTIME_CHECKED: "1" });
    expect(result.code).toBe(0);
    const record = records(box)[0]!;
    const wasm = join(box.root, "dist", engine === "quickjs" ? "bun.wasm" : "bun-jsc.wasm");
    expect(record.argv.slice(0, 4)).toEqual(["--wasm", wasm, "--engine", `${engine}=${wasm}`]);
    expect(record.argv).not.toContain("BUN_WASM_SPIDERMONKEY_TIER=interp");
    expect(record.tier).toBe("ambient-must-not-win");
  });
}


test("relative explicit inputs resolve before the fixture child changes cwd", () => {
  const box = sandbox();
  const result = invoke(box, ["--engine", "spidermonkey", "--wasm", "inputs with spaces/core.wasm", "--tier", "interp", "hello"], {
    BUN_WASM_LAUNCHER: "inputs with spaces/launcher", BUN_WASM_SHELL: "shell.wasm", BUN_WASM_ENV_UTILITY: "env.wasm",
  });
  expect(result.code).toBe(0);
  expect(records(box)[0]!.argv.slice(0, 8)).toEqual(["--wasm", box.core, "--engine", `spidermonkey=${box.core}`, "--shell", box.shell, "--env-utility", box.utility]);
});

test("invalid experimental fixture names fail without touching paths or invoking a launcher", () => {
  const box = sandbox();
  const result = invoke(box, selection(box).concat(["../hello", "absent"]));
  expect(result.code).toBe(1);
  expect(result.output).toContain("0 passed, 2 failed");
  expect(existsSync(box.env.RECORD)).toBe(false);
});

for (const context of ["native", "hooks"]) {
  test(`ordinary browser ${context} selection retains Node host arguments`, () => {
    const box = sandbox();
    const result = invoke(box, ["--engine", "browser", "--context", context, "--no-build", "hello"], { BUN_WASM_RUNTIME_CHECKED: "1" });
    expect(result.code).toBe(0);
    const record = records(box)[0]!;
    expect(record.argv.slice(0, 6)).toEqual(["--no-warnings", join(box.root, "web/scripts/node-host.mjs"), "--wasm", join(box.root, "dist/bun-browser.wasm"), "--context", context]);
    expect(record.argv).not.toContain("--engine");
    expect(record.tier).toBe("ambient-must-not-win");
  });
}

test("browser registration-record selection survives the experimental fixture integration", () => {
  const box = sandbox();
  const result = invoke(box, ["--engine", "browser", "--modules", "records", "--no-build", "hello"], { BUN_WASM_RUNTIME_CHECKED: "1" });
  expect(result.code).toBe(0);
  const record = records(box)[0]!;
  const mode = record.argv.indexOf("--modules");
  expect(mode).toBeGreaterThan(0);
  expect(record.argv[mode + 1]).toBe("records");
  expect(record.tier).toBe("ambient-must-not-win");
});

test("ordinary default invocation retains preflight, guest, launcher, and shell build steps", () => {
  const box = sandbox();
  const recordStep = '#!/bin/sh\nprintf "%s\\n" "$0" >> "$STEPS"\n';
  for (const name of ["check-runtime.sh", "build.sh", "build-bash-web-shell.sh"]) put(join(box.root, "scripts", name), recordStep, true);
  put(join(box.root, "tools/bin/cargo"), recordStep, true);
  const steps = join(box.root, "steps");
  const result = invoke(box, ["hello"], { STEPS: steps });
  expect(result.code).toBe(0);
  expect(readFileSync(steps, "utf8").trimEnd().split("\n")).toEqual([
    join(box.root, "scripts/check-runtime.sh"), join(box.root, "scripts/build.sh"), join(box.root, "tools/bin/cargo"), join(box.root, "scripts/build-bash-web-shell.sh"),
  ]);
});

async function waitForLaunch(box: Sandbox) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(box.env.RECORD)) return records(box)[0]!;
    await Bun.sleep(10);
  }
  throw new Error("Synthetic launcher never started");
}

test("SIGTERM stops the active fixture child before removing its scratch", async () => {
  const box = sandbox();
  const child = Bun.spawn(["bash", join(box.root, "scripts/test.sh")].concat(selection(box), ["hello"]), {
    cwd: box.root, env: { ...box.env, HANG: "1" }, stdout: "pipe", stderr: "pipe",
  });
  children.add(child);
  try {
    const record = await waitForLaunch(box);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(() => process.kill(record.pid, 0)).toThrow();
    expect(readdirSync(join(box.root, "tmp"))).toEqual([]);
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    children.delete(child);
  }
});


test("the default experimental selection counts every discovered fixture", () => {
  const box = sandbox();
  const result = invoke(box, selection(box));
  expect(result.code).toBe(0);
  expect(result.output).toContain("4 passed, 0 failed");
  expect(records(box)).toHaveLength(4);
});

test("a fixture ignoring TERM is killed at the escalation deadline and still counts as failed", () => {
  const box = sandbox();
  const result = invoke(box, selection(box).concat(["hello"]), { HANG: "1", IGNORE_TERM: "1", SHORT_TIMEOUT: "1" });
  expect(result.code).toBe(1);
  expect(result.output).toContain("expected 0");
  expect(result.output).toContain("0 passed, 1 failed");
  expect(() => process.kill(records(box)[0]!.pid, 0)).toThrow();
});

type SpecializedFixtureBox = ReturnType<typeof specializedFixtureSandbox>;

function specializedFixtureSandbox() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-specialized-fixtures-"));
  roots.push(root);
  const launcher = join(root, "launcher.js");
  const core = join(root, "core.wasm");
  const side = join(root, "spidermonkey-engine.wasm");
  const shell = join(root, "shell.wasm");
  const envUtility = join(root, "env.wasm");
  const record = join(root, "launcher-record.jsonl");
  for (const path of [core, side, shell, envUtility]) writeFileSync(path, "synthetic bytes, never executed as Wasm\n");
  put(launcher, `#!${process.execPath}
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, appendFileSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const recordArgv = argv.map((value, index) => index === argv.indexOf("-e") + 1 ? "<eval>" : value);
appendFileSync(process.env.RECORD, JSON.stringify({ argv: recordArgv, tier: process.env.BUN_WASM_SPIDERMONKEY_TIER }) + "\\n");
const directoryArg = argv[argv.indexOf("--dir") + 1] ?? "";
const directory = directoryArg.split("::", 1)[0];
const lifecycle = argv.some(value => value.endsWith("http-response-lifecycle/index.ts"));
if (lifecycle) {
  const events = {
    producers: 0,
    closed: ["/before", "/headers", "/twice", "/late-end", "/output-error", "/cancel"].map(path => ({ path, finished: false, destroyed: true }))
      .concat([{ path: "/half-close-promise", finished: true, destroyed: true }, { path: "/half-close-timer", finished: false, destroyed: true }]),
    errors: [{ message: "deliberate output error", code: null }],
  };
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/ok") { response.end("alive"); return; }
    if (path === "/events") { response.end(JSON.stringify(events)); return; }
    if (path === "/half-close-promise") { response.end("complete"); return; }
    if (path === "/half-close-timer") { request.socket.destroy(); return; }
    if (path === "/cancel") { response.write("first"); return; }
    request.socket.destroy();
  });
  const port = Number((argv.find(value => value.startsWith("PORT=")) ?? "PORT=0").slice(5));
  server.listen(port, "127.0.0.1", () => process.stdout.write("HTTP_LIFECYCLE_READY\\n"));
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
  process.on("SIGINT", () => server.close(() => process.exit(130)));
  setInterval(() => {}, 1 << 30);
} else {
const evalIndex = argv.indexOf("-e");
if (evalIndex >= 0) {
  const code = argv[evalIndex + 1] ?? "";
  if (code.includes("clone transfer attached")) { process.stdout.write("clone transfer attached\\n"); process.exit(0); }
  execFileSync(process.execPath, ["-e", code], { stdio: "inherit" });
  process.exit(0);
}
if (argv.includes("/large.js")) {
  const fd = argv.at(-1) === "1" ? 1 : 2;
  const chunk = Buffer.alloc(65536, "x");
  let remaining = 8 * 1024 * 1024;
  while (remaining > 0) {
    const written = writeSync(fd, chunk, 0, Math.min(chunk.length, remaining));
    remaining -= written;
  }
  process.exit(0);
}
if (argv.includes("/index.ts") && directory.includes("stdout-busy-loop")) {
  process.stdout.write("ready\\n");
  while (!existsSync(join(directory, "ack"))) {}
  process.stdout.write(readFileSync(join(directory, "expected.txt"), "utf8").replace(/^ready\\n/, ""));
  process.exit(0);
}
if (argv.includes("/index.mjs")) {
  process.stdout.write(readFileSync(join(process.env.SOURCE_ROOT, "tests/fixtures/fs-writev-partial/expected.txt"), "utf8"));
  process.exit(0);
}
const numericIndex = argv.findLastIndex(value => value === "1" || value === "2");
if (numericIndex >= 0 && (argv.includes("/index.js") || argv.includes("/callback.ts"))) {
  const fd = argv[numericIndex];
  const handled = argv.includes("handled");
  const stream = fd === "1" ? process.stdout : process.stderr;
  stream.write("x");
  if (fd === "1" && !handled) process.stderr.write("EPIPE");
  process.exit(handled ? 42 : 1);
}
process.stdout.write(readFileSync(join(directory, "expected.txt"), "utf8"));
}
`, true);
  return { root, launcher, core, side, shell, envUtility, record };
}

function specializedEnvironment(box: SpecializedFixtureBox) {
  return {
    ...process.env,
    BUN_WASM_LAUNCHER: box.launcher,
    BUN_WASM_SHELL: box.shell,
    BUN_WASM_ENV_UTILITY: box.envUtility,
    BUN_WASM_SPIDERMONKEY_TIER: "ambient-must-not-win",
    BUN_WASM_SCRATCH_ROOT: box.root,
    RECORD: box.record,
    SOURCE_ROOT: source,
  };
}

function runSpecializedHarness(box: SpecializedFixtureBox, tier: "interp" | "pbl", command: string[]) {
  writeFileSync(box.record, "");
  const result = Bun.spawnSync(command, {
    cwd: source,
    env: { ...specializedEnvironment(box), BUN_WASM_SPIDERMONKEY_TIER: "ambient-must-not-win" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
  });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")}\nstdout: ${result.stdout.toString()}\nstderr: ${result.stderr.toString()}\nrecords: ${existsSync(box.record) ? readFileSync(box.record, "utf8") : "<none>"}`);
  expect(result.stderr.toString()).toBe("");
  const records = readFileSync(box.record, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as { argv: string[]; tier: string });
  expect(records.length).toBeGreaterThan(0);
  expect(records.every(record => record.tier === tier)).toBe(true);
  expect(records.every(record => record.argv.includes("--engine") && record.argv.includes(`spidermonkey=${box.core}`))).toBe(true);
  expect(records.every(record => record.argv.includes("--shell") && record.argv.includes(box.shell))).toBe(true);
  expect(records.every(record => record.argv.includes("--env-utility") && record.argv.includes(box.envUtility))).toBe(true);
  expect(records.every(record => record.argv.includes(`BUN_WASM_SPIDERMONKEY_TIER=${tier}`))).toBe(true);
  return { output: result.stdout.toString(), records };
}

test("specialized SpiderMonkey harnesses pass explicit core, side layout, launcher inputs, and isolated guest tiers", () => {
  for (const tier of ["interp", "pbl"] as const) {
    const box = specializedFixtureSandbox();
    expect(existsSync(box.side)).toBe(true);
    const common = ["--engine", "spidermonkey", "--wasm", box.core, "--tier", tier];
    const lifecycle = runSpecializedHarness(box, tier, ["bun", "scripts/http-response-lifecycle.ts", "spidermonkey", join(box.root, "lifecycle"), "--wasm", box.core, "--tier", tier]);
    expect(lifecycle.output).toContain("PASS spidermonkey");
    const worker = runSpecializedHarness(box, tier, ["node", "tests/check-worker-regressions.ts"].concat(common, ["--case", "clone-atomic-transfer"]));
    expect(worker.output).toContain("1/1 worker regressions passed");
    const empty = runSpecializedHarness(box, tier, ["python3", "tests/test-empty-stdin.py"].concat(common));
    expect(empty.output).toContain("PASS spidermonkey");
    const busy = runSpecializedHarness(box, tier, ["node", "--no-warnings", "tests/test-stdout-busy-loop.ts"].concat(common));
    expect(busy.output).toContain("PASS spidermonkey");
    const writev = runSpecializedHarness(box, tier, ["python3", "tests/test-writev-partial.py"].concat(common));
    expect(writev.output).toContain("PASS fs-writev-partial spidermonkey");
    const closed = runSpecializedHarness(box, tier, ["python3", "tests/test-closed-output.py"].concat(common, ["--host", "native", "--large-only"]));
    expect(closed.output).toContain("PASS pipe-closed-output spidermonkey/native");
  }
});


test("worker review CLI keeps supported-engine defaults and honors explicit overrides", () => {
  const script = readFileSync(join(source, "tests/check-worker-regressions.ts"), "utf8");
  const setup = script.slice(script.indexOf("const args ="), script.indexOf("const root ="));
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(setup);
  const invoke = new Function("process", "resolve", `${javascript}; return { engine, host, artifact };`);
  const cases: readonly (readonly [string, string])[] = [["quickjs", "bun.wasm"], ["jsc", "bun-jsc.wasm"], ["browser", "bun-browser.wasm"]];
  for (const [engine, file] of cases) {
    expect(invoke({ argv: ["node", "script", "--engine", engine] }, resolve).artifact).toBe(resolve("dist", file));
    expect(invoke({ argv: ["node", "script", "--engine", engine, "--wasm", "custom path.wasm"] }, resolve).artifact).toBe(resolve("custom path.wasm"));
  }
  expect(() => invoke({ argv: ["node", "script", "--engine", "spidermonkey", "--tier", "pbl"] }, resolve)).toThrow("explicit --wasm");
});
