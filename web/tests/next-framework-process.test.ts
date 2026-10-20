import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { stopProcessGroup } from "./next-framework-process";

const groups = new Set<number>();
let interrupted = false;
function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}
async function cleanup() {
  for (const pid of groups) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (error) { if (exists(-pid)) throw error; }
  }
  const until = Date.now() + 5000;
  while (Array.from(groups).some(pid => exists(-pid)) && Date.now() < until) await Bun.sleep(20);
  expect(Array.from(groups).filter(pid => exists(-pid))).toEqual([]);
  groups.clear();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { interrupted = true; void cleanup().finally(() => process.exit(130)); });
}
function start(source: string) {
  if (interrupted) throw new Error("Process controls interrupted");
  const child = spawn(process.execPath, ["-e", source], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  if (!child.pid) throw new Error("Missing group leader PID");
  groups.add(child.pid);
  process.stdout.write(JSON.stringify({ ownedGroup: child.pid }) + "\n");
  return { child, pid: child.pid };
}
async function ready(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.stdout?.once("data", data => resolve(Number(String(data))));
  });
}
async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
}
const ignoring = "process.on('SIGTERM',()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000);";
const leader = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(ignoring)}],{stdio:['ignore','pipe','ignore']});process.on('SIGTERM',()=>process.exit(0));child.stdout.once('data',data=>process.stdout.write(String(data)));setInterval(()=>{},1000);`;

async function leaderExitControl(exitFirst: boolean) {
  try {
    const unrelated = start(ignoring);
    await ready(unrelated.child);
    const { child, pid } = start(leader);
    const descendant = await ready(child);
    if (exitFirst) {
      process.kill(pid, "SIGTERM");
      await waitForExit(child);
    }
    const started = performance.now();
    await stopProcessGroup(child);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
    expect(child.exitCode).toBe(0);
    expect(exists(descendant)).toBe(false);
    expect(exists(-pid)).toBe(false);
    expect(exists(unrelated.pid)).toBe(true);
    await stopProcessGroup(child);
  } finally { await cleanup(); }
}

test("shutdown still escalates after the group leader exits on SIGTERM", () => leaderExitControl(false), 20000);
test("shutdown owns descendants when the group leader exited before cleanup", () => leaderExitControl(true), 20000);
test("shutdown escalates a single ignoring leader", async () => {
  try {
    const { child } = start(ignoring);
    await ready(child);
    await stopProcessGroup(child);
    expect(child.signalCode).toBe("SIGKILL");
  } finally { await cleanup(); }
}, 20000);
