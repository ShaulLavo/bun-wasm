// Runs every row (or those named on the command line) in its own fresh guest process, gates stdin
// bytes on the row's markers, and writes io-resource-context.result.json beside this file.
// scripts/io-resource-context.ts evaluates the result; this file asserts nothing about frames.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isRowId, RESULT_FILE, rowIds, rows, STDIN_MARKERS, type Row, type RowId, type StdinGate } from "./rows.ts";
import { parseRowOutput } from "./protocol.ts";

const ROW_TIMEOUT_MS = Number(process.env.IORC_ROW_TIMEOUT_MS ?? 30_000);
const directory = dirname(fileURLToPath(import.meta.url));
const rowScript = join(directory, "row.ts");
type Child = Bun.Subprocess<"pipe", "pipe", "pipe">;

function markerSeen(output: string, index: number): boolean {
  return output.split("\n").includes(STDIN_MARKERS[index] ?? "");
}

async function closeStdin(child: Child): Promise<string | null> {
  try {
    await child.stdin.end();
    return null;
  } catch (error) {
    return String(error);
  }
}

async function feed(child: Child, gate: StdinGate, output: string, next: number): Promise<number> {
  while (next < gate.inputs.length && markerSeen(output, next)) {
    child.stdin.write(gate.inputs[next]!);
    await child.stdin.flush();
    next++;
    if (next === gate.inputs.length && gate.close === "after-inputs") await closeStdin(child);
  }
  return next;
}

async function readOutput(child: Child, gate: StdinGate | undefined): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let next = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return output + decoder.decode();
    output += decoder.decode(chunk.value, { stream: true });
    if (gate) next = await feed(child, gate, output, next);
  }
}

async function runRow(id: RowId) {
  const row: Row = rows[id];
  const gate = row.stdin;
  const started = Date.now();
  const child: Child = Bun.spawn([process.execPath, rowScript, id], { cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, ROW_TIMEOUT_MS);
  if (!gate) await closeStdin(child);
  const [output, stderr] = await Promise.all([readOutput(child, gate), new Response(child.stderr).text()]);
  const exitCode = await child.exited;
  clearTimeout(timer);
  const stdinCloseError = gate?.close === "after-exit" ? await closeStdin(child) : null;
  try {
    return { id, exitCode, signal: child.signalCode, timedOut, elapsedMs: Date.now() - started, report: parseRowOutput(output, id), stdinCloseError, stderr: stderr.slice(-4000) };
  } catch (error) {
    return { id, exitCode, timedOut, report: null, stderr: `${stderr.slice(-4000)}\n${String(error)}` };
  }
}

const requested = process.argv.slice(2);
for (const name of requested) if (!isRowId(name)) throw new Error(`unknown io-resource-context row: ${name}`);
if (new Set(requested).size !== requested.length) throw new Error("duplicate requested row");
const selected = requested.length ? requested.filter(isRowId) : rowIds;
const results = [];
for (const id of selected) {
  const result = await runRow(id);
  console.log(`IORC ${JSON.stringify(result)}`);
  results.push(result);
}
writeFileSync(join(directory, RESULT_FILE), JSON.stringify({ execPath: process.execPath, rows: results }, null, 2));
console.log(`IORC_DONE ${results.length}`);
