import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const wrapper = join(import.meta.dir, "../run-with-timeout.mts");
function processIdentity(pid: number) {
  if (process.platform !== "linux") return portableSnapshot(pid).find(row => row.pid === pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, parent: Number(fields[1]), birth: fields[19], live: fields[0] !== "Z" };
  } catch { return undefined; }
}
type Identity = { pid: number; parent: number; birth: string | undefined; live: boolean };
function portableSnapshot(pid?: number): Identity[] {
  const args = pid === undefined ? ["-axo", "pid=,ppid=,lstart=,stat="] : ["-p", String(pid), "-o", "pid=,ppid=,lstart=,stat="];
  const result = spawnSync("ps", args, { encoding: "utf8", timeout: 2000 });
  if (result.error) throw result.error;
  if (!result.stdout.trim()) return [];
  return result.stdout.trim().split("\n").map(line => {
    const [pid, parent, ...fields] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), birth: fields.slice(0, 5).join(" "), live: !fields[5]?.startsWith("Z") };
  });
}
function processSnapshot() {
  if (process.platform !== "linux") return portableSnapshot();
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => processIdentity(Number(name)) ?? []);
}
function capture(scratch: string, owned: Map<number, Identity>) {
  for (const name of readdirSync(scratch).filter(name => name.endsWith(".pid"))) {
    const row = processIdentity(Number(readFileSync(join(scratch, name), "utf8")));
    if (row && !owned.has(row.pid)) owned.set(row.pid, row);
  }
  const rows = processSnapshot();
  const pending = rows.filter(row => owned.get(row.pid)?.birth === row.birth);
  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) continue;
    owned.set(row.pid, row);
    pending.push(...rows.filter(candidate => candidate.parent === row.pid && !owned.has(candidate.pid)));
  }
}
function kill(owned: Map<number, Identity>) {
  for (const row of owned.values()) {
    if (processIdentity(row.pid)?.birth !== row.birth) continue;
    try { process.kill(row.pid, "SIGKILL"); } catch {}
  }
}
function remember(pid: number, owned: Map<number, Identity>) {
  const row = processIdentity(pid);
  if (row) owned.set(pid, row);
}
function live(owned: Map<number, Identity>) {
  return Array.from(owned.values()).filter(row => {
    const current = processIdentity(row.pid);
    return current !== undefined && current.birth === row.birth && current.live;
  });
}
async function cleanupScenario(scratch: string, owned: Map<number, Identity>, controls: Map<number, Identity>) {
  capture(scratch, owned);
  const controlDirectory = join(scratch, "control");
  if (existsSync(controlDirectory)) capture(controlDirectory, controls);
  const all = new Map(Array.from(owned).concat(Array.from(controls)));
  kill(all);
  const until = performance.now() + 2000;
  while (live(all).length > 0 && performance.now() < until) await delay(25);
  expect(live(all)).toEqual([]);
  await rm(scratch, { recursive: true, force: true });
  console.info(JSON.stringify({ cleanup: "pass", scratch, removed: !existsSync(scratch), owned: Array.from(all.values()), remaining: live(all) }));
}
async function ready(directory: string) {
  const until = performance.now() + 5000;
  while (!existsSync(join(directory, "ready"))) {
    if (performance.now() >= until) throw new Error("browser fixture did not become ready");
    await delay(25);
  }
}
async function resumeAfterLauncherExit(directory: string, supervisor: number) {
  await ready(directory);
  const pid = Number(readFileSync(join(directory, "failed-browser.pid"), "utf8"));
  const launcher = processIdentity(pid);
  const until = performance.now() + 5000;
  while (processIdentity(pid)?.live && processIdentity(pid)?.birth === launcher?.birth) {
    if (performance.now() >= until) throw new Error("launcher did not exit");
    await delay(25);
  }
  process.kill(supervisor, "SIGCONT");
}
function expectedStatus(mode: string, signal: "SIGINT" | "SIGTERM" | undefined) {
  if (signal) return signal === "SIGINT" ? 130 : 143;
  if (mode === "failed-browser") return 137;
  return mode === "quick-launcher" ? 7 : 124;
}
export async function ownedScenario(mode: "launcher" | "browser" | "quick-launcher" | "failed-browser", runtime: "node" | "bun" = "node", signal?: "SIGINT" | "SIGTERM") {
  const scratch = await mkdtemp(join(existsSync("/work/tmp") ? "/work/tmp" : tmpdir(), "bw-dl-"));
  const controlDirectory = join(scratch, "control");
  const owned = new Map<number, Identity>(), controls = new Map<number, Identity>();
  let cleanupPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    clearInterval(timer);
    return cleanupPromise ??= cleanupScenario(scratch, owned, controls);
  };
  const interrupted = () => { void cleanup().finally(() => process.exit(143)); };
  process.on("SIGTERM", interrupted);
  process.on("SIGINT", interrupted);
  try {
    await mkdir(controlDirectory);
    const fixture = fileURLToPath(new URL("../../web/tests/fixtures/deadline-owner.ts", import.meta.url));
    const browser = mode === "browser" || mode === "failed-browser";
    const controlArgs = browser ? [fixture, "control-browser", controlDirectory] : ["-e", "setInterval(() => {}, 1000)"];
    const control = Bun.spawn(["node"].concat(controlArgs), { stdout: "ignore", stderr: "ignore", env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch } });
    remember(control.pid, controls);
    timer = setInterval(() => { capture(scratch, owned); capture(controlDirectory, controls); }, 25);
    if (browser) await ready(controlDirectory);
    const deadline = !signal && mode !== "failed-browser" && mode !== "quick-launcher";
    const seconds = deadline ? mode === "browser" ? "3" : "1" : "30";
    const began = performance.now();
    const child = Bun.spawn([runtime, wrapper, seconds, "node", fixture, mode, scratch], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    });
    remember(child.pid, owned);
    if (mode === "failed-browser" && process.platform === "linux") await resumeAfterLauncherExit(scratch, child.pid);
    if (signal) { await ready(scratch); child.kill(signal); }
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    capture(scratch, owned);
    expect(code).toBe(expectedStatus(mode, signal));
    expect(deadline ? stderr.includes("command deadline exceeded") : stderr === "").toBe(true);
    expect(processIdentity(control.pid)?.live).toBe(true);
    if (browser) expect(processIdentity(Number(readFileSync(join(controlDirectory, "browser.pid"), "utf8")))?.live).toBe(true);
    if (mode === "launcher") expect(readFileSync(join(scratch, "grace-complete"), "utf8")).toBe("complete");
    const remaining = live(owned);
    console.info(JSON.stringify({ mode, runtime, signal, code, elapsedMs: performance.now() - began, remaining, scratch, unrelated: live(controls) }));
    expect(remaining).toEqual([]);
  } finally {
    await cleanup();
    process.off("SIGTERM", interrupted);
    process.off("SIGINT", interrupted);
  }
}
