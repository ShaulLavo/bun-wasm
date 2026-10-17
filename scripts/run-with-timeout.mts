// Portable test command deadline; no GNU coreutils dependency on macOS.
import { spawnSync } from "node:child_process";

const [seconds, command, ...args] = process.argv.slice(2);
const timeout = Number(seconds) * 1000;
if (!command || !Number.isFinite(timeout) || timeout <= 0) {
  throw new Error("Usage: run-with-timeout.mts <seconds> <command> [args...]");
}
const result = spawnSync(command, args, { stdio: "inherit", timeout, killSignal: "SIGKILL" });
if (result.error) {
  console.error(result.error.message);
  process.exitCode = "code" in result.error && result.error.code === "ETIMEDOUT" ? 124 : 1;
} else {
  process.exitCode = result.status ?? 1;
}
