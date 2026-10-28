import { appendFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const [mode, scenario, file] = process.argv.slice(2);
if (!scenario || !file) throw new Error("Expected mode, scenario and heartbeat path");
if (mode === "worker") {
  appendFileSync(file, "start\n");
  setInterval(() => appendFileSync(file, "tick\n"), 10);
} else if (mode === "parent") {
  const start = () => new Worker(new URL(import.meta.url), { argv: ["worker", scenario, file] });
  if (scenario === "throw") process.on("exit", () => { throw new Error("exit listener failure"); });
  const worker = start();
  worker.once("online", () => setTimeout(() => process.exit(0), 100));
  if (scenario === "late") process.on("exit", () => { start().unref(); });
} else {
  throw new Error(`Unknown worker exit fixture mode: ${mode}`);
}
