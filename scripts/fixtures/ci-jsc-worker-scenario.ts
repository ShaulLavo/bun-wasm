import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [scenario = "", scratch = ""] = process.argv.slice(2);
assert(scenario && scratch);
const root = resolve(import.meta.dir, "../..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
function step(name: string): string {
  const section = workflow.split(`      - name: ${name}\n`)[1]?.split(/\n      - /)[0];
  assert(section, `missing step ${name}`);
  const script = section.split("        run: |\n")[1] ?? section.split("        run: ")[1];
  assert(script, `missing script ${name}`);
  return script.split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}
function run(name: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn("bash", ["-e", "-o", "pipefail", "-c", step(name)], { cwd: scratch, env: { ...process.env, ...env, RUNNER_TEMP: scratch }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  return Object.assign(result, { child });
}
async function until(check: () => boolean, reason: string) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, reason);
    await delay(10);
  }
}
function identity(pid: number) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)?.split(" ");
    assert(fields);
    return { pid, parent: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), birth: fields[19], state: fields[0] };
  } catch { return undefined; }
}
function buildPids(): number[] {
  return ["build.pid", "child.pid", "detached.pid"].filter(name => existsSync(join(scratch, name))).map(name => Number(readFileSync(join(scratch, name), "utf8")));
}
function assertStopped(pids: number[]) {
  for (const pid of pids) assert(!identity(pid) || identity(pid)?.state === "Z", `owned process ${pid} survived`);
}
async function prepare() {
  mkdirSync(join(scratch, "scripts"));
  writeFileSync(join(scratch, "env.sh"), 'export CARGO_TARGET_DIR="$RUNNER_TEMP/target"\n');
  writeFileSync(join(scratch, "scripts/build-bun-jsc.sh"), `${scenario === "early-failure" ? "echo early-build-failure; exit 7\n" : ""}echo "$$" > "$RUNNER_TEMP/build.pid"
echo build >> "$RUNNER_TEMP/invocations"
sleep 60 &
echo "$!" > "$RUNNER_TEMP/child.pid"
setsid bash -c '${scenario === "stubborn-descendant" ? 'trap "" TERM; ' : ""}echo "$$" > "$RUNNER_TEMP/detached.pid"; exec sleep 60' &
while [[ ! -f "$RUNNER_TEMP/release" ]]; do sleep 0.01; done
exit "${scenario === "build-failure" ? 7 : 0}"
`);
  for (const file of ["ci-jsc-worker.ts", "run-with-timeout.mts", "linux-subreaper.mts"]) {
    const source = readFileSync(join(root, "scripts", file), "utf8");
    writeFileSync(join(scratch, "scripts", file), source);
  }
}
async function startupRace() {
  const preload = join(scratch, "startup.ts");
  writeFileSync(preload, `import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
if (process.argv.includes("--state")) {
  writeFileSync(${JSON.stringify(join(scratch, "paused"))}, String(process.pid));
  while (!existsSync(${JSON.stringify(join(scratch, "resume"))})) await delay(10);
}
`);
  const starting = run("Start the JSC Cargo guest build", { NODE_OPTIONS: `--import=${preload}` });
  await until(() => existsSync(join(scratch, "paused")), "worker did not reach the fork-to-registration barrier");
  assert(!existsSync(join(scratch, "jsc-guest/identity.json")));
  const stopping = run("Stop the JSC Cargo guest build");
  await until(() => existsSync(join(scratch, "jsc-guest/stop")), "cleanup did not record stop before registration");
  starting.child.kill("SIGTERM");
  writeFileSync(join(scratch, "resume"), "resume");
  assert.equal((await stopping).code, 0);
  await starting;
  const pid = Number(readFileSync(join(scratch, "paused"), "utf8"));
  await until(() => !identity(pid) || identity(pid)?.state === "Z", "startup supervisor survived cleanup");
  console.info(JSON.stringify({ scenario, pausedSupervisor: pid, buildStarted: false }));
  assert(!existsSync(join(scratch, "invocations")), "build started after cleanup requested stop");
}
async function stalePid() {
  const unrelated = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  assert(unrelated.pid);
  try {
    const state = join(scratch, "jsc-guest");
    mkdirSync(state);
    writeFileSync(join(state, "pid"), String(unrelated.pid));
    writeFileSync(join(state, "identity.json"), JSON.stringify({ ...identity(unrelated.pid), birth: "0" }));
    const waiting = await run("Build the JSC Cargo guest");
    assert.notEqual(waiting.code, 0);
    assert.match(waiting.stderr, /identity|supervisor/);
    assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
    const remaining = identity(unrelated.pid);
    assert(remaining && remaining.state !== "Z", "unrelated process was signaled");
    console.info(JSON.stringify({ scenario, unrelatedAfterWaitAndStop: remaining }));
    assert.equal(unrelated.exitCode, null);
  } finally {
    unrelated.kill("SIGTERM");
    await new Promise(resolve => unrelated.once("exit", resolve));
  }
}
async function ordinary() {
  assert.equal((await run("Start the JSC Cargo guest build")).code, 0);
  if (scenario === "early-failure") {
    const waiting = await run("Build the JSC Cargo guest");
    assert.equal(waiting.code, 7);
    assert.match(waiting.stdout, /early-build-failure/);
    assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
    return;
  }
  await until(() => buildPids().length === 3, "build and descendants did not start");
  const pids = buildPids();
  assert(!existsSync(join(scratch, "jsc-guest/status")), "launcher blocked instead of overlapping later work");
  assert.equal(readFileSync(join(scratch, "invocations"), "utf8"), "build\n");
  const recorded: unknown = JSON.parse(readFileSync(join(scratch, "jsc-guest/identity.json"), "utf8"));
  assert(typeof recorded === "object" && recorded !== null && "pid" in recorded && typeof recorded.pid === "number");
  console.info(JSON.stringify({ scenario, supervisor: recorded, ownedPids: pids }));
  const current = identity(recorded.pid);
  assert(current && current.session === current.pid && current.group === current.pid);
  if (scenario === "cancellation") process.kill(current.pid, "SIGTERM");
  if (scenario === "cancellation-int") process.kill(current.pid, "SIGINT");
  if (scenario === "intervening-failure" || scenario === "cancellation" || scenario === "cancellation-int") {
    assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
    assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
    assert.equal(Number(readFileSync(join(scratch, "jsc-guest/status"), "utf8")), scenario === "cancellation-int" ? 130 : 143);
    assertStopped(pids);
    return;
  }
  writeFileSync(join(scratch, "release"), "release");
  const waiting = await run("Build the JSC Cargo guest");
  assert.equal(waiting.code, scenario === "build-failure" ? 7 : 0);
  assert.match(waiting.stdout, /JSC guest build took/);
  assertStopped(pids);
  assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
}
assert.match(workflow, /name: Stop the JSC Cargo guest build\n\s+if: \$\{\{ always\(\) &&/);
await prepare();
if (scenario === "startup-race") await startupRace();
else if (scenario === "stale-pid") await stalePid();
else if (scenario === "never-started") {
  assert.equal((await run("Stop the JSC Cargo guest build")).code, 0);
  assert(!existsSync(join(scratch, "jsc-guest")));
}
else await ordinary();
console.info(`${scenario}: passed`);
