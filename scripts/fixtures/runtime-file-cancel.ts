import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const root = process.argv[2];
assert(root);
const signal = process.argv[3];
assert(signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP");
const child = spawn(process.execPath, [join(root, "scripts/test-checks.ts"), "runtime"], {
  env: { ...process.env, BUN_WASM_RUNTIME_JOBS: "2", TMPDIR: join(root, "tmp"), EVENTS: join(root, "events"), CANCEL: "1" },
  stdio: "inherit",
});
const exited = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
try {
  while (!existsSync(join(root, "events/a.descendant")) || !existsSync(join(root, "events/b.descendant"))) await delay(10);
  child.kill(signal);
  assert.equal(await exited, 128 + constants.signals[signal]);
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await exited;
}
