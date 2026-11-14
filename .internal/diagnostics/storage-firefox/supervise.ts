import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, cp } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const local = process.argv[2] === "local";
const subject = resolve(process.env.SF_SUBJECT ?? join(import.meta.dir, "../../.."));
const root = process.env.SF_ROOT!;
const evidence = process.env.SF_EVIDENCE!;
assert(root && evidence && root !== subject && !subject.startsWith(root + "/"));
const diagnostic = join(subject, ".internal/diagnostics/storage-firefox");
await mkdir(evidence, { recursive: true });
await mkdir(root, { recursive: true });
const write = (name: string, value: unknown) => Bun.write(join(evidence, name), JSON.stringify(value, null, 2));
type Process = { pid: number; ppid: number; pgid: number; start: string; state: string };
const tracked = new Map<number, Process>();
const groups = new Set<number>();
const commands: object[] = [];
let active: ReturnType<typeof Bun.spawn> | undefined;
let stopping: Promise<void> | undefined;
let teardownTask: Promise<void> | undefined;
async function processes() {
  const rows: Process[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const text = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    if (!text) continue;
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    rows.push({ pid: Number(name), state: fields[0]!, ppid: Number(fields[1]), pgid: Number(fields[2]), start: fields[19]! });
  }
  return rows;
}
async function discover() {
  const rows = await processes();
  const parents = new Set([process.pid].concat(rows.filter(row => tracked.get(row.pid)?.start === row.start).map(row => row.pid)));
  for (let count = 0; count < rows.length; count++) {
    const child = rows.find(row => parents.has(row.ppid) && !parents.has(row.pid));
    if (!child) break;
    parents.add(child.pid);
    if (!tracked.has(child.pid)) appendFileSync(join(evidence, "tracked.jsonl"), JSON.stringify(child) + "\n");
    tracked.set(child.pid, child);
  }
  return rows.filter(row => tracked.get(row.pid)?.start === row.start && row.state !== "Z");
}
function signal(pid: number, name: NodeJS.Signals) {
  try { process.kill(pid, name); }
  catch { if (!local) { try { execFileSync("sudo", ["-n", "kill", "-" + name.slice(3), "--", String(pid)], { stdio: "ignore" }); } catch {} } }
}
async function stop() {
  return stopping ??= (async () => {
    const live = await discover();
    for (const group of new Set(live.map(row => row.pgid))) if (groups.has(group)) signal(-group, "SIGTERM");
    for (const row of live) signal(row.pid, "SIGTERM");
    const deadline = Date.now() + 30000;
    let remaining = await discover();
    while (remaining.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      remaining = await discover();
    }
    for (const group of new Set(remaining.map(row => row.pgid))) if (groups.has(group)) signal(-group, "SIGKILL");
    for (const row of remaining) signal(row.pid, "SIGKILL");
    await Promise.race([active?.exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    await write("SUPERVISOR-JOIN.json", { tracked: Array.from(tracked.values()), remaining: await discover(), ownedGroups: Array.from(groups) });
  })();
}
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => void teardown().finally(() => process.exit(1)));
const cap = setTimeout(() => void teardown().finally(() => process.exit(124)), local ? 1200000 : 2700000);
const tracking = setInterval(() => void discover(), 500);
async function run(label: string, args: string[], cwd = subject, extra: Record<string, string> = {}) {
  const started = Date.now();
  const log = Bun.file(join(evidence, label + ".log")).writer();
  active = Bun.spawn(args, { cwd, detached: true, env: { ...process.env, ...extra }, stdout: "pipe", stderr: "pipe" });
  groups.add(active.pid);
  await discover();
  const copy = async (stream: ReadableStream<Uint8Array>) => { for await (const data of stream) { log.write(data); process.stdout.write(data); } };
  const streams = Promise.all([copy(active.stdout as ReadableStream<Uint8Array>), copy(active.stderr as ReadableStream<Uint8Array>)]);
  const code = await active.exited;
  await streams;
  await log.end();
  commands.push({ label, args, cwd, pid: active.pid, code, durationMs: Date.now() - started });
  await write("COMMANDS.json", commands);
  assert.equal(code, 0, label);
}
try {
await cp(import.meta.dir, join(evidence, "source"), { recursive: true });
await write("RESOURCES-BEFORE.json", { processes: execFileSync("ps", ["-eo", "pid,ppid,pgid,comm"], { encoding: "utf8" }),
  listeners: execFileSync("ss", ["-ltnp"], { encoding: "utf8" }), root, subject, evidence,
  creates: ["three frozen dependency trees", "two downloaded producer artifacts", "instrumented JavaScript build", "staged site", "Firefox profiles and browser", "bounded local server", "owned child process groups"], local });
  if (resolve(import.meta.dir) !== diagnostic) await cp(import.meta.dir, diagnostic, { recursive: true, errorOnExist: true });
  for (const consumer of ["", "web", "sandbox"]) await run("install-" + (consumer || "root"), [process.execPath, "install", "--frozen-lockfile"], join(subject, consumer));
  if (!local) await run("browser-deps", [process.execPath, "scripts/ci-browser-deps.ts", "firefox"], join(subject, "web"));
  if (!local) await run("browser-install", [process.execPath, join(subject, "web/node_modules/playwright/cli.js"), "install", "firefox"]);
  for (let index = 1; index <= 3; index++) await run("short-tests-" + index, [process.execPath, "test", join(diagnostic, "controls.test.ts"), join(diagnostic, "transport.test.ts"), "--timeout", "60000"]);
  await run("typecheck", [process.execPath, join(diagnostic, "typecheck.ts")]);
  await run("inputs", [process.execPath, join(diagnostic, "inputs.ts")]);
  await run("build", [process.execPath, join(diagnostic, "instrument-build.ts")]);
  await run("retain-build", [process.execPath, join(diagnostic, "retain-build.ts")]);
  await run("qualify", [process.execPath, join(diagnostic, "capture.ts"), "qualify"]);
  if (!local) await run("scenario", [process.execPath, join(diagnostic, "capture.ts"), "scenario"]);
} finally { await teardown(); }
async function teardown() {
  return teardownTask ??= (async () => {
    clearTimeout(cap); clearInterval(tracking);
    try { await stop(); }
    finally { await removeOwnedPaths(); }
  })();
}
async function removeOwnedPaths() {
  const survivors = await discover();
  if (!survivors.length) await rm(root, { recursive: true, force: true });
  const names = ["node_modules", "web/node_modules", "sandbox/node_modules", "sandbox/dist", "dist/package"];
  if (!survivors.length) for (const name of names) await rm(join(subject, name), { recursive: true, force: true });
  await write("ACTUAL-HOST-CLEANUP.json", { rootRemoved: !existsSync(root), ownedPathsAbsent: names.every(name => !existsSync(join(subject, name))),
    survivingOwnedProcesses: survivors, processes: execFileSync("ps", ["-eo", "pid,ppid,pgid,comm"], { encoding: "utf8" }), listeners: execFileSync("ss", ["-ltnp"], { encoding: "utf8" }),
    retained: "Small evidence and diagnostic source belong to Storage until goal archival. Original source checkout remains for the workflow's outer teardown." });
  assert.equal(survivors.length, 0, "owned consumers must stop before path removal");
}
