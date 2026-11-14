import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";

const evidence = process.env.SF_EVIDENCE!;
const root = process.env.SF_ROOT!;
const subject = process.env.SF_SUBJECT!;
assert(evidence && root && subject && process.env.GITHUB_ACTIONS === "true");
type Owned = { pid: number; start: string };
const text = await readFile(join(evidence, "tracked.jsonl"), "utf8").catch(() => "");
const owned: Owned[] = text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
async function live(value: Owned) {
  const text = await readFile(`/proc/${value.pid}/stat`, "utf8").catch(() => "");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return text && fields[19] === value.start && fields[0] !== "Z";
}
async function remaining() { return (await Promise.all(owned.map(async value => await live(value) ? value : null))).filter(value => value !== null); }
function signal(pid: number, name: "TERM" | "KILL") {
  try { process.kill(pid, `SIG${name}`); }
  catch { try { execFileSync("sudo", ["-n", "kill", "-" + name, String(pid)], { stdio: "ignore" }); } catch {} }
}
const before = await remaining();
for (const value of before) signal(value.pid, "TERM");
const deadline = Date.now() + 30000;
let pending = await remaining();
while (pending.length && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 100));
  pending = await remaining();
}
for (const value of pending) signal(value.pid, "KILL");
await new Promise(resolve => setTimeout(resolve, 100));
const survivors = await remaining();
const removalErrors: string[] = [];
async function remove(path: string) {
  try { await rm(path, { recursive: true, force: true }); }
  catch {
    try { execFileSync("sudo", ["-n", "rm", "-rf", "--", path], { stdio: "ignore" }); }
    catch (error) { removalErrors.push(String(error)); }
  }
}
if (!survivors.length) for (const path of [root, subject, join(process.env.RUNNER_TEMP!, "browser-apt")]) await remove(path);
await Bun.write(join(evidence, "OUTER-ACTUAL-HOST-CLEANUP.json"), JSON.stringify({ before, survivors, rootRemoved: !existsSync(root), subjectRemoved: !existsSync(subject),
  removalErrors,
  processes: execFileSync("ps", ["-eo", "pid,ppid,pgid,comm"], { encoding: "utf8" }), listeners: execFileSync("ss", ["-ltnp"], { encoding: "utf8" }) }, null, 2));
assert.equal(survivors.length, 0);
assert.equal(removalErrors.length, 0);
assert(!existsSync(root) && !existsSync(subject));
