import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile, readlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { bounded } from "../goals-matrix/bounded";
import type { Bracket } from "./lifecycle-model";

async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const kill = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
  };
  kill("SIGTERM");
  await Bun.sleep(100);
  kill("SIGKILL");
}
export function launchProcess(command: string[], cwd: string, env: NodeJS.ProcessEnv, output: string) {
  const stdout = createWriteStream(join(output, "stdout.txt"), { flags: "wx" });
  const stderr = createWriteStream(join(output, "stderr.txt"), { flags: "wx" });
  const child = spawn(command[0]!, command.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.pipe(stdout); child.stderr?.pipe(stderr);
  const observation: { exit: Bracket | null } = { exit: null };
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      observation.exit = { beforeMs: performance.now(), afterMs: performance.now() };
      if (code === null) reject(new Error("Process terminated by signal"));
      else resolve(code);
    });
  });
  void exited.catch(() => {});
  const filesClosed = Promise.all([stdout, stderr].map(stream => new Promise<void>((resolve, reject) => {
    stream.once("finish", resolve); stream.once("error", reject);
  })));
  void filesClosed.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await stopGroup(child); await bounded(() => filesClosed, 5000); })();
  return { child, exited, observation, close };
}
export async function processIdentity(pid: number | undefined) {
  if (pid === undefined) return { available: false, reason: "process not spawned" };
  try {
    const [executable, cmdline, status, stat] = await Promise.all([readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/status`, "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
    return { available: true, pid, executable, argv: cmdline.split("\0").filter(Boolean), processStartTicks: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null, allowedCPUs: /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1] ?? null };
  } catch (error) { return { available: false, pid, reason: String(error) }; }
}
export async function processTree(root: number) {
  const beforeMs = performance.now();
  const found = new Set([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const children = await processChildren(queue[index]!);
    for (const pid of children) { if (!found.has(pid)) { found.add(pid); queue.push(pid); } }
  }
  const processes = await Promise.all(queue.map(processIdentity));
  return { beforeMs, afterMs: performance.now(), processes, coverage: "Point-in-time /proc discovery; short-lived children and disappearing entries can be missed" };
}
async function processChildren(pid: number): Promise<number[]> {
  const tids = await readdir(`/proc/${pid}/task`).catch(() => []);
  const rows = await Promise.all(tids.map(tid => readFile(`/proc/${pid}/task/${tid}/children`, "utf8").catch(() => "")));
  return rows.flatMap(row => row.trim().split(/\s+/).filter(Boolean).map(Number));
}
export async function cpuTopology() {
  const read = async (path: string) => readFile(path, "utf8").then(value => ({ value: value.trim(), reason: null })).catch(error => ({ value: null, reason: String(error) }));
  const online = await read("/sys/devices/system/cpu/online");
  const groups = await Promise.all(["cpu_core", "cpu_atom"].map(async pmu => ({ pmu, cpus: await read(`/sys/bus/event_source/devices/${pmu}/cpus`) })));
  const names = (await readdir("/sys/devices/system/cpu")).filter(name => /^cpu\d+$/.test(name));
  const cores = await Promise.all(names.map(async cpu => ({ cpu, package: await read(`/sys/devices/system/cpu/${cpu}/topology/physical_package_id`),
    core: await read(`/sys/devices/system/cpu/${cpu}/topology/core_id`), siblings: await read(`/sys/devices/system/cpu/${cpu}/topology/thread_siblings_list`) })));
  return { online, groups, cores, method: "Live Linux sysfs topology; affinity remains inherited, no counter PMU inference" };
}
