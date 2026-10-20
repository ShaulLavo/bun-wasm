import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const [mode, scratch] = process.argv.slice(2);
if (!scratch) throw new Error("missing fixture directory");
writeFileSync(join(scratch, `${mode}.pid`), String(process.pid));
function supervisorState(pid: string, birth: string): string | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[19] !== birth) throw new Error("supervisor identity changed");
  return fields[0];
}
async function pauseSupervisor(directory: string) {
  const identity = join(directory, "supervisor.identity");
  const until = performance.now() + 5000;
  while (!existsSync(identity)) {
    if (performance.now() >= until) throw new Error("supervisor identity missing");
    await delay(5);
  }
  const [pid, birth] = readFileSync(identity, "utf8").split(" ");
  if (!pid || !birth || Number(pid) !== process.ppid) throw new Error("supervisor identity changed");
  supervisorState(pid, birth);
  process.kill(Number(pid), "SIGSTOP");
  while (supervisorState(pid, birth) !== "T") {
    if (performance.now() >= until) throw new Error("supervisor did not stop");
    await delay(5);
  }
}
if (mode === "quick-launcher") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(scratch, "detached.pid"), String(child.pid));
  process.exit(7);
} else if (mode === "launcher") {
  spawn(process.execPath, [import.meta.filename, "worker", scratch], { stdio: "inherit" });
} else if (mode === "worker") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  writeFileSync(join(scratch, "detached.pid"), String(child.pid));
  process.on("SIGTERM", () => setTimeout(() => {
    writeFileSync(join(scratch, "grace-complete"), "complete");
    process.exit(0);
  }, 200));
} else if (mode === "browser" || mode === "failed-browser" || mode === "control-browser") {
  const missed = mode === "failed-browser" && process.platform === "linux";
  if (missed) await pauseSupervisor(scratch);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !missed || !key.startsWith("BUN_WASM_DEADLINE_")));
  const browser = await chromium.launchServer({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, env });
  const pid = browser.process().pid;
  if (pid === undefined) throw new Error("browser PID missing");
  writeFileSync(join(scratch, "browser.pid"), String(pid));
  if (mode !== "control-browser") process.kill(-pid, "SIGSTOP");
  process.on("SIGTERM", () => {});
  writeFileSync(join(scratch, "ready"), "ready");
  if (mode === "failed-browser") process.kill(process.pid, "SIGKILL");
}
setInterval(() => {}, 1000);
