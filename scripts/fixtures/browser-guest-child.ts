import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const [mode, path] = process.argv.slice(2);
if (!path) throw new Error("Missing fixture PID path");
if (mode === "descendant") {
  writeFileSync(path, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  spawn(process.execPath, [import.meta.filename, "descendant", path], { detached: true, stdio: "inherit" }).unref();
  const until = Date.now() + 30_000;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error("Fixture descendant never started");
    await delay(10);
  }
  console.log("complete fixture assertions");
  if (mode === "cancel") setInterval(() => {}, 1000);
  else process.exitCode = mode === "fail" ? 7 : 0;
}
