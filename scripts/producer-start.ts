import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import process from "node:process";

const usage = "Usage: node scripts/producer-start.ts --report-root /new/report -- /absolute/command [args...]";

function main(): void {
  const [option, report, separator, command, ...args] = process.argv.slice(2);
  if (option === "--help" && process.argv.length === 3) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (option !== "--report-root" || !report || !isAbsolute(report) || separator !== "--" || !command || !isAbsolute(command)) throw new Error(usage);
  if (typeof process.execve !== "function") throw new Error("Use Node.js 24 or later on a POSIX host with process.execve");

  // This exclusive claim must precede every preparation import, write and command.
  mkdirSync(report, { mode: 0o700 });
  // Keep the claim on every outcome. There is no refusal/failure cleanup to touch evidence.
  process.execve(command, [command].concat(args), { ...process.env, BUN_WASM_PRODUCER_REPORT_ROOT: report });
}

try {
  main();
} catch (error) {
  process.stderr.write(`Producer start refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
