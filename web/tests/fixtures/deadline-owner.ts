import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const [mode, scratch] = process.argv.slice(2);
if (!scratch) throw new Error("missing fixture directory");
writeFileSync(join(scratch, `${mode}.pid`), String(process.pid));
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
} else if (mode === "browser") {
  const browser = await chromium.launchServer({ headless: true });
  const pid = browser.process().pid;
  if (pid === undefined) throw new Error("browser PID missing");
  writeFileSync(join(scratch, "browser.pid"), String(pid));
  process.on("SIGTERM", () => {});
  process.kill(-pid, "SIGSTOP");
}
setInterval(() => {}, 1000);
