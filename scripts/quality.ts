import { spawn } from "node:child_process";
import { constants } from "node:os";
import { run } from "./quality-command";

const staticJavascript = ["lint", "types", "unused", "duplicates", "structure"] as const;
const gates = {
  javascript: ["lint", "types", "unused", "duplicates", "structure", "probes"],
  native: ["rust", "wasi"],
};

export function qualityGates(args: readonly string[]): string[] {
  if (args.length === 0) return gates.javascript.concat(gates.native);
  if (args.length !== 1) throw new Error("Usage: quality [--javascript | --native]");
  if (args[0] === "--javascript") return gates.javascript;
  if (args[0] === "--native") return gates.native;
  throw new Error("Usage: quality [--javascript | --native]");
}

function bufferedClose(command: readonly string[], chunks: Buffer[], status: number | null, signal: NodeJS.Signals | null) {
  const output = signal ? Buffer.concat(chunks.concat([Buffer.from(`\n[${command[0]!} terminated by ${signal}]\n`)])) : Buffer.concat(chunks);
  return { command, status: signal ? 128 + (constants.signals[signal] ?? 1) : (status ?? 1), signal, output };
}

function runBuffered(command: readonly string[]): Promise<{ command: readonly string[]; status: number; signal: NodeJS.Signals | null; output: Buffer }> {
  const [executable, ...args] = command;
  if (!executable) throw new Error("Missing quality command");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve(bufferedClose(command, chunks, status, signal)));
  });
}

async function runStaticJavascript(): Promise<void> {
  const results = await Promise.all(staticJavascript.map(gate => runBuffered(["bun", "run", `quality:${gate}`])));
  for (const result of results) {
    console.log(`\n> ${result.command.join(" ")}`);
    process.stdout.write(result.output);
  }
  const failure = results.find(result => result.status !== 0);
  if (failure) throw new Error(`${failure.command[0]} failed: ${failure.signal ?? failure.status}`);
}

if (import.meta.main) {
  const selected = qualityGates(process.argv.slice(2));
  const hasStatic = staticJavascript.every(gate => selected.includes(gate));
  if (hasStatic) await runStaticJavascript();
  const rest = hasStatic ? selected.filter(gate => !(staticJavascript as readonly string[]).includes(gate)) : selected;
  for (const gate of rest) run(["bun", "run", `quality:${gate}`]);
}
