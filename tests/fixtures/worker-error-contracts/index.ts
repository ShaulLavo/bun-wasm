// Errors a worker reports to its parent: Node's and Bun's codes and constructors.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const directory = process.cwd();
writeFileSync(join(directory, "bad-syntax.js"), "var foo bar;\n");

function outcome(label: string, worker: Worker) {
  return new Promise<void>(resolve => {
    worker.on("error", error => {
      const { constructor, name, code, message } = error as Error & { code?: string };
      console.log(label, JSON.stringify([constructor.name, name, code ?? null, message.replace(join(directory, "x").slice(0, -1), "<dir>/")]));
    });
    worker.on("message", message => console.log(label, "message", JSON.stringify(message)));
    worker.on("exit", code => {
      console.log(label, "exit", code);
      resolve();
    });
  });
}

await outcome("missing entry", new Worker(join(directory, "does-not-exist.js")));
await outcome("syntax error", new Worker(join(directory, "bad-syntax.js")));
await outcome("trace_events", new Worker("require('trace_events')", { eval: true }));
await outcome("execve", new Worker(`
  const { parentPort } = require("node:worker_threads");
  try { process.execve(process.execPath, []); } catch (e) { parentPort.postMessage([e.constructor.name, e.code, e.message]); }
`, { eval: true }));

// The main thread follows Bun's contract for a platform that cannot replace the process
// image, and Node's for a build without tracing. Native Bun would really exec here.
for (const [label, run] of [
  ["main execve", () => process.execve(process.execPath, [])],
  ["main trace_events", () => require("node:trace_events")],
] as const) {
  try {
    run();
  } catch (error) {
    const { constructor, code, message } = error as Error & { code?: string };
    console.log(label, JSON.stringify([constructor.name, code, message]));
  }
}
