import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSubreaper } from "../test-subreaper.ts";
import { ProcessOwner, linuxProcess } from "../process-owner.mts";
import { StageFailed, UnsafeDrain, runOwned } from "./process.ts";

const quick = { graceMs: 300, forceMs: 3000 };
let scratch = "";
let restoreSubreaper = () => {};
beforeAll(async () => {
  restoreSubreaper = await testSubreaper(true);
  scratch = mkdtempSync(join(tmpdir(), "bun-wasm-c1-process-"));
});
afterAll(() => {
  try { rmSync(scratch, { recursive: true, force: true }); }
  finally { restoreSubreaper(); }
});

const bun = process.execPath;
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
/** A descendant that ignores TERM, writes its pid, and lives until killed. */
const stubborn = (pidFile: string) => `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
/** Starts the stubborn descendant detached in its own session, then exits at once. */
const escaping = (pidFile: string) => `const { spawn } = require("node:child_process"); const fs = require("node:fs");
spawn(${JSON.stringify(bun)}, ["-e", ${JSON.stringify(stubborn(pidFile))}], { detached: true, stdio: "ignore" }).unref();
const until = Date.now() + 5000; while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < until) {}
process.exit(0);`;
function alive(pid: number): boolean {
  const row = linuxProcess(pid);
  return row !== undefined && row.state !== "Z";
}
function pidFrom(path: string): number { return Number(readFileSync(path, "utf8")); }
async function waitFor(path: string): Promise<void> {
  for (let tries = 0; tries < 200 && !existsSync(path); tries++) await Bun.sleep(25);
}

test("an ordinary command succeeds and a failing one reports its status", async () => {
  await runOwned(new ProcessOwner(), { argv: [bun, "-e", "process.exit(0)"], cwd: scratch, env }, new AbortController().signal, quick);
  await expect(runOwned(new ProcessOwner(), { argv: [bun, "-e", "process.exit(3)"], cwd: scratch, env }, new AbortController().signal, quick)).rejects.toThrow(StageFailed);
});

test("a detached TERM-ignoring descendant of a parent that already exited is gone before success", async () => {
  const pidFile = join(scratch, "escaped.pid");
  await runOwned(new ProcessOwner(), { argv: [bun, "-e", escaping(pidFile)], cwd: scratch, env }, new AbortController().signal, quick);
  const pid = pidFrom(pidFile);
  expect(alive(pid)).toBe(false);
});

test("abort drains a TERM-ignoring command before rejecting", async () => {
  const pidFile = join(scratch, "aborted.pid");
  const abort = new AbortController();
  const running = runOwned(new ProcessOwner(), { argv: [bun, "-e", stubborn(pidFile)], cwd: scratch, env }, abort.signal, quick);
  await waitFor(pidFile);
  abort.abort(new Error("cancelled by test"));
  await expect(running).rejects.toThrow("cancelled by test");
  expect(alive(pidFrom(pidFile))).toBe(false);
});

test("a hung runner whose output an in-process step is reading stops on abort", async () => {
  const pidFile = join(scratch, "hung.pid");
  const abort = new AbortController();
  const lines: string[] = [];
  const script = `${stubborn(pidFile)} console.log("runner started");`;
  const running = runOwned(new ProcessOwner(), { argv: [bun, "-e", script], cwd: scratch, env, onLine: line => lines.push(line) }, abort.signal, quick);
  await waitFor(pidFile);
  abort.abort(new Error("matrix cancelled"));
  await expect(running).rejects.toThrow("matrix cancelled");
  expect(lines).toContain("runner started");
  expect(alive(pidFrom(pidFile))).toBe(false);
});

test("drain that cannot be proven is reported, not waited on forever", async () => {
  const pidFile = join(scratch, "unsafe.pid");
  const abort = new AbortController();
  const running = runOwned(new ProcessOwner(), { argv: [bun, "-e", stubborn(pidFile)], cwd: scratch, env }, abort.signal, { graceMs: 50, forceMs: 0 });
  await waitFor(pidFile);
  abort.abort(new Error("stop"));
  const error = await running.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(UnsafeDrain);
  const pid = pidFrom(pidFile);
  expect((error as UnsafeDrain).survivors.map(row => row.pid)).toContain(pid);
  process.kill(pid, "SIGKILL");
});

test("a reused pid with a different birth time is never signalled", async () => {
  const victim = spawn("sleep", ["30"], { stdio: "ignore" });
  const pid = victim.pid;
  if (pid === undefined) throw new Error("victim did not start");
  try {
    const helper = `import { ProcessOwner } from ${JSON.stringify(join(import.meta.dir, "../process-owner.mts"))};
const owner = new ProcessOwner();
owner.owned.set(${pid}, { pid: ${pid}, parent: 1, group: ${pid}, session: ${pid}, birth: "1", state: "S" });
owner.signal("SIGKILL");`;
    const result = spawnSync(bun, ["-e", helper], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(alive(pid)).toBe(true);
  } finally { victim.kill("SIGKILL"); }
});
